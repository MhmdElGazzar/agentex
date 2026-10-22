'use strict';
// AgenTeX suite studio — the two local stores (both already gitignored by the scaffold):
//   .agentex/cache/api-data/<suite>.json      collected values + provenance, consents, missing
//                                              values and a token REFERENCE (schemaVersion 1)
//   test/.auth/api-tokens/<store>-<env>.json  the captured token itself (mode 0600) — the only
//                                              file that ever holds the value
// Before writing, `git check-ignore -q` must say the path is ignored; a path that is not is
// refused (A17: run /update-agentex). No git, or not a git repository → treated as ignored:
// nothing can be committed by accident there.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOKEN_REF_KEYS = ['ref', 'user', 'source', 'capturedAt'];

function checkSlug(s, what) {
  if (typeof s !== 'string' || !SLUG_RE.test(s) || s.includes('..')) throw new Error(`invalid ${what}: ${JSON.stringify(s)}`);
  return s;
}
const storeRel = suite => `.agentex/cache/api-data/${checkSlug(suite, 'suite name')}.json`;
const tokenRel = (store, env) => `test/.auth/api-tokens/${checkSlug(store, 'token store')}-${checkSlug(env, 'environment')}.json`;

function isIgnored(root, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'ignore', windowsHide: true });
  if (r.error) return true;          // git not installed
  if (r.status === 0) return true;   // ignored
  if (r.status === 1) return false;  // tracked-able: refuse
  return true;                       // 128: not a repository
}

function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readStore(root, suite) { return readJson(path.join(root, storeRel(suite))); }
function writeStore(root, suite, data) {
  const rel = storeRel(suite);
  if (!isIgnored(root, rel)) return { ok: false, error: 'not-ignored', path: rel };
  const clean = { schemaVersion: SCHEMA_VERSION, ...data };
  delete clean.password;
  if (clean.token && typeof clean.token === 'object') {
    clean.token = Object.fromEntries(TOKEN_REF_KEYS.filter(k => clean.token[k] !== undefined).map(k => [k, clean.token[k]]));
  } else delete clean.token;
  clean.schemaVersion = SCHEMA_VERSION;
  writeAtomic(path.join(root, rel), JSON.stringify(clean, null, 2) + '\n');
  return { ok: true, path: rel };
}

// expiresAt from a JWT "exp", decoded locally; null for anything that is not a JWT.
function jwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
}

function writeToken(root, rec) {
  const rel = tokenRel(rec.store, rec.environment);
  if (!isIgnored(root, rel)) return { ok: false, error: 'not-ignored', path: rel };
  const expiresAt = jwtExpiry(rec.token);
  const out = {
    schemaVersion: SCHEMA_VERSION, store: rec.store, environment: rec.environment, user: rec.user || null,
    scheme: rec.scheme || 'bearer', headerName: rec.headerName || 'Authorization', token: rec.token,
    capturedAt: rec.capturedAt || new Date().toISOString(), ...(expiresAt ? { expiresAt } : {}),
  };
  writeAtomic(path.join(root, rel), JSON.stringify(out, null, 2) + '\n', 0o600);
  return { ok: true, path: rel, ref: `${rec.store}-${rec.environment}` };
}
// Owner and time only — never the value.
function readTokenMeta(root, store, env) {
  const rec = readJson(path.join(root, tokenRel(store, env)));
  if (!rec) return null;
  return { ref: `${store}-${env}`, store, environment: env, user: rec.user || null, scheme: rec.scheme, capturedAt: rec.capturedAt || null, expiresAt: rec.expiresAt || null };
}

module.exports = { SCHEMA_VERSION, storeRel, tokenRel, isIgnored, readStore, writeStore, writeToken, readTokenMeta, jwtExpiry, writeAtomic };
