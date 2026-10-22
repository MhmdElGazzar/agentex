'use strict';
// AgenTeX consumer secret-scan core — pure logic behind scripts/secret_scan.js.
// No I/O beyond what callers pass in: they hand over .env text, file contents and
// remote URLs; this module returns needles, findings and the result object.
//
// Five areas:
//   needles   — the project's own secret values (every .env key + every envSecret
//               name + the plugin's canonical secret names, resolved the way the
//               plugin resolves them: process env and .env), minus the plugin's
//               own non-secret config keys and any <NAME>_BASE_URL key; short values
//               never substring-matched.
//   matching  — `secret-value` (whole-text includes prefilter, then line split) and,
//               for short known values only, `short-value-labeled`: (a) a whole token
//               right after a password label in text, (b) structurally in JSON.
//               Value first, then context — a value never enters a regex source.
//   fields    — the position-aware JSON walker and the secret-capable field table
//               behind the `plain-secret-field` warning (never a block).
//   remotes   — credential detection in http(s) remote URLs (never printed).
//   shapes    — public, prefixed credential formats (`credential-shape`, a warning
//               only, independent of .env) in file text and remote-URL userinfo, plus
//               the --hook confirmation rules (asked, default No; a "no" refuses
//               through the installed hook's existing LEAK contract).
//
// Values are held in memory only. Findings carry file, line, key / field / label
// names — never a value, never raw file text. Error text is fixed vocabulary.
const { ENV_KEY_MAP } = require('./env_key_map.js');
const { parseEnvValue } = require('./project_config.js');
const { PAT_ENV_NAMES } = require('./tracker/adapters/ado.js');
const { collectEnvSecretNames } = require('../../skills/test-execution/scripts/ci_preflight.js');

// Tunable defaults (policy Q8) — every one has a CLI override for tests and tuning.
const DEFAULTS = Object.freeze({
  MIN_VALUE_LENGTH: 8,           // shorter known values are never raw substring needles
  MIN_LABELED_VALUE_LENGTH: 4,   // shorter still: not matched at all (RD-8)
  MAX_FILE_BYTES: 1024 * 1024,
  BINARY_SNIFF_BYTES: 8000,      // git's own heuristic
  MAX_FINDINGS: 200,
});

// The ADO adapter's non-secret .env fallbacks (resolveConfig's pick() calls;
// "the consumer's non-secret ADO settings"). Drift-pinned by the core test.
const ADO_NON_SECRET_FALLBACKS = [
  'AZURE_TEAM', 'AZURE_AREA_PATH', 'AZURE_ITERATION_PATH', 'AZURE_BUG_TEMPLATE_ID', 'AZURE_ASSIGNEE',
  'AZURE_VALUE_AREA', 'AZURE_ENVIRONMENT', 'AZURE_BUG_CATEGORY', 'AZURE_TEST_PLAN_ID', 'AZURE_API_VERSION',
];
// Identifiers, not secrets (NU-6): the Jira account email is the other half of the
// Basic pair and legitimately sits in config as jira.assignee too.
const IDENTIFIER_ENV_KEYS = ['JIRA_EMAIL'];
const NON_SECRET_ENV_KEYS = Object.freeze([...new Set([
  ...Object.keys(ENV_KEY_MAP), ...ADO_NON_SECRET_FALLBACKS, ...IDENTIFIER_ENV_KEYS,
])]);
// A service base URL is not a secret: /import-swagger tells the user to keep
// <NAME>_BASE_URL in .env. Named separately (notChecked.baseUrlKeys) because, unlike
// the keys above, it is not a setting to move into config. Only this exact suffix.
const BASE_URL_KEY_RE = /^[A-Z0-9_]+_BASE_URL$/;

const ENV_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const stripBom = (s) => String(s).replace(/^﻿/, '');

// Every key in .env-format text, in order, once — the same line grammar as parseEnvValue.
function enumerateEnvKeys(text) {
  const keys = [];
  for (const line of stripBom(text).split(/\r\n|\n|\r/)) {
    const m = line.match(ENV_LINE_RE);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

// The plugin's canonical secret names: active (uncommented) keys of its own
// .env.example, plus every PAT variable name the ADO adapter accepts.
function canonicalSecretNames(envExampleText) {
  return [...new Set([...(envExampleText ? enumerateEnvKeys(envExampleText) : []), ...PAT_ENV_NAMES])];
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The project's own secret values, classified.
 * @returns {{ substring, labeled, all, valueCheck }} — each needle { key, value };
 *   `all` holds every known value (short ones too) for the exact-equality overlap check.
 */
function buildNeedles({
  envText = null, envSecretNames = [], canonicalNames = [], processEnv = {},
  minValueLength = DEFAULTS.MIN_VALUE_LENGTH, minLabeledValueLength = DEFAULTS.MIN_LABELED_VALUE_LENGTH,
} = {}) {
  const text = envText === null || envText === undefined ? null : stripBom(envText);
  const names = [...new Set([...(text === null ? [] : enumerateEnvKeys(text)), ...envSecretNames, ...canonicalNames])];
  const nonSecretNamed = new Set();
  const baseUrlNamed = new Set();
  const shortNamed = new Set();
  const keysChecked = new Set();
  const labelChecked = new Set();
  const substring = []; const labeled = []; const all = [];
  const seen = new Set();
  let anyValue = false;
  for (const name of names) {
    const values = [];
    const fromProc = processEnv[name] !== undefined && processEnv[name] !== null ? String(processEnv[name]).trim() : '';
    if (fromProc) values.push(fromProc);
    const fromFile = text === null ? null : parseEnvValue(text, name);
    if (fromFile && !values.includes(fromFile)) values.push(fromFile);
    if (!values.length) continue;
    anyValue = true;
    if (NON_SECRET_ENV_KEYS.includes(name)) { nonSecretNamed.add(name); continue; }
    if (BASE_URL_KEY_RE.test(name)) { baseUrlNamed.add(name); continue; }
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      const needle = { key: name, value };
      all.push(needle);
      if (value.length >= minValueLength) { substring.push(needle); keysChecked.add(name); continue; }
      shortNamed.add(name);
      if (value.length >= minLabeledValueLength) { labeled.push(needle); labelChecked.add(name); }
    }
  }
  const valueCheck = {
    status: 'ran',
    keysChecked: [...keysChecked].sort(byName),
    labelChecked: [...labelChecked].sort(byName),
    notChecked: {
      shortValue: [...shortNamed].sort(byName),
      nonSecretKeys: [...nonSecretNamed].sort(byName),
      baseUrlKeys: [...baseUrlNamed].sort(byName),
    },
  };
  if (!substring.length && !labeled.length) {
    const noSource = text === null && !names.some(n => processEnv[n]);
    valueCheck.status = 'skipped';
    valueCheck.reason = noSource ? 'no-env-file' : anyValue ? 'all-excluded' : 'no-values';
    // the field order the output contract shows: status, reason, then the lists
    return { substring, labeled, all, valueCheck: { status: 'skipped', reason: valueCheck.reason,
      keysChecked: valueCheck.keysChecked, labelChecked: valueCheck.labelChecked, notChecked: valueCheck.notChecked } };
  }
  return { substring, labeled, all, valueCheck };
}

// ── Label vocabulary (Decision A-1, RD-7) ────────────────────────────────────
// Invisible direction/zero-width controls and tatweel are layout, not content:
// removed before any label match so RTL text and letter stretching still match.
const LAYOUT_CHARS_RE = /[ـ​-‏؜‪-‮⁦-⁩﻿]/g;
const normalizeLayout = (s) => String(s).replace(LAYOUT_CHARS_RE, '');
const FILL = '[\\s"\'“”‘’`*_]';
const AR_PHRASE = 'كلمة\\s*(المرور|السر)';  // كلمة (المرور|السر)
const AR_LABEL_BEFORE_VALUE_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])${AR_PHRASE}(?:\\s+\\p{Script=Arabic}+)?${FILL}*[:=]${FILL}*$`, 'u');
const AR_LABEL_IN_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])${AR_PHRASE}(?![\\p{L}\\p{N}])`, 'u');
const ID_BEFORE_VALUE_RE = new RegExp(`([\\p{L}\\p{N}_.\\-]+)${FILL}*[:=]${FILL}*$`, 'u');
const arLabelId = (word) => (word === 'المرور' ? 'ar-password' : 'ar-secret-word');

// Latin identifiers: `password` / `passcode` as substrings; `pass` / `pwd` only as a
// whole word of the identifier (split on _ - . spaces and camelCase).
function latinLabel(id) {
  const low = id.toLowerCase();
  if (low.includes('password')) return 'password';
  if (low.includes('passcode')) return 'passcode';
  const words = id.split(/[_\-.\s]+/)
    .flatMap(w => w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map(w => w.toLowerCase());
  if (words.includes('pass')) return 'pass';
  if (words.includes('pwd')) return 'pwd';
  return null;
}

// The canonical label id carried by an identifier or a JSON key/name — or null.
function labelOf(str) {
  const s = normalizeLayout(str);
  const ar = s.match(AR_LABEL_IN_RE);
  if (ar) return arLabelId(ar[1]);
  return s ? latinLabel(s) : null;
}

// Rule (a): does the text just before a value end in <label><filler>*[:=]<filler>*?
function labelBeforeValue(prefix) {
  const p = normalizeLayout(prefix);
  const ar = p.match(AR_LABEL_BEFORE_VALUE_RE);
  if (ar) return arLabelId(ar[1]);
  const m = p.match(ID_BEFORE_VALUE_RE);
  return m ? latinLabel(m[1]) : null;
}

// No letter or digit (any script — Arabic-Indic digits included) right after the value.
function rightBoundaryOk(text, end) {
  if (end >= text.length) return true;
  return !/[\p{L}\p{N}]/u.test(String.fromCodePoint(text.codePointAt(end)));
}

// ── Position-aware JSON walker (S12/S17) ─────────────────────────────────────
// A small recursive-descent parser that keeps each token's line. Nodes:
//   { type:'object', line, entries:[{ key, keyLine, value }] } · { type:'array', line, items }
//   { type:'string', line, value, raw } · { type:'number', line, raw, value } · { type:'literal', line, raw }
// A parse failure throws a fixed error — Node's own JSON.parse messages quote the input.
function jsonError() { const e = new Error('invalid JSON'); e.code = 'invalid-json'; return e; }

function parseJson(input) {
  const text = stripBom(input);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  function str() {
    const start = i;
    if (text[i] !== '"') throw jsonError();
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) throw jsonError();
    i++;
    const raw = text.slice(start, i);
    let value;
    try { value = JSON.parse(raw); } catch { throw jsonError(); }
    return { type: 'string', line: lineAt(start), value, raw };
  }
  function val() {
    ws();
    const c = text[i];
    const line = lineAt(i);
    if (c === '{') {
      i++; const entries = []; ws();
      if (text[i] === '}') { i++; return { type: 'object', line, entries }; }
      for (;;) {
        ws(); const k = str(); ws();
        if (text[i] !== ':') throw jsonError();
        i++;
        entries.push({ key: k.value, keyLine: k.line, value: val() });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { type: 'object', line, entries }; }
        throw jsonError();
      }
    }
    if (c === '[') {
      i++; const items = []; ws();
      if (text[i] === ']') { i++; return { type: 'array', line, items }; }
      for (;;) {
        items.push(val()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { type: 'array', line, items }; }
        throw jsonError();
      }
    }
    if (c === '"') return str();
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (m && m[0]) { i += m[0].length; return { type: 'number', line, raw: m[0], value: Number(m[0]) }; }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { i += lit.length; return { type: 'literal', line, raw: lit }; }
    }
    throw jsonError();
  }
  const root = val();
  ws();
  if (i !== text.length) throw jsonError();
  return root;
}

function formatPath(segs) {
  let out = '';
  for (const s of segs) out += typeof s === 'number' ? `[${s}]` : (out ? `.${s}` : s);
  return out;
}

function walkValues(node, fn, segs = []) {
  if (node.type === 'object') for (const e of node.entries) walkValues(e.value, fn, [...segs, e.key]);
  else if (node.type === 'array') node.items.forEach((it, k) => walkValues(it, fn, [...segs, k]));
  else fn(node, segs);
}

function walkObjects(node, fn, segs = []) {
  if (node.type === 'object') {
    fn(node, segs);
    for (const e of node.entries) walkObjects(e.value, fn, [...segs, e.key]);
  } else if (node.type === 'array') node.items.forEach((it, k) => walkObjects(it, fn, [...segs, k]));
}

// ── Secret-capable fields (decision #2, RD-4, RD-10, NU-4) ───────────────────
const envVarSuffix = (name) => String(name || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// From every readable copy of config/project.json (working tree + staged): which
// defaults.<k> and users.<h>.<k> fields are secret. defaults.password always is (A-2).
function secretFieldTable(projectConfigs) {
  const defaultsKeys = new Set(['password']);
  const userKeys = new Set();
  for (const cfg of projectConfigs || []) {
    if (!cfg || typeof cfg !== 'object') continue;
    for (const f of Array.isArray(cfg.defaultsFields) ? cfg.defaultsFields : []) {
      if (f && f.secret === true && typeof f.key === 'string') defaultsKeys.add(f.key);
    }
    for (const f of Array.isArray(cfg.userFields) ? cfg.userFields : []) {
      if (f && f.secret === true && typeof f.key === 'string') userKeys.add(f.key);
    }
  }
  return { defaultsKeys, userKeys };
}

// environments/*.json: is this path a secret-capable field? → { field, suggest } | null
function environmentSecretField(table, segs) {
  const field = formatPath(segs);
  if (segs.length === 2 && segs[0] === 'db' && segs[1] === 'password') return { field, suggest: { envSecret: 'SQLCMDPASSWORD' } };
  if (segs.length === 2 && segs[0] === 'api' && segs[1] === 'token') return { field, suggest: { envSecret: 'API_TOKEN' } };
  if (segs.length === 2 && segs[0] === 'defaults' && table.defaultsKeys.has(segs[1])) {
    return { field, suggest: { envSecret: `DEFAULT_${envVarSuffix(segs[1])}` } };
  }
  if (segs.length === 3 && segs[0] === 'users' && typeof segs[1] === 'string' && table.userKeys.has(segs[2])) {
    return { field, suggest: { envSecret: `${envVarSuffix(segs[1])}_${envVarSuffix(segs[2])}` } };
  }
  return null;
}

// ── Remote URL credentials (NU-3 a) ──────────────────────────────────────────
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// An http(s) URL carries a credential when its userinfo has a non-empty password
// part, or a username equal to a known secret value. ssh / scp-style: never.
function remoteHasCredential(url, knownValues) {
  const m = /^https?:\/\//i.exec(String(url || ''));
  if (!m) return false;
  const rest = url.slice(m[0].length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at < 0) return false;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  const user = safeDecode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const pass = colon < 0 ? '' : userinfo.slice(colon + 1);
  if (pass !== '') return true;
  return !!(knownValues && (knownValues.has(user) || knownValues.has(userinfo)));
}

// ── Credential shapes (token-patterns design) ────────────────────────────────
// Public, documented, prefixed credential formats only (invariant #7) — a token
// that is NOT one of the project's own values but has a well-known shape. A match
// is a warning, never a leak on its own. Word boundaries on both sides. Only the
// match position is used: the matched text is never stored, returned or printed.
const SHAPE_LEFT = '(?<![A-Za-z0-9_])';
const SHAPE_RIGHT = '(?![A-Za-z0-9_])';
const shapeRe = (src) => new RegExp(SHAPE_LEFT + '(?:' + src + ')' + SHAPE_RIGHT, 'g');
const SHAPE_PATTERNS = Object.freeze([
  { label: 'private-key-block', re: shapeRe('-----BEGIN (?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----') },
  { label: 'github-token', re: shapeRe('gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}') },
  { label: 'aws-access-key-id', re: shapeRe('(?:AKIA|ASIA)[A-Z0-9]{16}') },
  { label: 'atlassian-api-token', re: shapeRe('ATATT3[A-Za-z0-9_\\-=]{30,}') },
  { label: 'figma-token', re: shapeRe('figd_[A-Za-z0-9_\\-]{30,}') },
].map(Object.freeze));

/**
 * Every credential shape in a text: one { line, pattern } per line and label,
 * sorted by line then label. Never the matched text.
 */
function scanShapes(text) {
  const s = String(text || '');
  const seen = new Set();
  const out = [];
  let idx = null;
  for (const { label, re } of SHAPE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      idx = idx || lineIndex(s);
      const line = idx.lineAt(m.index);
      const id = `${line}\0${label}`;
      if (!seen.has(id)) { seen.add(id); out.push({ line, pattern: label }); }
    }
    re.lastIndex = 0;
  }
  return out.sort((a, b) => a.line - b.line || byName(a.pattern, b.pattern));
}

// The userinfo of an http(s) remote URL as decoded parts — [] when none.
function remoteUserinfoParts(url) {
  const m = /^https?:\/\//i.exec(String(url || ''));
  if (!m) return [];
  const rest = url.slice(m[0].length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at < 0) return [];
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  return (colon < 0 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)])
    .filter(p => p !== '').map(safeDecode);
}

// The shape labels found in a remote URL's userinfo (user or password part), sorted.
function remoteShapes(url) {
  const labels = new Set();
  for (const part of remoteUserinfoParts(url)) for (const f of scanShapes(part)) labels.add(f.pattern);
  return [...labels].sort(byName);
}

// ── The hook-mode confirmation (owner decision #1) ───────────────────────────
// Asked only with --hook, only when nothing is a leak and at least one warning is a
// credential shape. Default No.
function shapeConfirmationNeeded({ hook, findings }) {
  if (!hook || !Array.isArray(findings)) return false;
  if (findings.some(f => f.severity === 'leak')) return false;
  return findings.some(f => f.kind === 'credential-shape');
}

function confirmAnswerIsYes(answer) {
  if (typeof answer !== 'string') return false;
  return /^(?:y|yes)$/i.test(answer.split('\n')[0].trim());
}

// A declined confirmation refuses the commit through the contract installed hooks
// already honour (exit 1 + "result":"LEAK"); counts stay true (zero leaks).
function declinedResult(r) {
  const { tool, schemaVersion, mode, ...rest } = r;
  delete rest.result; delete rest.exit;
  return { tool, schemaVersion, mode, result: 'LEAK', exit: 1, reason: 'declined', ...rest };
}

// ── Binary sniff ─────────────────────────────────────────────────────────────
function isBinary(buf, sniff = DEFAULTS.BINARY_SNIFF_BYTES) {
  return buf.subarray(0, Math.min(buf.length, sniff)).includes(0);
}

// ── Matching ─────────────────────────────────────────────────────────────────
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return {
    starts,
    lineAt(pos) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
      return lo + 1;
    },
  };
}

const LABEL_WINDOW = 256;   // left context examined before a value occurrence

/**
 * Every finding for one text file.
 * @param {{ file, text, needles, fieldKind?: 'environment'|'catalog', fieldTable? }} o
 */
function scanFile({ file, text, needles, fieldKind = null, fieldTable = null }) {
  const leaks = new Map();      // `${line}\0${key}` → finding (dedupe; rank decides)
  const warns = [];
  const rank = { 'secret-value': 3, b: 2, a: 1 };
  const putLeak = (f, r) => {
    const id = `${f.line}\0${f.key}`;
    const cur = leaks.get(id);
    if (!cur || r > cur.r || (r === cur.r && f.field && !cur.f.field)) leaks.set(id, { f, r });
  };
  let lines = null;
  const idx = lineIndex(text);

  // secret-value: whole-text prefilter per needle, then the line split
  for (const n of needles.substring) {
    if (!text.includes(n.value)) continue;
    lines = lines || text.split(/\r?\n/);
    lines.forEach((l, k) => {
      if (l.includes(n.value)) putLeak({ severity: 'leak', kind: 'secret-value', file, line: k + 1, key: n.key }, rank['secret-value']);
    });
  }

  // JSON: parse once for the field checks and rule (b)
  let root = null;
  if (/\.json$/i.test(file)) {
    try { root = parseJson(text); }
    catch { if (fieldKind) warns.push({ severity: 'warn', kind: 'unparseable-config', file }); }
  }

  if (root && fieldKind) {
    const known = new Map(needles.all.map(n => [n.value, n.key]));
    walkValues(root, (node, segs) => {
      if (node.type !== 'string') return;
      let hit = null;
      if (fieldKind === 'environment') {
        if (node.value === '') return;
        hit = environmentSecretField(fieldTable || secretFieldTable([]), segs);
      } else if (fieldKind === 'catalog') {
        const key = segs[segs.length - 1];
        if (typeof key === 'string' && key.length > 3 && key.endsWith('Env') && !ENV_NAME_RE.test(node.value)) {
          hit = { field: formatPath(segs), suggest: { [key]: envVarSuffix(key.slice(0, -3)) } };
        }
      }
      if (!hit) return;
      if (known.has(node.value)) {
        putLeak({ severity: 'leak', kind: 'secret-value', file, line: node.line, key: known.get(node.value), field: hit.field }, rank['secret-value']);
      } else if (node.value !== '') {
        warns.push({ severity: 'warn', kind: 'plain-secret-field', file, line: node.line, field: hit.field, suggest: hit.suggest });
      }
    });
  }

  if (needles.labeled.length) {
    const shortByValue = new Map(needles.labeled.map(n => [n.value, n]));
    // rule (b): structural JSON
    if (root) {
      const check = (node, label, segs) => {
        if (!node || (node.type !== 'string' && node.type !== 'number')) return;
        const v = node.type === 'string' ? node.value : node.raw;
        const n = shortByValue.get(v);
        if (n) putLeak({ severity: 'leak', kind: 'short-value-labeled', file, line: node.line, key: n.key, label, field: formatPath(segs) }, rank.b);
      };
      walkObjects(root, (obj, segs) => {
        for (const e of obj.entries) {
          const label = labelOf(e.key);
          if (label) check(e.value, label, [...segs, e.key]);
        }
        for (const sib of ['key', 'name', 'id']) {
          const s = obj.entries.find(e => e.key === sib);
          if (!s || s.value.type !== 'string') continue;
          const label = labelOf(s.value.value);
          if (!label) continue;
          for (const target of ['default', 'value']) {
            const t = obj.entries.find(e => e.key === target);
            if (t) check(t.value, label, [...segs, target]);
          }
        }
      });
    }
    // rule (a): text — value first, then context
    for (const n of needles.labeled) {
      let i = text.indexOf(n.value);
      while (i >= 0) {
        if (rightBoundaryOk(text, i + n.value.length)) {
          const line = idx.lineAt(i);
          const from = Math.max(idx.starts[line - 1], i - LABEL_WINDOW);
          const label = labelBeforeValue(text.slice(from, i));
          if (label) putLeak({ severity: 'leak', kind: 'short-value-labeled', file, line, key: n.key, label }, rank.a);
        }
        i = text.indexOf(n.value, i + 1);
      }
    }
  }

  // credential shapes: every file, both modes, with or without .env needles
  for (const s of scanShapes(text)) warns.push({ severity: 'warn', kind: 'credential-shape', file, line: s.line, pattern: s.pattern });

  const out = [...leaks.values()].map(x => x.f).sort((a, b) => a.line - b.line || byName(a.key, b.key));
  return out.concat(warns);
}

// ── Result object (output contract R2.6) ─────────────────────────────────────
function buildResult({ mode, valueCheck, counts, findings, maxFindings = DEFAULTS.MAX_FINDINGS }) {
  const leaks = findings.filter(f => f.severity === 'leak').length;
  const warnings = findings.filter(f => f.severity === 'warn').length;
  const ordered = findings.filter(f => f.severity === 'leak').concat(findings.filter(f => f.severity !== 'leak'));
  const result = leaks ? 'LEAK' : warnings ? 'WARN' : 'CLEAN';
  return {
    tool: 'agentex-secret-scan', schemaVersion: 1, mode, result, exit: leaks ? 1 : 0,
    valueCheck,
    counts: { ...counts, leaks, warnings },
    findings: ordered.slice(0, maxFindings),
    findingsTruncated: Math.max(0, ordered.length - maxFindings),
  };
}

function errorResult(mode, code, message) {
  return { tool: 'agentex-secret-scan', schemaVersion: 1, mode: mode || null, result: 'ERROR', exit: 2, error: code, message };
}

module.exports = {
  DEFAULTS, NON_SECRET_ENV_KEYS, ADO_NON_SECRET_FALLBACKS, BASE_URL_KEY_RE,
  enumerateEnvKeys, canonicalSecretNames, buildNeedles, collectEnvSecretNames,
  labelOf, labelBeforeValue, rightBoundaryOk,
  parseJson, formatPath, walkValues, walkObjects,
  secretFieldTable, environmentSecretField,
  remoteHasCredential, isBinary,
  SHAPE_PATTERNS, scanShapes, remoteShapes,
  shapeConfirmationNeeded, confirmAnswerIsYes, declinedResult,
  scanFile, buildResult, errorResult,
};
