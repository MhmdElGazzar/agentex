// AgenTeX endpoint-suite runner — runs every cataloged test CASE by shelling out to
// api-integration's run_api.js per case. Never duplicates run_api.js's catalog/auth/assertion
// logic — it stays the single source of truth for how one cataloged call executes; this
// script only reads suite files and aggregates results.
//
// Usage:
//   node run_suite.js [--catalog ./integration] [--suites ./integration/api_test_suites]
//     [--env <environment-name>] [--suite <file> [--case <n>]] --run-dir <dir>
//
// --suite <file> runs that one suite file only (it must sit under --suites, else BLOCKED);
// --case <n> (needs --suite) runs only its nth case, 1-based (out of range → BLOCKED).
//
// --env is passed through to every run_api.js call (selects environments/<env>.json; absent →
// run_api.js's own default-environment resolution, the project's defaultEnvironment; an
// unknown name is BLOCKED per case by run_api.js).
//
// --suites is searched recursively for *_suite.json (catalogs from the same swagger-import
// output live alongside their suite as <name>_api.json in the same folder — must filter on
// the _suite.json suffix specifically, not just any .json file).
//
// A case is BLOCKED without being executed when it carries "skip" or has no expectation
// (no expect.status / expect.fields / expect.equals / expect.contains) — a case that asserts
// nothing must never PASS on any status. Logs: <run-dir>/logs/<suiteBase>__<index>-<case-slug>.log
// (unique).
//
// Optional case fields (absent = the behaviour above): "auth": "none" → run_api.js --no-auth
// (any other value BLOCKED); "omit": [names] → one --omit per name (its params value ignored);
// "expect.contains": {path: text} → --expect-contains; "sources": {param: "ui|project|auto|
// manual|placeholder"} → any param still "placeholder" (and not omitted) is BLOCKED with
// reasonCode "placeholder" and never sent; "kind" and "review" are informational. Object and
// array param values are passed as JSON text.
//
// Prints ONE JSON line: {"result":"PASS|FAIL","total":N,"passed":N,"failed":N,"blocked":N,
//   "cases":[{"name":...,"entry":...,"suite":<file relative to cwd>,"index":<1-based>,
//   "result":...,"log":...,"failures":[...]?,"reasonCode":...?,"ms":...?}]}
// and writes the same object to <run-dir>/suite-result.json with {schemaVersion: 1, suite?,
// case?, env?, startedAt} added (the editor's "last result" reads it).
// Exit: 0 all PASS, 1 any FAIL, 2 zero FAIL but any BLOCKED.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const startedAt = new Date().toISOString();
let runDir, envName, suiteArg, caseArg, suiteRel;
// One JSON line on stdout; the same object (plus run metadata) in <run-dir>/suite-result.json.
function out(obj, code) {
  if (runDir) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      const meta = { schemaVersion: 1, ...(suiteRel ? { suite: suiteRel } : {}), ...(caseArg !== undefined ? { case: caseArg } : {}), ...(envName ? { env: envName } : {}), startedAt };
      fs.writeFileSync(path.join(runDir, 'suite-result.json'), JSON.stringify({ ...meta, ...obj }, null, 2) + '\n');
    } catch { /* the stdout line stays the contract */ }
  }
  console.log(JSON.stringify(obj));
  process.exit(code);
}
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }
const posixRel = (from, to) => path.relative(from, to).split(path.sep).join('/');
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// ---- args ----
const args = process.argv.slice(2);
let catalog = './integration', suites = './integration/api_test_suites';
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--catalog') catalog = v();
  else if (a === '--suites') suites = v();
  else if (a === '--env') envName = v();
  else if (a === '--run-dir') runDir = v();
  else if (a === '--suite') suiteArg = v();
  else if (a === '--case') caseArg = v();
}
if (!runDir) blocked('usage: --run-dir <dir> required');
if (caseArg !== undefined) {
  if (!/^[0-9]+$/.test(String(caseArg)) || Number(caseArg) < 1) { const bad = caseArg; caseArg = undefined; blocked(`--case must be a case number (1-based), got ${JSON.stringify(bad)}`); }
  caseArg = Number(caseArg);
  if (!suiteArg) blocked('--case needs --suite <file>: a case number is counted within one suite file');
}

// ---- load & flatten suite cases ----
if (!fs.existsSync(suites)) blocked(`suites folder not found: ${suites} — scaffold it and define your cases first`);
function findSuiteFiles(dir) {
  let found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(findSuiteFiles(full));
    else if (entry.isFile() && entry.name.endsWith('_suite.json')) found.push(full);
  }
  return found;
}
let suiteFiles;
if (suiteArg) {
  const suitesReal = real(suites);
  if (!fs.existsSync(suiteArg)) blocked(`suite file not found: ${suiteArg}`);
  const suiteReal = real(suiteArg);
  if (!suiteReal.startsWith(suitesReal + path.sep) || !suiteReal.endsWith('_suite.json')) blocked(`--suite ${suiteArg} is not under ${suites} (or is not a *_suite.json file) — only suites under the suites folder can run`);
  suiteRel = posixRel(real(process.cwd()), suiteReal);
  suiteFiles = [path.join(suites, path.relative(suitesReal, suiteReal))];
} else {
  suiteFiles = findSuiteFiles(suites);
}
if (!suiteFiles.length) blocked(`no *_suite.json files under ${suites} — define at least one case before running`);

let allCases = [];
for (const f of suiteFiles) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
  // suiteBase: the suite file's path relative to --suites, minus "_suite.json", sanitized —
  // unique per file, so <suiteBase>__<index> is unique per case.
  const suiteBase = path.relative(suites, f).replace(/_suite\.json$/, '').replace(/[^A-Za-z0-9.-]+/g, '_');
  const rel = posixRel(real(process.cwd()), real(f));
  const fileCases = j.cases || [];
  if (caseArg !== undefined && caseArg > fileCases.length) blocked(`--case ${caseArg} is out of range: ${suiteArg} has ${fileCases.length} cases`);
  fileCases.forEach((c, i) => {
    if (caseArg !== undefined && i + 1 !== caseArg) return;
    allCases.push({ ...c, __file: f, __suite: rel, __index: i + 1, __logBase: `${suiteBase}__${i + 1}` });
  });
}
if (!allCases.length) blocked(`no cases defined across suite files in ${suites}`);

// ---- run every case via run_api.js ----
const runApiPath = path.join(__dirname, '..', '..', 'api-integration', 'scripts', 'run_api.js');
fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });

const results = [];
const PARAM_SOURCES_PLACEHOLDER = 'placeholder';
for (const c of allCases) {
  const where = { suite: c.__suite, index: c.__index };
  const push = r => results.push({ ...r, ...where });
  if (!c.name || !c.entry) {
    push({ name: c.name || '(unnamed)', entry: c.entry, result: 'BLOCKED', reason: `case in ${c.__file} is missing "name" or "entry"` });
    continue;
  }
  // A case carrying "skip" (swagger-import writes one on every generated write-method case) is
  // never executed: it counts as BLOCKED — "not run", same roll-up as any other BLOCKED case —
  // quoting the reason so the report says exactly why and how to enable it.
  if (c.skip) {
    const why = typeof c.skip === 'string' ? c.skip : 'skip: true';
    push({ name: c.name, entry: c.entry, result: 'BLOCKED', skipped: true, reason: `case skipped: ${JSON.stringify(why)}` });
    continue;
  }
  const expect = c.expect || {};
  const hasExpect = expect.status !== undefined || (expect.fields || []).length || Object.keys(expect.equals || {}).length || Object.keys(expect.contains || {}).length;
  if (!hasExpect) {
    push({ name: c.name, entry: c.entry, result: 'BLOCKED', reason: 'case has no expect — add expect.status, expect.fields or expect.equals' });
    continue;
  }
  if (c.auth !== undefined && c.auth !== 'none') {
    push({ name: c.name, entry: c.entry, result: 'BLOCKED', reason: `case "${c.name}": "auth" must be "none" or absent (got ${JSON.stringify(c.auth)})` });
    continue;
  }
  const omit = Array.isArray(c.omit) ? c.omit.map(String) : [];
  // A1: a value still marked placeholder is never sent — the verdict would be about "example".
  const placeholder = Object.entries(c.sources || {}).find(([p, src]) => src === PARAM_SOURCES_PLACEHOLDER && !omit.includes(p));
  if (placeholder) {
    push({ name: c.name, entry: c.entry, result: 'BLOCKED', reasonCode: 'placeholder', reason: `needs a real value: param "${placeholder[0]}" is still a placeholder — set it in the editor or the suite file` });
    continue;
  }
  const caseSlug = String(c.name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'case';
  const logPath = path.join(runDir, 'logs', `${c.__logBase}-${caseSlug}.log`);
  const callArgs = ['--entry', c.entry, '--catalog', catalog, '--log', logPath];
  if (envName) callArgs.push('--env', envName);
  if (c.auth === 'none') callArgs.push('--no-auth');
  for (const k of omit) callArgs.push('--omit', k);
  for (const [k, val] of Object.entries(c.params || {})) {
    if (omit.includes(k)) continue;
    callArgs.push('--param', `${k}=${val !== null && typeof val === 'object' ? JSON.stringify(val) : val}`);
  }
  if (expect.status !== undefined) callArgs.push('--expect-status', String(expect.status));
  for (const field of (expect.fields || [])) callArgs.push('--expect-field', field);
  for (const [p, v] of Object.entries(expect.equals || {})) callArgs.push('--expect-equals', `${p}=${v}`);
  for (const [p, v] of Object.entries(expect.contains || {})) callArgs.push('--expect-contains', `${p}=${v}`);

  const proc = spawnSync(process.execPath, [runApiPath, ...callArgs], { encoding: 'utf8' });
  let parsed;
  try { parsed = JSON.parse((proc.stdout || '').trim().split('\n').pop()); }
  catch { parsed = { result: 'BLOCKED', reason: `run_api.js produced no parseable output (stderr: ${(proc.stderr || '').trim()})` }; }
  push({ name: c.name, entry: c.entry, ...parsed });
}

// ---- aggregate ----
const passed = results.filter(r => r.result === 'PASS').length;
const failed = results.filter(r => r.result === 'FAIL').length;
const blockedCount = results.filter(r => r.result === 'BLOCKED').length;
const summary = {
  result: failed > 0 ? 'FAIL' : (blockedCount > 0 ? 'BLOCKED' : 'PASS'),
  total: results.length, passed, failed, blocked: blockedCount, cases: results,
};
out(summary, failed > 0 ? 1 : (blockedCount > 0 ? 2 : 0));
