// AgenTeX API runner — executes ONE cataloged API request deterministically.
// The catalog is the authorization: only entries defined in <catalog>/**/*_api.json can run
// (searched recursively, so both flat and integration/api_test_suites/<name>/-nested catalogs work).
//
// Usage:
//   node run_api.js --entry <file-name>.<request-name> [--param k=v ...]
//     [--expect-status 200] [--expect-field dot.path] [--expect-equals dot.path=value]
//     [--catalog ./integration] --log <path>
//
// A declared param whose name appears as a `{name}` path placeholder is substituted into the
// path; any other declared param is sent as a URL query string param instead.
// auth.type: "bearer" | "basic" | "apiKey" (custom header, e.g. X-API-Key) | "none".
//
// Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}. Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
// Secrets: env values (tokens) are used for the request but never printed or logged.
const fs = require('fs');
const path = require('path');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }
// After a fetch, force-exiting crashes libuv on Windows (open undici handles).
// Print, set the exit code, and let the event loop drain instead.
function outAsync(obj, code) { console.log(JSON.stringify(obj)); process.exitCode = code; }

// ---- args ----
const args = process.argv.slice(2);
const params = {};
let entry, logPath, catalog = './integration', expectStatus, expectFields = [], expectEquals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--entry') entry = v();
  else if (a === '--param') { const p = v(); const eq = p.indexOf('='); params[p.slice(0, eq)] = p.slice(eq + 1); }
  else if (a === '--expect-status') expectStatus = parseInt(v(), 10);
  else if (a === '--expect-field') expectFields.push(v());
  else if (a === '--expect-equals') { const p = v(); const eq = p.indexOf('='); expectEquals.push([p.slice(0, eq), p.slice(eq + 1)]); }
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
function findApiFiles(dir) {
  let found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(findApiFiles(full));
    else if (entry.isFile() && entry.name.endsWith('_api.json')) found.push(full);
  }
  return found;
}
const files = findApiFiles(catalog);
let def = null;
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.name === fileName) { def = j; break; }
  } catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
}
if (!def) blocked(`no *_api.json under ${catalog} has "name": "${fileName}" — define it before this step can run`);
const req = (def.requests || []).find(r => r.name === reqName);
if (!req) blocked(`request "${reqName}" is not defined in catalog "${fileName}" — add it to run this step`);

// ---- params: only declared placeholders, all values present ----
const declared = req.params || [];
for (const k of Object.keys(params)) if (!declared.includes(k)) blocked(`param "${k}" is not declared for ${entry} (declared: ${declared.join(', ') || 'none'})`);
for (const k of declared) if (!(k in params)) blocked(`missing value for declared param "${k}"`);

// ---- env resolution (values never printed) ----
function resolveEnvRefs(s) {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    if (!process.env[name]) blocked(`env var ${name} is not set (referenced by catalog "${fileName}")`);
    return process.env[name];
  });
}
const baseUrl = resolveEnvRefs(def.baseUrl || '');
let urlPath = req.path || '';
const queryParams = [];
for (const [k, v] of Object.entries(params)) {
  const placeholder = `{${k}}`;
  if (urlPath.includes(placeholder)) urlPath = urlPath.split(placeholder).join(encodeURIComponent(v));
  else queryParams.push([k, v]);
}
const unresolved = urlPath.match(/\{[a-zA-Z0-9_]+\}/);
if (unresolved) blocked(`unresolved placeholder ${unresolved[0]} in path`);
// declared params not consumed by a path placeholder are sent as query string params
const query = queryParams.length ? '?' + queryParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
const url = baseUrl.replace(/\/$/, '') + urlPath + query;

const headers = { 'Accept': 'application/json' };
const auth = def.auth || { type: 'none' };
if (auth.type === 'bearer') {
  const tok = process.env[auth.tokenEnv];
  if (!tok) blocked(`env var ${auth.tokenEnv} (bearer token) is not set`);
  headers['Authorization'] = `Bearer ${tok}`;
} else if (auth.type === 'basic') {
  const u = process.env[auth.userEnv], p = process.env[auth.passEnv];
  if (!u || !p) blocked(`env vars ${auth.userEnv}/${auth.passEnv} (basic auth) are not set`);
  headers['Authorization'] = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
} else if (auth.type === 'apiKey') {
  const tok = process.env[auth.tokenEnv];
  if (!tok) blocked(`env var ${auth.tokenEnv} (apiKey) is not set`);
  headers[auth.headerName] = tok;
}

let body;
if (req.body !== undefined) {
  let raw = JSON.stringify(req.body);
  for (const [k, v] of Object.entries(params)) raw = raw.split(`{${k}}`).join(v.replace(/"/g, '\\"'));
  body = raw;
  headers['Content-Type'] = 'application/json';
}

// ---- execute ----
(async () => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  let res, text;
  try {
    res = await fetch(url, { method: req.method || 'GET', headers, body, signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `${req.method || 'GET'} ${url}\nREQUEST FAILED: ${e.message}\n`);
    outAsync({ result: 'FAIL', reason: `request failed: ${e.message}`, log: logPath }, 1);
    return;
  } finally { clearTimeout(t); }

  // evidence log: request line (no auth header values), response status/headers/body
  const respHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${req.method || 'GET'} ${url}\n\nHTTP_STATUS:${res.status}\n${respHeaders}\n\n${text}\n`);

  // ---- assertions ----
  const failures = [];
  if (expectStatus !== undefined && res.status !== expectStatus) failures.push(`status ${res.status} != expected ${expectStatus}`);
  if (expectFields.length || expectEquals.length) {
    let json;
    try { json = JSON.parse(text); } catch { failures.push('response body is not valid JSON'); }
    const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    if (json !== undefined) {
      for (const f of expectFields) if (get(json, f) === undefined) failures.push(`field "${f}" missing in response`);
      for (const [p, v] of expectEquals) { const actual = get(json, p); if (String(actual) !== v) failures.push(`field "${p}" = ${JSON.stringify(actual)} != expected "${v}"`); }
    }
  }
  if (failures.length) { outAsync({ result: 'FAIL', status: res.status, failures, log: logPath }, 1); return; }
  outAsync({ result: 'PASS', status: res.status, log: logPath }, 0);
})();
