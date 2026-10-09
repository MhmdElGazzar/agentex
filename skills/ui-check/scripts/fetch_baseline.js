#!/usr/bin/env node
'use strict';
// AgenTeX ui-check baseline resolver — resolves ONE design baseline (Figma frame or
// screenshot image) into the run's evidence folder, deterministically.
//
// It resolves and validates baselines; it NEVER judges — the comparison verdict is
// agent-vision judgment (see skills/ui-check/SKILL.md). Printed results are OK or
// BLOCKED only (exit 0 / 2; FAIL is unused by design).
//
// Usage:
//   node fetch_baseline.js --source figma --id <node-id | frame URL> \
//     --out <SESSION_DIR>/screenshots/<scenario>-ui-check-baseline.png \
//     --log <SESSION_DIR>/logs/<scenario>-ui-check.log [--scale 2]
//     [--no-cache] [--cache-dir <dir>] [--cache-max-age-days <n>]
//   node fetch_baseline.js --source image --path <baseline image> --out ... --log ...
//
// Prints ONE JSON line:
//   {"result":"OK|BLOCKED","baseline":"<out>","width":W,"height":H,
//    "node":{"id","name","type"}|null,"variants":[{id,name,width,height},...],
//    "cached":false,"cachedAt":null,"fileKeyMismatch":false,"reason":null}
//
// figma source: file key + token come from config/project.json's "figma" block
// ({ "fileKey": "...", "token": { "envSecret": "FIGMA_TOKEN" } }) — a story carries
// only the node id. Render URLs from /v1/images are SHORT-LIVED: downloaded
// immediately, never stored. The token is sent as the X-Figma-Token header to the
// Figma API only — never to the render host, never printed, never logged.
//
// Figma rate-limits per token, and a parallel run is 2 calls per ui-check step: 19
// steps = 38 calls at once, which the limiter answers with 429. So 429 and 5xx are
// retried (Retry-After honoured, then exponential, plus jitter so the callers do not
// re-collide), and every successful fetch leaves a copy in the cache dir that is read
// back ONLY when the live fetch fails transiently — see "fallback baseline cache".
//
// FIGMA_API_BASE overrides the API base URL (test seam; default https://api.figma.com).
const fs = require('fs');
const path = require('path');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

// Pre-fetch exits may use process.exit; post-fetch must only set exitCode
// (forcing an exit with open undici handles crashes libuv on Windows).
function emit(obj) {
  console.log(JSON.stringify({
    result: 'BLOCKED', baseline: null, width: 0, height: 0,
    node: null, variants: [], cached: false, cachedAt: null,
    fileKeyMismatch: false, reason: null, ...obj,
  }));
}
function blocked(reason, extra) { emit({ result: 'BLOCKED', reason, ...(extra || {}) }); process.exit(2); }
function blockedAsync(reason, extra) { emit({ result: 'BLOCKED', reason, ...(extra || {}) }); process.exitCode = 2; }

// ── evidence log (request metadata only — never the token) ───────────────────
const logLines = [];
let logPath = null;
function log(line) { logLines.push(line); }
function flushLog() {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, logLines.join('\n') + '\n');
  } catch { /* evidence log failure must not mask the result */ }
}
process.on('exit', flushLog);

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let source, id, imgPath, outPath, scale;
let cacheDir = 'test/.ui-baselines', maxAgeDays = 7, noCache = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--source') source = v();
  else if (a === '--id') id = v();
  else if (a === '--path') imgPath = v();
  else if (a === '--out') outPath = v();
  else if (a === '--log') logPath = v();
  else if (a === '--scale') scale = v();
  else if (a === '--cache-dir') cacheDir = v();
  else if (a === '--cache-max-age-days') maxAgeDays = v();
  else if (a === '--no-cache') noCache = true;
}
if (!source || !outPath || !logPath) {
  blocked('usage: --source figma|image --out <png> --log <path> required (--id for figma, --path for image)');
}
if (source !== 'figma' && source !== 'image') blocked(`unknown --source "${source}" — use figma or image`);
if (source === 'figma' && !id) blocked('--id <node-id | frame URL> is required for --source figma');
if (source === 'image' && !imgPath) blocked('--path <image file> is required for --source image');
if (scale !== undefined && !/^[1-4]$/.test(String(scale))) blocked('--scale must be 1..4');
if (!/^\d+$/.test(String(maxAgeDays)) || Number(maxAgeDays) < 1 || Number(maxAgeDays) > 365) {
  blocked('--cache-max-age-days must be a whole number of days, 1..365');
}
maxAgeDays = Number(maxAgeDays);

// ── structural image validation (check-image.js style, PNG/JPEG, no deps) ─────
const MIN_BYTES = 2 * 1024;
const BLANK_RATIO = 0.0015;
const BLANK_MIN_AREA = 100_000;

function readChunksPNG(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  let off = 8, width = 0, height = 0, colorType = 0, idatBytes = 0, sawIHDR = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataOff = off + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataOff);
      height = buf.readUInt32BE(dataOff + 4);
      colorType = buf[dataOff + 9];
      sawIHDR = true;
    } else if (type === 'IDAT') idatBytes += len;
    else if (type === 'IEND') break;
    off = dataOff + len + 4;
  }
  if (!sawIHDR) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 3;
  return { width, height, channels, idatBytes };
}

function readDimsJPEG(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5), channels: 3, idatBytes: 0 };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return { width: 0, height: 0, channels: 3, idatBytes: 0 };
}

// null = valid ({width,height}); string = the named structural problem.
function validateImage(buf, label) {
  let info = null, fmt = null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) { info = readChunksPNG(buf); fmt = 'png'; }
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) { info = readDimsJPEG(buf); fmt = 'jpeg'; }
  if (!fmt || !info) return { err: `${label} is not a real PNG/JPEG image` };
  if (info.width === 0 || info.height === 0) return { err: `${label} has zero dimensions` };
  if (buf.length < MIN_BYTES) return { err: `${label} is too small to be a usable baseline (${buf.length} bytes)` };
  if (fmt === 'png' && info.width * info.height >= BLANK_MIN_AREA) {
    const ratio = info.idatBytes / (info.width * info.height * info.channels);
    if (ratio < BLANK_RATIO) return { err: `${label} looks blank/near-uniform (compression ratio ${ratio.toFixed(5)}) — re-export the baseline` };
  }
  return { width: info.width, height: info.height };
}

function writeOut(buf) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

// ── image source ──────────────────────────────────────────────────────────────
if (source === 'image') {
  log(`SOURCE image ${imgPath}`);
  const full = path.resolve(process.cwd(), imgPath);
  if (!fs.existsSync(full)) blocked(`baseline image not found: ${imgPath}`);
  const buf = fs.readFileSync(full);
  const v = validateImage(buf, `baseline image ${imgPath}`);
  if (v.err) { log(`INVALID: ${v.err}`); blocked(v.err); }
  writeOut(buf);
  log(`copied ${imgPath} -> ${outPath} (${v.width}x${v.height}, ${buf.length} bytes)`);
  emit({ result: 'OK', baseline: outPath, width: v.width, height: v.height });
  process.exit(0);
}

// ── figma source ──────────────────────────────────────────────────────────────
// Node id: bare "123:456" / "123-456", or a full frame URL whose file key must
// match the configured one (a differing URL is surfaced, never silently used).
function parseFigmaId(raw, configuredKey) {
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return { err: `cannot parse Figma URL: ${raw}` }; }
    const m = u.pathname.match(/\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
    if (!m) return { err: `Figma URL has no file key: ${raw}` };
    const urlKey = m[1];
    const rawNode = u.searchParams.get('node-id');
    if (!rawNode) return { err: `Figma URL has no node-id parameter: ${raw}` };
    const nodeId = normalizeNodeId(decodeURIComponent(rawNode));
    if (urlKey !== configuredKey) {
      return {
        mismatch: true,
        err: `frame URL names Figma file "${urlKey}" but config/project.json figma.fileKey is "${configuredKey}" — confirm with the user which file to use (a differing URL is never silently used)`,
      };
    }
    return { nodeId };
  }
  return { nodeId: normalizeNodeId(raw) };
}
function normalizeNodeId(s) {
  return /^\d+-\d+$/.test(s) ? s.replace('-', ':') : s;
}

const cwd = process.cwd();
let figma;
try { figma = pc.loadProjectConfig(cwd).figma; }
catch (e) { blocked(e.message); } // e.g. "invalid JSON in <cwd>/config/project.json: …" (run_api.js precedent)
if (!figma || typeof figma !== 'object') {
  blocked('config/project.json has no "figma" block — add { "fileKey": "...", "token": { "envSecret": "FIGMA_TOKEN" } } (or run /update-agentex to scaffold it)');
}
if (!figma.fileKey || !String(figma.fileKey).trim()) {
  blocked('figma.fileKey is empty in config/project.json — set it to your Figma file key');
}
const fileKey = String(figma.fileKey).trim();
const parsed = parseFigmaId(String(id).trim(), fileKey);
if (parsed.err) {
  if (parsed.mismatch) blocked(parsed.err, { fileKeyMismatch: true });
  blocked(parsed.err);
}
const nodeId = parsed.nodeId;
const token = pc.resolveSecret(cwd, figma.token);
if (!token) {
  blocked(`${pc.secretHint(figma.token)} (figma token) is not set — the ui-check baseline cannot be fetched`);
}

const API_BASE = (process.env.FIGMA_API_BASE || 'https://api.figma.com').replace(/\/$/, '');

// A 429 or a 5xx is the API saying "not now", not "no": both are retried. 403/404 are
// answers about the token or the node — retrying those only wastes the tester's time.
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function backoffMs(attempt, retryAfterHeader) {
  const ra = parseInt(retryAfterHeader, 10);
  const base = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 2000;   // seconds, per RFC
  const grown = Math.min(base * Math.pow(2, attempt), 30000);
  // Jitter is not decoration: 19 parallel steps told the same Retry-After would all
  // come back in the same instant and earn the same 429. Never shorter than instructed.
  return Math.round(grown + Math.random() * Math.min(grown, 5000));
}

async function figmaGet(pathname, expectJson = true) {
  const url = `${API_BASE}${pathname}`;
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    log(`GET ${url}${attempt ? ` (attempt ${attempt + 1}/${MAX_ATTEMPTS})` : ''}`);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    let res, body;
    try {
      res = await fetch(url, { headers: { 'X-Figma-Token': token }, signal: ctl.signal });
      body = await res.text();
    } catch (e) {
      log(`REQUEST FAILED: ${e.message}`);
      last = { failed: `Figma API request failed: ${e.message}`, transient: true };
      if (attempt + 1 < MAX_ATTEMPTS) { await sleep(backoffMs(attempt, null)); continue; }
      return last;
    } finally { clearTimeout(t); }
    log(`HTTP_STATUS:${res.status}`);
    if (res.status === 403) return { failed: `Figma API rejected the token (HTTP 403) — check the ${pc.secretHint(figma.token)} value and its scopes` };
    if (res.status === 404) return { failed: `Figma returned 404 for ${pathname} — unknown file key or node id` };
    if (res.status === 429 || res.status >= 500) {
      const what = res.status === 429 ? 'rate-limited the token' : 'failed server-side';
      last = {
        failed: `Figma API ${what} (HTTP ${res.status}) for ${pathname}, still failing after ${attempt + 1} attempt(s)`,
        transient: true,
      };
      if (attempt + 1 < MAX_ATTEMPTS) {
        const waitMs = backoffMs(attempt, res.status === 429 ? res.headers.get('retry-after') : null);
        log(`RETRY in ${waitMs}ms (HTTP ${res.status})`);
        await sleep(waitMs);
        continue;
      }
      return last;
    }
    if (!res.ok) return { failed: `Figma API error HTTP ${res.status} for ${pathname}` };
    if (!expectJson) return { res, body };
    try { return { res, json: JSON.parse(body) }; }
    catch { return { failed: `Figma API returned non-JSON for ${pathname}` }; }
  }
  return last;
}

// ── fallback baseline cache ───────────────────────────────────────────────────
// A ui-check step with no baseline is a step that cannot run, and the design behind
// it usually has not moved for weeks — so a rate limit should not cost the tester the
// check. Every successful fetch leaves a PNG plus a sidecar (dimensions, node
// identity, variants) in the cache dir, keyed on file key + node + scale.
//
// It is a FALLBACK, never a first choice. The live design is always fetched first,
// because a cache read that silently stood in for a changed design would produce a
// confident wrong PASS — worse than any BLOCKED. So it is read back only when the
// live fetch failed transiently (429/5xx/network/download), never on a 403 or 404
// (those are broken config that must stay visible), never past the age ceiling, and
// never without saying so: a hit emits `cached: true`, `cachedAt`, and a reason the
// agent is required to carry into the report.
const cacheRoot = () => path.resolve(cwd, cacheDir);
function cacheFile(ext) {
  const key = `${fileKey}-${String(nodeId).replace(/[^A-Za-z0-9]+/g, '-')}-s${scale || 1}`;
  return path.join(cacheRoot(), key + ext);
}
const ageLabel = (ms) => {
  const h = ms / 3600000;
  return h < 48 ? `${Math.max(1, Math.round(h))}h` : `${Math.round(h / 24)}d`;
};
function writeCache(buf, meta) {
  if (noCache) return;
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true });
    fs.writeFileSync(cacheFile('.png'), buf);
    fs.writeFileSync(cacheFile('.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), ...meta }, null, 2));
    log(`cached baseline -> ${path.relative(cwd, cacheFile('.png'))}`);
  } catch (e) { log(`cache write skipped: ${e.message}`); }   // never masks a good result
}
// Returns { buf, meta, ageMs, at } on a usable hit, or a string saying why there is none.
function readCache() {
  if (noCache) return 'the fallback cache is off (--no-cache)';
  const png = cacheFile('.png'), side = cacheFile('.json');
  if (!fs.existsSync(png) || !fs.existsSync(side)) return 'no baseline for this frame has been cached yet';
  let meta;
  try { meta = JSON.parse(fs.readFileSync(side, 'utf8')); }
  catch { return `the cached baseline sidecar is unreadable (${path.relative(cwd, side)})`; }
  const at = Date.parse(meta.fetchedAt);
  if (!Number.isFinite(at)) return 'the cached baseline carries no usable fetch timestamp';
  const ageMs = Date.now() - at;
  if (ageMs > maxAgeDays * 86400000) {
    return `the only cached baseline is ${ageLabel(ageMs)} old, past the ${maxAgeDays}-day ceiling — an old design is not a baseline`;
  }
  const buf = fs.readFileSync(png);
  const v = validateImage(buf, 'the cached baseline');
  if (v.err) return `the cached baseline is unusable: ${v.err}`;
  return { buf, meta, ageMs, at: meta.fetchedAt };
}
// Transient live failure: fall back if we honestly can, BLOCK saying both reasons if not.
function transientFail(reason) {
  const hit = readCache();
  if (typeof hit === 'string') {
    log(`FALLBACK UNAVAILABLE: ${hit}`);
    return blockedAsync(`${reason}; and ${hit}`);
  }
  writeOut(hit.buf);
  log(`FALLBACK: served the cached baseline from ${hit.at} (${ageLabel(hit.ageMs)} old)`);
  emit({
    result: 'OK', baseline: outPath,
    width: hit.meta.width || 0, height: hit.meta.height || 0,
    node: hit.meta.node || null, variants: hit.meta.variants || [],
    cached: true, cachedAt: hit.at,
    reason: `${reason} — this check ran against the baseline cached ${hit.at} (${ageLabel(hit.ageMs)} old), NOT the live design; report that caveat with the verdict and re-run when Figma answers again`,
  });
  process.exitCode = 0;
}

(async () => {
  log(`SOURCE figma file=${fileKey} node=${nodeId}`);

  // 1. node metadata — identity, dimensions, variant candidates
  const meta = await figmaGet(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`);
  if (meta.failed) return meta.transient ? transientFail(meta.failed) : blockedAsync(meta.failed);
  const entry = meta.json && meta.json.nodes && meta.json.nodes[nodeId];
  const doc = entry && entry.document;
  if (!doc) return blockedAsync(`node ${nodeId} not found in Figma file ${fileKey} — check the frame identifier`);
  const bbox = doc.absoluteBoundingBox || {};
  const width = Math.round(bbox.width || 0);
  const height = Math.round(bbox.height || 0);
  log(`node: ${doc.id} "${doc.name}" ${doc.type} ${width}x${height}`);

  // Variant candidates: only containers whose children are themselves designs
  // (component sets, sections, whole pages) — a plain FRAME is itself the design.
  const CONTAINERS = ['COMPONENT_SET', 'SECTION', 'CANVAS'];
  let variants = [];
  if (CONTAINERS.includes(doc.type) && Array.isArray(doc.children)) {
    variants = doc.children
      .filter(c => c && ['FRAME', 'COMPONENT'].includes(c.type) && c.absoluteBoundingBox)
      .map(c => ({
        id: c.id, name: c.name,
        width: Math.round(c.absoluteBoundingBox.width || 0),
        height: Math.round(c.absoluteBoundingBox.height || 0),
      }));
    if (variants.length < 2) variants = [];   // one child = no ambiguity to gate on
    else log(`variants: ${variants.map(v => `${v.id} "${v.name}" ${v.width}x${v.height}`).join('; ')}`);
  }

  // 2. render to PNG — the returned URL is short-lived: download IMMEDIATELY
  const scaleQ = scale ? `&scale=${scale}` : '';
  const render = await figmaGet(`/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png${scaleQ}`);
  if (render.failed) return render.transient ? transientFail(render.failed) : blockedAsync(render.failed);
  if (render.json.err) return blockedAsync(`Figma could not render node ${nodeId}: ${render.json.err}`);
  const renderUrl = render.json.images && render.json.images[nodeId];
  if (!renderUrl) return blockedAsync(`Figma could not render node ${nodeId} (images API returned no URL)`);
  log('render URL received (short-lived) — downloading immediately');

  let buf;
  {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch(renderUrl, { signal: ctl.signal }); // NO token — render host is not the Figma API
      log(`DOWNLOAD HTTP_STATUS:${res.status}`);
      if (!res.ok) return transientFail(`baseline render download failed: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log(`DOWNLOAD FAILED: ${e.message}`);
      return transientFail(`baseline render download failed: ${e.message}`);
    } finally { clearTimeout(t); }
  }

  // 3. structural validation + save
  const v = validateImage(buf, `rendered baseline for node ${nodeId}`);
  if (v.err) { log(`INVALID: ${v.err}`); return blockedAsync(v.err); }
  writeOut(buf);
  log(`saved: ${outPath} (${buf.length} bytes, render ${v.width}x${v.height})`);
  writeCache(buf, { width, height, node: { id: doc.id, name: doc.name, type: doc.type }, variants });

  emit({
    result: 'OK', baseline: outPath, width, height,
    node: { id: doc.id, name: doc.name, type: doc.type },
    variants, reason: null,
  });
  process.exitCode = 0;
})();
