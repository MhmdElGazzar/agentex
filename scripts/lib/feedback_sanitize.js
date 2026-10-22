'use strict';
// AgenTeX field-feedback sanitizer (field-feedback-loop; spec appendix A4).
//
// The module is pure apart from buildContext / loadSecretContext's reads. Its main
// function is sanitizeEntry(entry, ctx) -> { entry, counts }. The layers, in order:
//
//   1. secrets (below);
//   2. config-derived names: exact values from config/project.json, environments/*.json,
//      test/test-data/**, the project root name, git remote path segments and the OS user,
//      longest first, case-insensitive, each at least 3 chars;
//   3. structural patterns: URL, email, IPv4/IPv6, absolute path, hostname, localhost;
//   4. post-verification: the output (placeholders masked) is re-scanned against every
//      layer 1 and layer 2 needle and every layer 3 pattern; any residue is a hard stop.
// Layers 1 and 2 run as ONE pass over the original text (a placeholder is never
// rescanned), layer 1 winning every overlap; layer 3 then runs on that result.
//
// Capture (S-1) uses layer 1 alone (`{env:NAME}` placeholders); export uses them all.
//
// Layer 1 — secrets. The project's own secret values are the needles: every .env key,
// every { "envSecret": NAME } name found in config/project.json, environments/*.json
// and integration/**/*.json, and the plugin's canonical secret names, resolved from the
// process environment and .env the way the plugin resolves them (secret_scan_core's
// buildNeedles). A value of 8+ chars is replaced wherever it occurs; a shorter value
// only after a password-style label (labelBeforeValue + rightBoundaryOk). Credential
// shapes (scanShapes' patterns) are replaced too. Placeholders: `{env:NAME}` for a
// needle (capture) or `<secret>` for everything (export), `<secret>` for a shape.
//
// Reads only (config files, .env, git remote URLs through git_plumbing's read-only
// remoteUrls). No network. Values live in memory only; nothing here ever prints one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Refusal, TRIGGERS, MODES } = require('./learnings.js');
const inventoryLib = require('./plugin_inventory.js');

const LABEL_WINDOW = 256;          // left context examined before a short value (as secret_scan_core)
const MAX_CONFIG_BYTES = 1024 * 1024;

function loadCore() {
  try { return require('./secret_scan_core.js'); } catch { return null; }
}
const readTextOrNull = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// The JSON files whose envSecret references name secrets.
function configFiles(cwd) {
  const out = [];
  const addDir = (rel, kind, depth) => {
    const dir = path.join(cwd, rel);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink()) continue;
      const relPath = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 4) addDir(relPath, kind, depth + 1);
      else if (e.isFile() && e.name.endsWith('.json')) out.push({ rel: relPath, kind });
    }
  };
  out.push({ rel: 'config/project.json', kind: 'config' });
  addDir('environments', 'environment', 0);
  addDir('integration', 'integration', 0);
  return out;
}

// loadSecretContext(cwd, { pluginRoot, env }) ->
//   { core, needles, valueCheck: 'ran'|'skipped', docs:[{rel,kind,doc}], parseErrors:[{rel,kind}], envText }
// Returns null when the secret-scan core cannot be loaded (callers refuse: nothing may be
// written or exported without the secret layer).
function loadSecretContext(cwd, { pluginRoot, env = process.env } = {}) {
  const core = loadCore();
  if (!core) return null;
  const envText = readTextOrNull(path.join(cwd, '.env'));
  const docs = []; const parseErrors = []; const names = new Set();
  for (const f of configFiles(cwd)) {
    const abs = path.join(cwd, f.rel);
    let raw;
    try {
      if (fs.statSync(abs).size > MAX_CONFIG_BYTES) continue;
      raw = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    try { docs.push({ ...f, doc: JSON.parse(raw.replace(/^﻿/, '')) }); }
    catch { parseErrors.push(f); }
  }
  for (const d of docs) core.collectEnvSecretNames(d.doc, names);
  const canonical = core.canonicalSecretNames(pluginRoot ? readTextOrNull(path.join(pluginRoot, '.env.example')) : null);
  const needles = core.buildNeedles({ envText, envSecretNames: [...names], canonicalNames: canonical, processEnv: env || {} });
  return { core, needles, valueCheck: needles.valueCheck.status === 'ran' ? 'ran' : 'skipped', docs, parseErrors, envText };
}

// All spans of `text` that layer 1 replaces: [{ start, end, placeholder }], non-overlapping.
function secretSpans(text, ctx, { named = true } = {}) {
  const { core, needles } = ctx;
  const spans = [];
  const ph = (n) => (named ? `{env:${n.key}}` : '<secret>');
  for (const n of needles.substring) {
    for (let i = text.indexOf(n.value); i >= 0; i = text.indexOf(n.value, i + 1)) spans.push({ start: i, end: i + n.value.length, placeholder: ph(n) });
  }
  for (const n of needles.labeled) {
    for (let i = text.indexOf(n.value); i >= 0; i = text.indexOf(n.value, i + 1)) {
      const end = i + n.value.length;
      if (!core.rightBoundaryOk(text, end)) continue;
      const lineStart = text.lastIndexOf('\n', i - 1) + 1;
      if (core.labelBeforeValue(text.slice(Math.max(lineStart, i - LABEL_WINDOW), i))) spans.push({ start: i, end, placeholder: ph(n) });
    }
  }
  for (const { re } of core.SHAPE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) { spans.push({ start: m.index, end: m.index + m[0].length, placeholder: '<secret>' }); if (m[0] === '') re.lastIndex++; }
    re.lastIndex = 0;
  }
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const s of spans) if (!out.length || s.start >= out[out.length - 1].end) out.push(s);
  return out;
}

// redactSecrets(text, ctx, { named }) -> { text, count }
function redactSecrets(text, ctx, opts = {}) {
  const s = String(text);
  const spans = secretSpans(s, ctx, opts);
  if (!spans.length) return { text: s, count: 0 };
  let out = ''; let at = 0;
  for (const sp of spans) { out += s.slice(at, sp.start) + sp.placeholder; at = sp.end; }
  return { text: out + s.slice(at), count: spans.length };
}


// ===========================================================================================
// Layers 2-4 and sanitizeEntry
// ===========================================================================================
const CATEGORIES = ['secret', 'url', 'host', 'ip', 'email', 'org-name', 'project-name', 'site-name', 'env-url', 'user-name', 'test-data', 'path'];
const emptyCounts = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
const sumCounts = (list) => { const t = emptyCounts(); for (const c of list) for (const k of CATEGORIES) t[k] += c[k] || 0; return t; };
const countTotal = (c) => CATEGORIES.reduce((n, k) => n + (c[k] || 0), 0);
const PLACEHOLDER = Object.fromEntries(CATEGORIES.map((c) => [c, `<${c}>`]));
const PLACEHOLDER_RE = new RegExp(`${CATEGORIES.map((c) => `<${c}>`).join('|')}|\\{env:[A-Za-z0-9_]+\\}`, 'g');

const DEFAULTS = Object.freeze({
  MIN_NAME_LENGTH: 3,                 // tunable (Q8): a shorter configured value is never a needle
  MAX_DATA_BYTES: 1024 * 1024,        // tunable: test-data files over this are skipped
  MAX_DATA_DEPTH: 6,
  EXT_ALLOWLIST: ['md', 'js', 'mjs', 'cjs', 'ts', 'json', 'txt', 'png', 'html', 'yml', 'yaml', 'sh', 'ps1', 'py', 'csv', 'xml', 'env', 'log'],
});

// Length-preserving case fold: a char whose lowercase differs in length stays as it is, so
// a span found in the folded text indexes the original text exactly.
function fold(s) {
  let out = '';
  for (const ch of String(s)) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
}

// ---- layer 2: the names -----------------------------------------------------------------------
class Names {
  constructor(min) { this.min = min; this.list = []; this.seen = new Set(); }
  add(value, category) {
    if (value === undefined || value === null || typeof value === 'boolean') return;
    const v = String(value).trim();
    if (v.length < this.min || /[\r\n]/.test(v)) return;
    const f = fold(v);
    if (this.seen.has(f)) return;
    this.seen.add(f);
    this.list.push({ value: v, fold: f, category, prio: this.list.length });
  }
  // a URL-shaped value: the whole value, its origin and its host
  addUrl(value, category) {
    this.add(value, category);
    const v = String(value || '').trim();
    this.add(v.replace(/\/+$/, ''), category);
    try { const u = new URL(v); this.add(u.origin, category); this.add(u.host, category); this.add(u.hostname, category); } catch { /* not a URL */ }
  }
  addAll(values, category) { for (const v of values) this.add(v, category); }
}
const isUrlShaped = (v) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(v.trim());
const pathSegments = (v) => String(v || '').split(/[\\/]/).map((x) => x.trim()).filter(Boolean);
const splitList = (v) => String(v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Every string / number leaf outside an { envSecret } reference (that value is a variable NAME).
function leaves(node, fn) {
  if (Array.isArray(node)) { for (const v of node) leaves(v, fn); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { if (k === 'envSecret') continue; leaves(v, fn); }
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') fn(String(node));
}

function addProjectConfig(names, cfg) {
  const c = obj(cfg);
  names.add(c.name, 'project-name');
  const az = obj(c.azure);
  names.addUrl(az.org, 'org-name');
  for (const seg of isUrlShaped(az.org) ? pathSegments(new URL(az.org.trim()).pathname) : []) names.add(seg, 'org-name');
  names.add(az.project, 'project-name'); names.add(az.team, 'project-name');
  for (const k of ['areaPath', 'iterationPath']) { names.add(az[k], 'project-name'); names.addAll(pathSegments(az[k]), 'project-name'); }
  const ji = obj(c.jira);
  names.addUrl(ji.site, 'site-name');
  try { const host = new URL(/^[a-z]+:\/\//i.test(String(ji.site)) ? String(ji.site) : `https://${ji.site}`).hostname; if (host.endsWith('.atlassian.net')) names.add(host.split('.')[0], 'site-name'); } catch { /* not a site */ }
  names.add(ji.project, 'project-name'); names.add(ji.board, 'project-name');
  for (const who of [az.assignee, ji.assignee]) for (const a of splitList(who)) { names.add(a, 'user-name'); if (a.includes('@')) names.add(a.split('@')[0], 'user-name'); }
  const kb = obj(c.kb);
  names.addUrl(kb.baseUrl, 'env-url'); names.add(kb.project, 'project-name'); names.add(kb.org, 'org-name');
  names.add(obj(c.figma).fileKey, 'project-name');
}

function addEnvironment(names, env) {
  const e = obj(env);
  names.addUrl(e.portalUrl, 'env-url');
  names.addUrl(obj(e.api).baseUrl, 'env-url');
  const db = obj(e.db);
  names.add(db.server, 'host'); names.add(db.name, 'host');
  names.add(db.user, 'user-name'); names.add(db.username, 'user-name');
  leaves(e, (v) => { if (isUrlShaped(v)) names.addUrl(v, 'env-url'); });
  for (const handle of Object.keys(obj(e.users))) names.add(handle, 'user-name');
  leaves(e.users, (v) => names.add(v, 'test-data'));
  leaves(e.defaults, (v) => names.add(v, 'test-data'));
}

// RFC 4180-ish cells: quoted cells keep commas and newlines.
function csvCells(text) {
  const cells = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === '\n' || ch === '\r') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim()).filter(Boolean);
}
function addTestData(names, cwd, o) {
  const walk = (rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (depth < o.MAX_DATA_DEPTH) walk(r, depth + 1); continue; }
      if (!e.isFile() || !/\.(json|csv)$/i.test(e.name)) continue;
      let raw;
      try { if (fs.statSync(path.join(cwd, r)).size > o.MAX_DATA_BYTES) continue; raw = fs.readFileSync(path.join(cwd, r), 'utf8'); } catch { continue; }
      if (/\.json$/i.test(e.name)) { try { leaves(JSON.parse(raw.replace(/^\uFEFF/, '')), (v) => names.add(v, 'test-data')); } catch { /* skip */ } }
      else for (const cell of csvCells(raw.replace(/^\uFEFF/, ''))) names.add(cell, 'test-data');
    }
  };
  walk('test/test-data', 0);
}

// A git remote URL's path segments (org first); credentials in its userinfo as secrets.
function remoteParts(url) {
  const out = { org: [], project: [], secrets: [] };
  const u = String(url || '').trim();
  let rest;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/.exec(u);
  if (scheme) {
    const after = scheme[1];
    const slash = after.indexOf('/');
    const authority = slash < 0 ? after : after.slice(0, slash);
    const at = authority.lastIndexOf('@');
    if (at >= 0 && /^https?:\/\//i.test(u)) {
      const info = authority.slice(0, at); const colon = info.indexOf(':');
      for (const part of colon < 0 ? [info] : [info.slice(0, colon), info.slice(colon + 1)]) {
        let d = part; try { d = decodeURIComponent(part); } catch { /* keep raw */ }
        if (d) out.secrets.push(d);
      }
    }
    rest = slash < 0 ? '' : after.slice(slash + 1);
  } else {
    const scp = /^[^@/\s]+@[^:/\s]+:(.*)$/.exec(u) || /^[^:/\s]+:(.*)$/.exec(u);
    rest = scp ? scp[1] : '';
  }
  const segs = rest.split('/').filter(Boolean).map((x, i, a) => (i === a.length - 1 ? x.replace(/\.git$/i, '') : x)).filter((x) => !x.startsWith('_'));
  segs.forEach((seg, i) => { (i === 0 && segs.length > 1 ? out.org : out.project).push(seg); });
  return out;
}

function remoteUrlsOf(cwd) {
  try { return require('./git_plumbing.js').remoteUrls(cwd).map((r) => r.url); } catch { return []; }
}

// buildContext(cwd, { pluginRoot, env, osUser, homeDir, verifyOnly, minNameLength, … }) -> ctx
// Hard stops (Refusal, exit 2): core-unavailable, config-unparseable, environment-unparseable.
function buildContext(cwd, opts = {}) {
  const o = { ...DEFAULTS, MIN_NAME_LENGTH: opts.minNameLength || DEFAULTS.MIN_NAME_LENGTH };
  const secret = loadSecretContext(cwd, { pluginRoot: opts.pluginRoot, env: opts.env === undefined ? process.env : opts.env });
  if (!secret) throw new Refusal('the secret-scan core could not be loaded', { reason: 'core-unavailable' });
  if (secret.parseErrors.some((e) => e.kind === 'config')) throw new Refusal('config/project.json is not valid JSON', { reason: 'config-unparseable' });
  if (secret.parseErrors.some((e) => e.kind === 'environment')) throw new Refusal('an environments/*.json file is not valid JSON', { reason: 'environment-unparseable' });
  const names = new Names(o.MIN_NAME_LENGTH);
  for (const d of secret.docs) {
    if (d.kind === 'config') addProjectConfig(names, d.doc);
    else if (d.kind === 'environment') addEnvironment(names, d.doc);
  }
  addTestData(names, cwd, o);
  names.add(path.basename(path.resolve(cwd)), 'project-name');
  const known = new Set(secret.needles.all.map((n) => n.value));
  const remoteSecrets = [];
  for (const url of remoteUrlsOf(cwd)) {
    const r = remoteParts(url);
    if (secret.core.remoteHasCredential(url, known)) remoteSecrets.push(...r.secrets);
    names.addAll(r.org, 'org-name'); names.addAll(r.project, 'project-name');
  }
  let user = opts.osUser; let home = opts.homeDir;
  if (user === undefined) { try { user = os.userInfo().username; } catch { user = ''; } }
  if (home === undefined) { try { home = os.homedir(); } catch { home = ''; } }
  names.add(user, 'user-name');
  names.add(home, 'path');
  // a credential found in a remote URL becomes one more layer-1 needle (any length)
  for (const value of remoteSecrets) {
    const needle = { key: 'REMOTE_CREDENTIAL', value };
    secret.needles.all.push(needle);
    (value.length >= secret.core.DEFAULTS.MIN_VALUE_LENGTH ? secret.needles.substring : secret.needles.labeled).push(needle);
  }
  const inventory = inventoryLib.loadInventory(opts.pluginRoot);
  return {
    secret, names: names.list, inventoryNames: inventory.names, extAllowlist: new Set(opts.extAllowlist || o.EXT_ALLOWLIST),
    verifyOnly: opts.verifyOnly || [],
    valueCheck: secret.valueCheck,
    valueCheckReason: secret.needles.valueCheck.reason || null,
    configFound: secret.docs.some((d) => d.kind === 'config' || d.kind === 'environment'),
  };
}

// ---- layer 3: structural patterns ---------------------------------------------------------------
const PATH_CHARS = '[\\w.@%+~$=,-]';
const TRAILING = /[.,;:!?)\]}]+$/;
const splitTrailing = (m) => { const t = TRAILING.exec(m); return t ? [m.slice(0, t.index), t[0]] : [m, '']; };
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\w|\.\d)/g;
const IPV6_RE = /(?<![\w:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})(?![\w:])/g;
const PATTERNS = [
  { cat: 'url', re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g, keepTrailing: true },
  { cat: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { cat: 'ip', re: IPV4_RE, check: (m) => m.split(':')[0].split('.').every((p) => Number(p) <= 255) },
  { cat: 'ip', re: IPV6_RE },
  { cat: 'path', re: /(?<![\w])[A-Za-z]:\\[^\s"'<>|*?]+/g, keepTrailing: true },
  { cat: 'path', re: /(?<![\w])[A-Za-z]:\/(?!\/)[^\s"'<>|*?]+/g, keepTrailing: true },
  { cat: 'path', re: /\\\\[^\s\\/:*?"<>|]+\\[^\s"'<>|*?]+/g, keepTrailing: true },
  { cat: 'path', re: new RegExp(`(?<![\\w:/.~-])(?:~(?:\\/${PATH_CHARS}+)+|(?:\\/${PATH_CHARS}+){2,})\\/?`, 'g'), keepTrailing: true },
  { cat: 'host', re: /\blocalhost\b/gi },
  { cat: 'host', re: /(?<![A-Za-z0-9-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![A-Za-z0-9-])/g, host: true },
];

function applyStructural(text, ctx, counts) {
  let out = String(text);
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.check && !p.check(m)) return m;
      if (p.host) {
        const tld = m.slice(m.lastIndexOf('.') + 1).toLowerCase();
        if (ctx.extAllowlist.has(tld) || ctx.inventoryNames.has(m)) return m;
      }
      const [core, tail] = p.keepTrailing ? splitTrailing(m) : [m, ''];
      if (core === '') return m;
      counts[p.cat]++;
      return PLACEHOLDER[p.cat] + tail;
    });
  }
  return out;
}

// ---- layers 1 + 2 in one pass, then 3, then 4 -------------------------------------------------------
function nameSpans(text, ctx) {
  const f = fold(text); const spans = [];
  for (const n of ctx.names) {
    for (let i = f.indexOf(n.fold); i >= 0; i = f.indexOf(n.fold, i + 1)) spans.push({ start: i, end: i + n.fold.length, prio: n.prio, category: n.category });
  }
  return spans;
}

// Residue count (never a value): needles and patterns that still match once the
// placeholders are masked.
function findResidue(text, ctx) {
  const masked = String(text).replace(PLACEHOLDER_RE, ' ');
  let n = secretSpans(masked, ctx.secret, { named: false }).length;
  const f = fold(masked);
  for (const name of ctx.names) if (f.includes(name.fold)) n++;
  for (const v of ctx.verifyOnly) if (masked.includes(v)) n++;
  const c = emptyCounts();
  applyStructural(masked, ctx, c);
  return n + countTotal(c);
}

// sanitizeText(text, ctx, counts) -> the sanitized text; `counts` (emptyCounts()) is added to.
function sanitizeText(text, ctx, counts) {
  const t = String(text);
  const taken = new Uint8Array(t.length);
  const chosen = [];
  const free = (sp) => { for (let i = sp.start; i < sp.end; i++) if (taken[i]) return false; return true; };
  const take = (sp) => { for (let i = sp.start; i < sp.end; i++) taken[i] = 1; chosen.push(sp); };
  for (const sp of secretSpans(t, ctx.secret, { named: false })) take({ ...sp, category: 'secret' });
  const names = nameSpans(t, ctx).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.prio - b.prio || a.start - b.start);
  for (const sp of names) if (free(sp)) take({ ...sp, placeholder: PLACEHOLDER[sp.category] });
  chosen.sort((a, b) => a.start - b.start);
  let out = ''; let at = 0;
  for (const sp of chosen) { out += t.slice(at, sp.start) + sp.placeholder; at = sp.end; counts[sp.category]++; }
  out += t.slice(at);
  out = applyStructural(out, ctx, counts);
  if (findResidue(out, ctx) > 0) throw new Refusal('the sanitized text still matches a needle or a pattern (values not shown) — nothing was written', { reason: 'residue' });
  return out;
}

const FIXED = {
  id: (v) => /^PL-\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  version: (v) => /^\d+\.\d+\.\d+(?:[-+.\w]*)?$/.test(v),
};

// sanitizeEntry(entry, ctx) -> { entry, counts }. Pure per entry. The exported entry carries
// id, date, trigger, affected, version, [mode], problem, workaround: script, fork, rule and
// session never leave. A fixed-vocabulary field outside its vocabulary is sanitized as text.
function sanitizeEntry(entry, ctx) {
  const counts = emptyCounts();
  const fields = entry.fields || {};
  const fixed = (key, ok) => (ok ? String(entry[key]) : sanitizeText(entry[key], ctx, counts));
  const out = {
    id: fixed('id', FIXED.id(String(entry.id))),
    date: fixed('date', FIXED.date(String(entry.date))),
    trigger: fixed('trigger', TRIGGERS.includes(entry.trigger)),
    affected: fixed('affected', entry.affected === 'unknown' || ctx.inventoryNames.has(entry.affected)),
    version: fixed('version', FIXED.version(String(entry.version))),
  };
  if (fields.mode !== undefined) out.mode = MODES.includes(fields.mode) ? fields.mode : sanitizeText(fields.mode, ctx, counts);
  out.problem = sanitizeText(fields.problem || '', ctx, counts);
  out.workaround = sanitizeText(fields.workaround || '', ctx, counts);
  return { entry: out, counts };
}

// The payload the markdown export renders (frozen as schemaVersion 1; the relay reads it).
function buildPayload({ plugin, entries, forkedSkills, counts }) {
  return {
    tool: 'agentex-field-feedback', schemaVersion: 1,
    plugin: { name: plugin.name, version: plugin.version },
    entries, forkedSkills,
    sanitization: { bestEffort: true, counts },
  };
}

// ---- the export file (a rendering of the payload) ---------------------------------------------------
const SEP = ' · ';
function indentLines(key, value) {
  const [first, ...rest] = String(value).split('\n');
  return [`  ${key}: ${first}`, ...rest.map((l) => `    ${l}`)];
}
// renderExport(payload, { repository, valueCheck, valueCheckReason, configFound }) -> markdown
function renderExport(payload, o = {}) {
  const repo = typeof o.repository === 'string' && o.repository ? o.repository.replace(/\/+$/, '').replace(/\.git$/, '') : null;
  const where = repo
    ? `the AgenTeX public issue tracker, label \`field-feedback\`\n> (${repo}/issues/new?labels=field-feedback). Anything you send there can be read by anyone.`
    : 'the AgenTeX public issue tracker, label `field-feedback`. Anything you send there can be read by anyone.';
  const counts = payload.sanitization.counts;
  const replaced = CATEGORIES.filter((c) => counts[c] > 0).map((c) => `${counts[c]} ${c}`).join(SEP) || 'nothing';
  const valueLine = o.valueCheck === 'ran'
    ? 'Secret value check: ran.'
    : `Secret value check: skipped — ${o.valueCheckReason === 'no-env-file' ? 'no .env' : 'no secret values to check'}.`;
  const out = [
    `<!-- agentex:field-feedback-export schemaVersion=${payload.schemaVersion} plugin=${payload.plugin.name}@${payload.plugin.version} -->`,
    '# AgenTeX field feedback (export)',
    '',
    '> **Review before sending.** Sanitization is best effort, not a guarantee: read every line and',
    '> remove anything that identifies your organization, client, application or data.',
    `> **The destination is public**: ${where}`,
    '> AgenTeX never sends this file; you do, by pasting it into a new issue.',
    '',
    `Replaced before export: ${replaced} (values are never shown).`,
    valueLine,
  ];
  if (o.configFound === false) out.push('Config-derived names: not replaced — no config/ or environments/ files were found.');
  out.push('', `## Open learnings (${payload.entries.length})`);
  for (const e of payload.entries) {
    out.push(`- ${e.id}${SEP}${e.date}${SEP}${e.trigger}${SEP}${e.affected}${SEP}v${e.version}`);
    out.push(...indentLines('problem', e.problem), ...indentLines('workaround', e.workaround));
  }
  if (payload.forkedSkills.length) {
    out.push('', '## Forked plugin skills (names only)');
    for (const name of payload.forkedSkills) out.push(`- ${name}`);
  }
  return `${out.join('\n')}\n`;
}

module.exports = {
  CATEGORIES, DEFAULTS, emptyCounts, sumCounts, countTotal,
  loadSecretContext, secretSpans, redactSecrets, configFiles,
  buildContext, sanitizeText, sanitizeEntry, findResidue, buildPayload, renderExport,
};
