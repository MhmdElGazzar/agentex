// AgenTeX endpoint-suite runner — runs every cataloged test CASE by shelling out to
// api-integration's run_api.js per case. Never duplicates run_api.js's catalog/auth/assertion
// logic — it stays the single source of truth for how one cataloged call executes; this
// script only reads suite files and aggregates results.
//
// Usage:
//   node run_suite.js [--catalog ./integration] [--suites ./integration/api_test_suites]
//     [--env <environment-name>] --run-dir <dir>
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
// (no expect.status / expect.fields / expect.equals) — a case that asserts nothing must never
// PASS on any status. Logs: <run-dir>/logs/<suiteBase>__<index>-<case-slug>.log (unique).
//
// Prints ONE JSON line: {"result":"PASS|FAIL","total":N,"passed":N,"failed":N,"blocked":N,
//   "cases":[{"name":...,"entry":...,"result":...,"log":...,"failures":[...]?}]}
// Exit: 0 all PASS, 1 any FAIL, 2 zero FAIL but any BLOCKED.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }

// ---- args ----
const args = process.argv.slice(2);
let catalog = './integration', suites = './integration/api_test_suites', runDir, envName;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--catalog') catalog = v();
  else if (a === '--suites') suites = v();
  else if (a === '--env') envName = v();
  else if (a === '--run-dir') runDir = v();
}
if (!runDir) blocked('usage: --run-dir <dir> required');

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
const suiteFiles = findSuiteFiles(suites);
if (!suiteFiles.length) blocked(`no *_suite.json files under ${suites} — define at least one case before running`);

let allCases = [];
for (const f of suiteFiles) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
  // suiteBase: the suite file's path relative to --suites, minus "_suite.json", sanitized —
  // unique per file, so <suiteBase>__<index> is unique per case.
  const suiteBase = path.relative(suites, f).replace(/_suite\.json$/, '').replace(/[^A-Za-z0-9.-]+/g, '_');
  (j.cases || []).forEach((c, i) => allCases.push({ ...c, __file: f, __logBase: `${suiteBase}__${i + 1}` }));
}
if (!allCases.length) blocked(`no cases defined across suite files in ${suites}`);

// ---- run every case via run_api.js ----
const runApiPath = path.join(__dirname, '..', '..', 'api-integration', 'scripts', 'run_api.js');
fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });

const results = [];
for (const c of allCases) {
  if (!c.name || !c.entry) {
    results.push({ name: c.name || '(unnamed)', entry: c.entry, result: 'BLOCKED', reason: `case in ${c.__file} is missing "name" or "entry"` });
    continue;
  }
  // A case carrying "skip" (swagger-import writes one on every generated write-method case) is
  // never executed: it counts as BLOCKED — "not run", same roll-up as any other BLOCKED case —
  // quoting the reason so the report says exactly why and how to enable it.
  if (c.skip) {
    const why = typeof c.skip === 'string' ? c.skip : 'skip: true';
    results.push({ name: c.name, entry: c.entry, result: 'BLOCKED', skipped: true, reason: `case skipped: ${JSON.stringify(why)}` });
    continue;
  }
  const expect = c.expect || {};
  const hasExpect = expect.status !== undefined || (expect.fields || []).length || Object.keys(expect.equals || {}).length;
  if (!hasExpect) {
    results.push({ name: c.name, entry: c.entry, result: 'BLOCKED', reason: 'case has no expect — add expect.status, expect.fields or expect.equals' });
    continue;
  }
  const caseSlug = String(c.name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'case';
  const logPath = path.join(runDir, 'logs', `${c.__logBase}-${caseSlug}.log`);
  const callArgs = ['--entry', c.entry, '--catalog', catalog, '--log', logPath];
  if (envName) callArgs.push('--env', envName);
  for (const [k, val] of Object.entries(c.params || {})) callArgs.push('--param', `${k}=${val}`);
  if (expect.status !== undefined) callArgs.push('--expect-status', String(expect.status));
  for (const field of (expect.fields || [])) callArgs.push('--expect-field', field);
  for (const [p, v] of Object.entries(expect.equals || {})) callArgs.push('--expect-equals', `${p}=${v}`);

  const proc = spawnSync(process.execPath, [runApiPath, ...callArgs], { encoding: 'utf8' });
  let parsed;
  try { parsed = JSON.parse((proc.stdout || '').trim().split('\n').pop()); }
  catch { parsed = { result: 'BLOCKED', reason: `run_api.js produced no parseable output (stderr: ${(proc.stderr || '').trim()})` }; }
  results.push({ name: c.name, entry: c.entry, ...parsed });
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
