// AgenTeX API runner — executes ONE cataloged API request deterministically.
// The catalog is the authorization: only entries defined in <catalog>/**/*_api.json can run
// (searched recursively, so both flat and integration/api_test_suites/<name>/-nested catalogs work).
//
// Usage:
//   node run_api.js --entry <file-name>.<request-name> [--param k=v ...]
//     [--expect-status 200] [--expect-field dot.path] [--expect-equals dot.path=value]
//     [--expect-contains dot.path=text] [--no-auth] [--omit <param> ...]
//     [--env <environment-name>] [--catalog ./integration] --log <path>
//
// --no-auth sends no credential at all: the environment's api token and the catalog's auth are
// both ignored (an unset token var is then not BLOCKED). --expect-contains passes when the
// field's text includes the given text. --omit <p> sends the request without param p: a query
// param is dropped from the URL, a typed body node's key (or array element) is removed; a path
// param, an undeclared name, or a param inside a legacy "{p}" body string is BLOCKED.
// Typed body nodes: {"$param": "<name>", "type": "string|integer|number|boolean|json"} anywhere
// in "body" take the param's value coerced to that type; such a param is body-only.
// auth.tokenStore (bearer/apiKey only): when tokenEnv is unset, the token is read from
// test/.auth/api-tokens/<tokenStore>-<env>.json for the resolved environment; missing →
// BLOCKED reasonCode "token-missing", past its expiresAt / JWT exp → "token-expired".
// Every credential value sent is replaced by "[redacted]" in the log and the printed JSON.
//
// A declared param whose name appears as a `{name}` path placeholder is substituted into the
// path; a param listed in the request's optional "query": [..] array is sent in the query
// string; a param used only as a `{name}` placeholder in the body stays in the body; a param
// referenced nowhere in the request template falls back to the query string.
// auth.type: "bearer" | "basic" | "apiKey" (custom header, e.g. X-API-Key) | "none".
// Catalog "target" (optional, top level) decides who owns the base URL and auth: "catalog" →
// the catalog's own baseUrl refs and auth, the environment's api block ignored (swagger-import
// writes it); "environment" → the active environment's api block; absent → the environment's
// api block only when the catalog's baseUrl is absent/empty or exactly "${API_BASE_URL}".
//
// Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...} (PASS/FAIL carry "ms", BLOCKED may
// carry "reasonCode"). Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
// Secrets: env values (tokens) are used for the request but never printed or logged.
const fs = require('fs');
const path = require('path');

// Credential values this run sends; replaced in everything written or printed (A16). Values
// shorter than REDACT_MIN_LEN are not redacted (they would shred unrelated text). (Q8)
const REDACT_MIN_LEN = 4;
const sentSecrets = [];
function addSecret(v) { if (typeof v === 'string' && v.length >= REDACT_MIN_LEN && !sentSecrets.includes(v)) sentSecrets.push(v); }
function redact(text) {
  let t = String(text);
  for (const sec of [...sentSecrets].sort((a, b) => b.length - a.length)) t = t.split(sec).join('[redacted]');
  return t;
}
function out(obj, code) { console.log(redact(JSON.stringify(obj))); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }
// After a fetch, force-exiting crashes libuv on Windows (open undici handles).
// Print, set the exit code, and let the event loop drain instead.
function outAsync(obj, code) { console.log(redact(JSON.stringify(obj))); process.exitCode = code; }

// ---- args ----
const args = process.argv.slice(2);
const params = {};
let entry, logPath, catalog = './integration', expectStatus, expectFields = [], expectEquals = [], expectContains = [], envName, noAuth = false;
const omit = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--entry') entry = v();
  else if (a === '--param') { const p = v(); const eq = p.indexOf('='); params[p.slice(0, eq)] = p.slice(eq + 1); }
  else if (a === '--expect-status') expectStatus = parseInt(v(), 10);
  else if (a === '--expect-field') expectFields.push(v());
  else if (a === '--expect-equals') { const p = v(); const eq = p.indexOf('='); expectEquals.push([p.slice(0, eq), p.slice(eq + 1)]); }
  else if (a === '--expect-contains') { const p = v(); const eq = p.indexOf('='); expectContains.push([p.slice(0, eq), p.slice(eq + 1)]); }
  else if (a === '--no-auth') noAuth = true;
  else if (a === '--omit') omit.push(v());
  else if (a === '--env') envName = v();
  else if (a === '--catalog') catalog = v();
  else if (a === '--log') logPath = v();
}
if (!entry || !logPath) blocked('usage: --entry <file>.<request> --log <path> required');
const dot = entry.indexOf('.');
if (dot < 1) blocked('entry must be <file-name>.<request-name>');
const fileName = entry.slice(0, dot), reqName = entry.slice(dot + 1);

// ---- catalog resolution (allowlist: only defined entries can run) ----
// Recursive: catalogs may sit flat in <catalog>/ (hand-written, api-integration convention) or
// nested under <catalog>/api_test_suites/<name>/ (swagger-import output, co-located with its suite).
if (!fs.existsSync(catalog)) blocked(`catalog folder not found: ${catalog} — scaffold it and define your requests first`);
// node_modules and dot-directories (.git, .cache, …) are never searched.
function findApiFiles(dir) {
  let found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found = found.concat(findApiFiles(full));
    }
    else if (entry.isFile() && entry.name.endsWith('_api.json')) found.push(full);
  }
  return found;
}
const files = findApiFiles(catalog).sort();
const matches = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
  if (j.name === fileName) matches.push({ file: f, def: j });
}
// Two catalogs claiming the same "name" is ambiguous — never silently pick one.
if (matches.length > 1) blocked(`catalog name "${fileName}" is declared by ${matches.length} files (${matches.map(m => m.file).join(', ')}) — rename one so each catalog "name" is unique`);
const def = matches.length ? matches[0].def : null;
const defFile = matches.length ? matches[0].file : null;
if (!def) blocked(`no *_api.json under ${catalog} has "name": "${fileName}" — define it before this step can run`);
const TARGETS = ['environment', 'catalog'];
if (def.target !== undefined && !TARGETS.includes(def.target)) {
  blocked(`catalog "${fileName}" (${defFile}) has "target": ${JSON.stringify(def.target)} — allowed values: "catalog" (the catalog's own baseUrl and auth) or "environment" (the active environment's api block); leave it out and a catalog whose baseUrl is absent or exactly "\${API_BASE_URL}" follows the environment, any other keeps its own`);
}
const req = (def.requests || []).find(r => r.name === reqName);
if (!req) blocked(`request "${reqName}" is not defined in catalog "${fileName}" — add it to run this step`);

// ---- params: only declared placeholders, all values present ----
const declared = req.params || [];
for (const k of Object.keys(params)) if (!declared.includes(k)) blocked(`param "${k}" is not declared for ${entry} (declared: ${declared.join(', ') || 'none'})`);
for (const k of omit) if (!declared.includes(k)) blocked(`cannot omit "${k}": param "${k}" is not declared for ${entry} (declared: ${declared.join(', ') || 'none'})`);
for (const k of omit) if ((req.path || '').includes(`{${k}}`)) blocked(`cannot omit "${k}": it is a path parameter`);
for (const k of omit) if (req.body !== undefined && JSON.stringify(req.body).includes(`{${k}}`)) blocked(`cannot omit "${k}": it is used inside a body string template`);
for (const k of omit) delete params[k]; // an omitted param's value, if any, is ignored
for (const k of declared) if (!omit.includes(k) && !(k in params)) blocked(`missing value for declared param "${k}"`);

// ---- typed body nodes: {"$param": name, "type": ...} ----
const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'json'];
const isParamNode = n => n && typeof n === 'object' && !Array.isArray(n) && typeof n.$param === 'string';
const bodyParamNames = new Set();
(function collect(n) {
  if (isParamNode(n)) {
    if (!declared.includes(n.$param)) blocked(`$param "${n.$param}" in the body of ${entry} is not a declared param (declared: ${declared.join(', ') || 'none'})`);
    if (n.type !== undefined && !PARAM_TYPES.includes(n.type)) blocked(`$param "${n.$param}" in the body of ${entry} has type ${JSON.stringify(n.type)} — allowed: ${PARAM_TYPES.join(', ')}`);
    bodyParamNames.add(n.$param);
    return;
  }
  if (n && typeof n === 'object') for (const v of Object.values(n)) collect(v);
})(req.body);
function coerce(name, raw, type) {
  const bad = () => blocked(`param "${name}" = "${raw}" is not a valid ${type}`);
  switch (type || 'string') {
    case 'integer': if (!/^-?\d+$/.test(raw.trim())) bad(); return parseInt(raw, 10);
    case 'number': { const x = Number(raw); if (raw.trim() === '' || !Number.isFinite(x)) bad(); return x; }
    case 'boolean': if (raw !== 'true' && raw !== 'false') bad(); return raw === 'true';
    case 'json': try { return JSON.parse(raw); } catch { return bad(); }
    default: return raw;
  }
}
const OMITTED = Symbol('omitted');
function fillNodes(n) {
  if (isParamNode(n)) return omit.includes(n.$param) ? OMITTED : coerce(n.$param, params[n.$param], n.type);
  if (Array.isArray(n)) return n.map(fillNodes).filter(v => v !== OMITTED);
  if (n && typeof n === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(n)) { const f = fillNodes(v); if (f !== OMITTED) o[k] = f; }
    return o;
  }
  return n;
}

// ---- target: the environment's api block or the catalog's own baseUrl/auth (one rule below) ----
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
// Catalog-named vars resolve like every other secret: process env, then the project's .env.
const envVar = (name) => pc.readEnvVar(process.cwd(), name);
function resolveEnvRefs(s) {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = envVar(name);
    if (!v) blocked(`env var ${name} is not set in .env or the environment (referenced by catalog "${fileName}")`);
    return v;
  });
}
// The environment's api block (baseUrl + token) targets the PROJECT's own API. Does it apply
// to this catalog? An explicit "target" wins; without one, the catalog's baseUrl decides:
//   1. "target": "catalog"     → no: the catalog's own baseUrl refs and auth (swagger-import).
//   2. "target": "environment" → yes, whatever the baseUrl — the escape hatch for a hand-written
//                                catalog whose baseUrl uses another variable but should still
//                                follow --env.
//   3. no "target"             → yes only for an absent/empty baseUrl or exactly the project
//                                default "${API_BASE_URL}"; any other baseUrl (e.g. an imported
//                                "${PETSTORE_BASE_URL}") keeps its own baseUrl AND auth — the
//                                app's token is never sent to another host.
// (Any other "target" value was BLOCKED above.)
const PROJECT_DEFAULT_BASE_URL = '${API_BASE_URL}';
function environmentOwnsTarget(catalogDef) {
  if (catalogDef.target === 'catalog') return false;
  if (catalogDef.target === 'environment') return true;
  const base = typeof catalogDef.baseUrl === 'string' ? catalogDef.baseUrl.trim() : '';
  return base === '' || base === PROJECT_DEFAULT_BASE_URL;
}
let target = null;
// Resolved for every catalog, so an unknown --env is BLOCKED whatever the rule decides; an
// environment without an api block leaves the catalog's own refs and auth (legacy fallback).
try { target = pc.resolveApiTarget(process.cwd(), envName); }
catch (e) { blocked(e.message); }
if (!environmentOwnsTarget(def)) target = null; // drops base URL and token both
if (noAuth && target) target = { ...target, token: null, hasToken: false }; // --no-auth: no credential at all
if (target && target.hasToken && !target.token) blocked(`${target.tokenHint} (api token) is not set`);
const baseUrl = target ? target.baseUrl : resolveEnvRefs(def.baseUrl || '');
// Param placement (order matters):
//   1. `{k}` in the path            → substituted into the path
//   2. k listed in req.query        → query string (explicit; swagger-import writes this)
//   3. `{k}` in the body template   → body only (never leaks into the URL)
//   4. referenced nowhere           → query string (backward-compat fallback)
const queryList = req.query === undefined ? [] : req.query;
if (!Array.isArray(queryList)) blocked(`"query" of ${entry} must be an array of param names`);
for (const k of queryList) if (!declared.includes(k)) blocked(`query param "${k}" of ${entry} is not declared in "params" (declared: ${declared.join(', ') || 'none'})`);
const bodyTemplate = req.body === undefined ? '' : JSON.stringify(req.body);
let urlPath = req.path || '';
const queryParams = [];
for (const [k, v] of Object.entries(params)) {
  const placeholder = `{${k}}`;
  const inPath = urlPath.includes(placeholder);
  if (inPath) urlPath = urlPath.split(placeholder).join(encodeURIComponent(v));
  if (queryList.includes(k) || (!inPath && !bodyTemplate.includes(placeholder) && !bodyParamNames.has(k))) queryParams.push([k, v]);
}
const unresolved = urlPath.match(/\{[a-zA-Z0-9_]+\}/);
if (unresolved) blocked(`unresolved placeholder ${unresolved[0]} in path`);
const query = queryParams.length ? '?' + queryParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
const url = baseUrl.replace(/\/$/, '') + urlPath + query;

const headers = { 'Accept': 'application/json' };
const auth = noAuth ? { type: 'none' } : (def.auth || { type: 'none' });
// A captured token (auth.tokenStore): used only when tokenEnv resolves to nothing (A7).
function storedToken(kind) {
  const tokenEnvName = auth.tokenEnv || 'the token env var';
  let environment;
  try { environment = pc.loadEnvironment(process.cwd(), envName); } catch (e) { blocked(e.message); }
  if (!environment) blocked(`catalog "${fileName}" uses a captured token, which needs an environment — pass --env or set defaultEnvironment`);
  const store = String(auth.tokenStore);
  const file = path.join(process.cwd(), 'test', '.auth', 'api-tokens', `${store}-${environment.name}.json`);
  const missing = () => blocked(`no token for ${store} on "${environment.name}": set ${tokenEnvName} in .env, or ask the agent in chat to capture the token again`, { reasonCode: 'token-missing' });
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { missing(); }
  if (!rec || typeof rec.token !== 'string' || !rec.token) missing();
  let tok = rec.token;
  if (kind === 'bearer') tok = tok.replace(/^Bearer\s+/i, '');
  let expMs = rec.expiresAt ? Date.parse(rec.expiresAt) : NaN;
  if (Number.isNaN(expMs)) {
    // JWT "exp", decoded locally — the token itself is never printed.
    const parts = tok.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (typeof payload.exp === 'number') expMs = payload.exp * 1000;
      } catch { /* not a JWT */ }
    }
  }
  if (!Number.isNaN(expMs) && expMs <= Date.now()) {
    blocked(`captured token for ${store} on "${environment.name}" expired at ${new Date(expMs).toISOString()} — ask the agent in chat to capture it again, or set ${tokenEnvName} in .env`, { reasonCode: 'token-expired' });
  }
  return tok;
}
if (auth.tokenStore !== undefined && auth.type !== 'bearer' && auth.type !== 'apiKey') {
  blocked(`catalog "${fileName}" (${defFile}) sets auth.tokenStore on auth type ${JSON.stringify(auth.type)} — auth.tokenStore works with "bearer" or "apiKey" only`, { reasonCode: 'bad-auth-field' });
}
if (target && target.token) {
  addSecret(target.token);
  headers['Authorization'] = `Bearer ${target.token}`; // environment token wins
} else if (auth.type === 'bearer') {
  let tok = auth.tokenEnv ? envVar(auth.tokenEnv) : null;
  if (!tok && auth.tokenStore !== undefined) tok = storedToken('bearer');
  if (!tok) blocked(`env var ${auth.tokenEnv} (bearer token) is not set in .env or the environment`);
  addSecret(tok);
  headers['Authorization'] = `Bearer ${tok}`;
} else if (auth.type === 'basic') {
  const u = envVar(auth.userEnv), p = envVar(auth.passEnv);
  if (!u || !p) blocked(`env vars ${auth.userEnv}/${auth.passEnv} (basic auth) are not set in .env or the environment`);
  const blob = Buffer.from(`${u}:${p}`).toString('base64');
  addSecret(p); addSecret(blob);
  headers['Authorization'] = 'Basic ' + blob;
} else if (auth.type === 'apiKey') {
  let tok = auth.tokenEnv ? envVar(auth.tokenEnv) : null;
  if (!tok && auth.tokenStore !== undefined) tok = storedToken('apiKey');
  if (!tok) blocked(`env var ${auth.tokenEnv} (apiKey) is not set in .env or the environment`);
  addSecret(tok);
  headers[auth.headerName] = tok;
}

let body;
if (req.body !== undefined) {
  let raw = JSON.stringify(req.body);
  for (const [k, v] of Object.entries(params)) raw = raw.split(`{${k}}`).join(JSON.stringify(String(v)).slice(1, -1));
  if (bodyParamNames.size) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { blocked(`body of ${entry} is not valid JSON after substituting params: ${e.message}`); }
    raw = JSON.stringify(fillNodes(parsed));
  }
  body = raw;
  headers['Content-Type'] = 'application/json';
}

// ---- execute ----
(async () => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  let res, text;
  const started = Date.now();
  try {
    res = await fetch(url, { method: req.method || 'GET', headers, body, signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, redact(`${req.method || 'GET'} ${url}\nREQUEST FAILED: ${e.message}\n`));
    outAsync({ result: 'FAIL', reason: `request failed: ${e.message}`, log: logPath, ms: Date.now() - started }, 1);
    return;
  } finally { clearTimeout(t); }
  const ms = Date.now() - started;

  // evidence log: request line (no auth header values), response status/headers/body
  const respHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, redact(`${req.method || 'GET'} ${url}\n\nHTTP_STATUS:${res.status}\n${respHeaders}\n\n${text}\n`));

  // ---- assertions ----
  const failures = [];
  if (expectStatus !== undefined && res.status !== expectStatus) failures.push(`status ${res.status} != expected ${expectStatus}`);
  if (expectFields.length || expectEquals.length || expectContains.length) {
    let json;
    try { json = JSON.parse(text); } catch { failures.push('response body is not valid JSON'); }
    const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    if (json !== undefined) {
      for (const f of expectFields) if (get(json, f) === undefined) failures.push(`field "${f}" missing in response`);
      for (const [p, v] of expectEquals) { const actual = get(json, p); if (String(actual) !== v) failures.push(`field "${p}" = ${JSON.stringify(actual)} != expected "${v}"`); }
      for (const [p, v] of expectContains) {
        const actual = get(json, p);
        if (actual === undefined) failures.push(`field "${p}" missing in response (expected it to contain "${v}")`);
        else if (!(typeof actual === 'string' ? actual : JSON.stringify(actual)).includes(v)) failures.push(`field "${p}" = ${JSON.stringify(actual)} does not contain "${v}"`);
      }
    }
  }
  if (failures.length) { outAsync({ result: 'FAIL', status: res.status, failures, log: logPath, ms }, 1); return; }
  outAsync({ result: 'PASS', status: res.status, log: logPath, ms }, 0);
})();
