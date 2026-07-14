// AgenTeX DB runner — executes ONE cataloged SQL Server query deterministically via sqlcmd.
// The catalog is the authorization: only queries defined in <catalog>/*_db.json can run.
// DDL (DROP/TRUNCATE/ALTER) is refused even if cataloged. Password only via SQLCMDPASSWORD.
//
// Usage:
//   node run_db.js --entry <file-name>.<query-name> [--param k=v ...]
//     [--expect-rows N] [--expect-min-rows N] [--catalog ./integration] --log <path>
//
// Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}. Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }

// ---- args ----
const args = process.argv.slice(2);
const params = {};
let entry, logPath, catalog = './integration', expectRows, expectMinRows;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--entry') entry = v();
  else if (a === '--param') { const p = v(); const eq = p.indexOf('='); params[p.slice(0, eq)] = p.slice(eq + 1); }
  else if (a === '--expect-rows') expectRows = parseInt(v(), 10);
  else if (a === '--expect-min-rows') expectMinRows = parseInt(v(), 10);
  else if (a === '--catalog') catalog = v();
  else if (a === '--log') logPath = v();
}
if (!entry || !logPath) blocked('usage: --entry <file>.<query> --log <path> required');
const dot = entry.indexOf('.');
if (dot < 1) blocked('entry must be <file-name>.<query-name>');
const fileName = entry.slice(0, dot), qName = entry.slice(dot + 1);

// ---- catalog resolution (allowlist) ----
if (!fs.existsSync(catalog)) blocked(`catalog folder not found: ${catalog} — scaffold it and define your queries first`);
const files = fs.readdirSync(catalog).filter(f => f.endsWith('_db.json'));
let def = null;
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(catalog, f), 'utf8'));
    if (j.name === fileName) { def = j; break; }
  } catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
}
if (!def) blocked(`no *_db.json in ${catalog} has "name": "${fileName}" — define it before this step can run`);
const q = (def.queries || []).find(x => x.name === qName);
if (!q) blocked(`query "${qName}" is not defined in catalog "${fileName}" — add it to run this step`);

// ---- DDL ban (absolute — even if cataloged) ----
if (/\b(drop|truncate|alter)\b/i.test(q.query)) blocked(`query "${qName}" contains DDL (DROP/TRUNCATE/ALTER) — refused; fix the catalog entry`);

// ---- params: declared-only, sanitized, quote-escaped ----
const declared = q.params || [];
for (const k of Object.keys(params)) if (!declared.includes(k)) blocked(`param "${k}" is not declared for ${entry} (declared: ${declared.join(', ') || 'none'})`);
for (const k of declared) if (!(k in params)) blocked(`missing value for declared param "${k}"`);
let sql = q.query;
for (const [k, v] of Object.entries(params)) {
  if (/[;\r\n]|--|\/\*/.test(v)) blocked(`param "${k}" value contains forbidden characters (;, --, /*, newline) — surface it to the user`);
  sql = sql.split(`{${k}}`).join(v.replace(/'/g, "''"));
}
const unresolved = sql.match(/\{[a-zA-Z0-9_]+\}/);
if (unresolved) blocked(`unresolved placeholder ${unresolved[0]} in query`);

// ---- connection from env (values never printed; password only via SQLCMDPASSWORD) ----
const conn = def.connection || {};
function envVal(key, label) {
  const name = conn[key];
  if (!name) return undefined;
  if (!process.env[name]) blocked(`env var ${name} (${label}) is not set`);
  return process.env[name];
}
const server = envVal('serverEnv', 'server');
if (!server) blocked('catalog connection.serverEnv missing or env not set');
const port = conn.portEnv && process.env[conn.portEnv] ? process.env[conn.portEnv] : '';
const srv = port ? `${server},${port}` : server;
const db = envVal('databaseEnv', 'database');
const user = envVal('userEnv', 'user');

const cmdArgs = ['-S', srv, '-C', '-b', '-h', '-1', '-W', '-s', '|', '-Q', sql];
if (db) cmdArgs.splice(2, 0, '-d', db);
if (user) cmdArgs.splice(2, 0, '-U', user); // password comes from SQLCMDPASSWORD (inherited env)

// ---- execute ----
const r = spawnSync('sqlcmd', cmdArgs, { encoding: 'utf8', timeout: 30000 });
if (r.error && r.error.code === 'ENOENT') blocked('sqlcmd is not installed — see the db-integration reference for install steps (winget install -e --id Microsoft.Sqlcmd)');
const output = (r.stdout || '') + (r.stderr ? `\nSTDERR:\n${r.stderr}` : '');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, `ENTRY: ${entry}\n\n${output}\n`);
if (r.status !== 0) out({ result: 'FAIL', reason: 'sqlcmd returned an error (see log)', log: logPath }, 1);

// ---- row count + assertions ----
const rows = (r.stdout || '').split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !/^\(\d+ rows? affected\)$/i.test(l) && !/^Warning:/i.test(l)).length;
const failures = [];
if (expectRows !== undefined && rows !== expectRows) failures.push(`row count ${rows} != expected ${expectRows}`);
if (expectMinRows !== undefined && rows < expectMinRows) failures.push(`row count ${rows} < expected minimum ${expectMinRows}`);
if (failures.length) out({ result: 'FAIL', rows, failures, log: logPath }, 1);
out({ result: 'PASS', rows, log: logPath }, 0);
