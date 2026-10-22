'use strict';
// AgenTeX field-feedback sanitizer (field-feedback-loop; spec appendix A4).
//
// S-1 ships layer 1 only: the secret layer capture needs (the redaction is the same
// code the export will run, so it is written once, here). S-2 adds layers 2-4 and
// sanitizeEntry.
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
// Pure apart from loadSecretContext's reads. No process spawning, no network. Values
// live in memory only; nothing here ever prints one.
const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { loadSecretContext, secretSpans, redactSecrets, configFiles };
