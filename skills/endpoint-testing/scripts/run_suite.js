// AgenTeX endpoint-suite runner — runs every cataloged test CASE by shelling out to
// api-integration's run_api.js per case. Never duplicates run_api.js's catalog/auth/assertion
// logic — it stays the single source of truth for how one cataloged call executes; this
// script only reads suite files and aggregates results.
//
// Usage:
//   node run_suite.js [--catalog ./integration] [--suites ./integration/suites] --run-dir <dir>
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
let catalog = './integration', suites = './integration/suites', runDir;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--catalog') catalog = v();
  else if (a === '--suites') suites = v();
  else if (a === '--run-dir') runDir = v();
}
if (!runDir) blocked('usage: --run-dir <dir> required');

// ---- load & flatten suite cases ----
if (!fs.existsSync(suites)) blocked(`suites folder not found: ${suites} — scaffold it and define your cases first`);
const suiteFiles = fs.readdirSync(suites).filter(f => f.endsWith('.json'));
if (!suiteFiles.length) blocked(`no *.json suite files in ${suites} — define at least one case before running`);

let allCases = [];
for (const f of suiteFiles) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(suites, f), 'utf8')); }
  catch (e) { blocked(`invalid JSON in ${f}: ${e.message}`); }
  for (const c of (j.cases || [])) allCases.push({ ...c, __file: f });
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
  const logPath = path.join(runDir, 'logs', `${c.name}.log`);
  const callArgs = ['--entry', c.entry, '--catalog', catalog, '--log', logPath];
  for (const [k, val] of Object.entries(c.params || {})) callArgs.push('--param', `${k}=${val}`);
  const expect = c.expect || {};
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
