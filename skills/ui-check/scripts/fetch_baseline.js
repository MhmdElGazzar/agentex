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
//   node fetch_baseline.js --source image --path <baseline image> --out ... --log ...
//
// Prints ONE JSON line:
//   {"result":"OK|BLOCKED","baseline":"<out>","width":W,"height":H,
//    "node":{"id","name","type"}|null,"variants":[{id,name,width,height},...],
//    "fileKeyMismatch":false,"reason":null}
//
// figma source: file key + token come from config/project.json's "figma" block
// ({ "fileKey": "...", "token": { "envSecret": "FIGMA_TOKEN" } }) — a story carries
// only the node id. Render URLs from /v1/images are SHORT-LIVED: downloaded
// immediately, never stored. The token is sent as the X-Figma-Token header to the
// Figma API only — never to the render host, never printed, never logged.
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
    node: null, variants: [], fileKeyMismatch: false, reason: null, ...obj,
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
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--source') source = v();
  else if (a === '--id') id = v();
  else if (a === '--path') imgPath = v();
  else if (a === '--out') outPath = v();
  else if (a === '--log') logPath = v();
  else if (a === '--scale') scale = v();
}
if (!source || !outPath || !logPath) {
  blocked('usage: --source figma|image --out <png> --log <path> required (--id for figma, --path for image)');
}
if (source !== 'figma' && source !== 'image') blocked(`unknown --source "${source}" — use figma or image`);
if (source === 'figma' && !id) blocked('--id <node-id | frame URL> is required for --source figma');
if (source === 'image' && !imgPath) blocked('--path <image file> is required for --source image');
if (scale !== undefined && !/^[1-4]$/.test(String(scale))) blocked('--scale must be 1..4');

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
const figma = pc.loadProjectConfig(cwd).figma;
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

async function figmaGet(pathname, expectJson = true) {
  const url = `${API_BASE}${pathname}`;
  log(`GET ${url}`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  let res, body;
  try {
    res = await fetch(url, { headers: { 'X-Figma-Token': token }, signal: ctl.signal });
    body = await res.text();
  } catch (e) {
    log(`REQUEST FAILED: ${e.message}`);
    return { failed: `Figma API request failed: ${e.message}` };
  } finally { clearTimeout(t); }
  log(`HTTP_STATUS:${res.status}`);
  if (res.status === 403) return { failed: `Figma API rejected the token (HTTP 403) — check the ${pc.secretHint(figma.token)} value and its scopes` };
  if (res.status === 404) return { failed: `Figma returned 404 for ${pathname} — unknown file key or node id` };
  if (!res.ok) return { failed: `Figma API error HTTP ${res.status} for ${pathname}` };
  if (!expectJson) return { res, body };
  try { return { res, json: JSON.parse(body) }; }
  catch { return { failed: `Figma API returned non-JSON for ${pathname}` }; }
}

(async () => {
  log(`SOURCE figma file=${fileKey} node=${nodeId}`);

  // 1. node metadata — identity, dimensions, variant candidates
  const meta = await figmaGet(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`);
  if (meta.failed) return blockedAsync(meta.failed);
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
  if (render.failed) return blockedAsync(render.failed);
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
      if (!res.ok) return blockedAsync(`baseline render download failed: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log(`DOWNLOAD FAILED: ${e.message}`);
      return blockedAsync(`baseline render download failed: ${e.message}`);
    } finally { clearTimeout(t); }
  }

  // 3. structural validation + save
  const v = validateImage(buf, `rendered baseline for node ${nodeId}`);
  if (v.err) { log(`INVALID: ${v.err}`); return blockedAsync(v.err); }
  writeOut(buf);
  log(`saved: ${outPath} (${buf.length} bytes, render ${v.width}x${v.height})`);

  emit({
    result: 'OK', baseline: outPath, width, height,
    node: { id: doc.id, name: doc.name, type: doc.type },
    variants, reason: null,
  });
  process.exitCode = 0;
})();
