// AgenTeX DB runner — executes ONE cataloged SQL Server query deterministically via sqlcmd.
// The catalog is the authorization: only queries defined in <catalog>/*_db.json can run.
// DDL (DROP/TRUNCATE/ALTER) is refused even if cataloged. Password only via SQLCMDPASSWORD.
//
// Usage:
//   node run_db.js --entry <file-name>.<query-name> [--param k=v ...]
//     [--env <environment-name>] [--expect-rows N] [--expect-min-rows N] [--catalog ./integration] --log <path>
//
// Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}. Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
// sqlcmd writes its result as Unicode to a temp file (-u -o), so non-ASCII text (Arabic, …)
// reaches the log intact whatever the console code page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }

// ---- args ----
const args = process.argv.slice(2);
const params = {};
let entry, logPath, catalog = './integration', expectRows, expectMinRows, envName;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--entry') entry = v();
  else if (a === '--param') { const p = v(); const eq = p.indexOf('='); params[p.slice(0, eq)] = p.slice(eq + 1); }
  else if (a === '--env') envName = v();
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

// ---- connection: active environment's db block first, legacy catalog env names second ----
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
let c;
try { c = pc.resolveDbConnection(process.cwd(), envName, def.connection); }
catch (e) { blocked(e.message); }
if (c.user && !c.password) blocked(`DB password is not set — set ${c.passwordHint} in .env (never on the command line)`);
const srv = c.port ? `${c.server},${c.port}` : c.server;

// Results go to a file in Unicode (-u -o), not through the console: console output is written
// in the console's OEM code page (e.g. 437 on an English Windows), which turns every character
// that page lacks (Arabic, Cyrillic, CJK, …) into "?", although the database holds it. -f o:65001
// is not a fix: on Windows the first sqlcmd call of a console session still writes "?". The
// file lives in a fresh temp folder and is removed as soon as it is read.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sqlcmd-'));
const outFile = path.join(outDir, 'result.txt');
const cmdArgs = ['-S', srv, '-C', '-b', '-h', '-1', '-W', '-s', '|', '-u', '-o', outFile, '-Q', sql];
if (c.database) cmdArgs.splice(2, 0, '-d', c.database);
if (c.user) cmdArgs.splice(2, 0, '-U', c.user); // password only via SQLCMDPASSWORD in the child env

// ---- execute ----
const r = spawnSync('sqlcmd', cmdArgs, {
  encoding: 'utf8', timeout: 30000,
  env: c.password ? { ...process.env, SQLCMDPASSWORD: c.password } : process.env,
});
// The result file: UTF-16LE as -u asks for, with or without a BOM; UTF-8 otherwise (a sqlcmd
// that ignores -u). Missing when sqlcmd failed before writing it.
function readResult(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return ''; }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  // Bare UTF-16LE, no BOM: a zero high byte on the first character only shows up when that
  // character is ASCII (an Arabic first column starts 45 06, not 45 00). Decode as UTF-8 and
  // fall back to UTF-16LE when that yields NUL or replacement characters, which a database
  // column never holds.
  const asUtf8 = buf.toString('utf8');
  if (buf.length % 2 === 0 && (asUtf8.includes('\u0000') || asUtf8.includes('\uFFFD'))) return buf.toString('utf16le');
  return asUtf8;
}
const result = readResult(outFile);
fs.rmSync(outDir, { recursive: true, force: true });
if (r.error && r.error.code === 'ENOENT') blocked('sqlcmd is not installed — see the db-integration reference for install steps (winget install -e --id Microsoft.Sqlcmd)');
const output = result + (r.stdout ? `\n${r.stdout}` : '') + (r.stderr ? `\nSTDERR:\n${r.stderr}` : '');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, `ENTRY: ${entry}\n\n${output}\n`);
if (r.status !== 0) out({ result: 'FAIL', reason: 'sqlcmd returned an error (see log)', log: logPath }, 1);

// ---- row count + assertions ----
const rows = result.split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !/^\(\d+ rows? affected\)$/i.test(l) && !/^Warning:/i.test(l)).length;
const failures = [];
if (expectRows !== undefined && rows !== expectRows) failures.push(`row count ${rows} != expected ${expectRows}`);
if (expectMinRows !== undefined && rows < expectMinRows) failures.push(`row count ${rows} < expected minimum ${expectMinRows}`);
if (failures.length) out({ result: 'FAIL', rows, failures, log: logPath }, 1);
out({ result: 'PASS', rows, log: logPath }, 0);
