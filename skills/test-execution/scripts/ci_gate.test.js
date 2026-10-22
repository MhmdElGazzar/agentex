'use strict';
// Tests for ci_gate.js — the pipeline entry point: usage/policy resolution,
// per-attempt CI preflight, headless session spawn (claude FAKED here via the
// --claude-cmd injection seam — no real claude session, API key, or browser),
// per-attempt timeout with process-tree kill, BLOCKED-only retries, verdict
// location (env-path handshake + newest-file fallback), final verdict + single
// stdout JSON line + exit code.
//
// The adversarial 1-vs-2 matrix continues here for the classes the gate owns:
// unreachable target, missing secret name, missing env file, per-attempt
// timeout, no-verdict — each asserted exit 2, NEVER 1.
//
// Run: node skills/test-execution/scripts/ci_gate.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'ci_gate.js');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
let passed = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok - ${name}`); },
    (e) => { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); });
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// -- seams shared by every case (all offline) ----------------------------------
function pwcliOkStub() {
  const file = path.join(tmp('agentex-cg-pwcli-'), 'pwcli.js');
  fs.writeFileSync(file, "process.stdout.write('0.1.18\\n');");
  return `"${process.execPath}" "${file}"`;
}
function browsersDir() {
  const dir = tmp('agentex-cg-browsers-');
  fs.mkdirSync(path.join(dir, 'chromium-1191'), { recursive: true });
  return dir;
}
const PWCLI = pwcliOkStub();
const BROWSERS = browsersDir();

// The fake claude: a node script driven by STUB_PLAN (one behavior per attempt,
// last repeats): pass | fail | blocked | unstable | silent | double | hang |
// noauth | invalidkey | auth401 | denied | denied-many | apierror | denied-pass | nothing | garbage.
// Records every invocation's argv + relevant env into STUB_STATE.
const STUB_SRC = `
'use strict';
const fs = require('fs'), path = require('path');
const state = process.env.STUB_STATE;
const cf = path.join(state, 'count');
const n = (fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) : 0) + 1;
fs.writeFileSync(cf, String(n));
fs.writeFileSync(path.join(state, 'argv-' + n + '.json'), JSON.stringify({
  argv: process.argv.slice(2),
  env: { AGENTEX_CI: process.env.AGENTEX_CI, AGENTEX_CI_POLICY: process.env.AGENTEX_CI_POLICY,
         AGENTEX_VERDICT_PATH: process.env.AGENTEX_VERDICT_PATH },
}));
const plan = (process.env.STUB_PLAN || 'pass').split(',');
const mode = plan[Math.min(n - 1, plan.length - 1)];
const runDir = 'executions/execu_2026-01-01_00-00-0' + n;
const SENT = 'SENTINEL-7c1e5a';
let custom = null; // a session result line other than the default success line
const result = (o) => ({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '', permission_denials: [], ...o });
const denial = (tool_name, tool_input) => ({ tool_name, tool_input });
function emit(v, code, reasons) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report.md'), '# run report (attempt ' + n + ')\\n');
  const obj = { schemaVersion: 1, verdict: v, exitCode: code,
    counts: { passed: v === 'PASS' ? 3 : 1, failed: v === 'FAIL' ? 1 : 0, blocked: v === 'BLOCKED' ? 1 : 0,
              warnings: 0, viewMismatch: 0, flaky: 0, naDescoped: 0, notRun: 0 },
    durationMs: 5, runDir, reportPath: runDir + '/report.md', blockedReasons: reasons || [],
    attempt: 1, maxAttempts: 1, retries: 0, attemptHistory: [],
    scope: { kind: null, value: null }, environment: null, pluginVersion: '0.0.0',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    policy: { warningsFailGate: true, retries: 3, timeoutMinutes: 60, flakyFailsGate: false } };
  const line = JSON.stringify(obj);
  fs.writeFileSync(path.join(runDir, 'verdict.json'), line);
  if (process.env.AGENTEX_VERDICT_PATH && process.env.STUB_NO_HANDSHAKE !== '1') {
    fs.mkdirSync(path.dirname(process.env.AGENTEX_VERDICT_PATH), { recursive: true });
    fs.writeFileSync(process.env.AGENTEX_VERDICT_PATH, line);
  }
}
if (mode === 'pass') emit('PASS', 0);
else if (mode === 'fail') emit('FAIL', 1);
else if (mode === 'blocked') emit('BLOCKED', 2, [{ code: 'blocked-scenarios', detail: '1 scenario(s) blocked' }]);
else if (mode === 'unstable') emit('BLOCKED', 2, [{ code: 'unstable', detail: 'flaky under flakyFailsGate', retryable: false }]);
else if (mode === 'silent') { /* concluded nothing */ }
else if (mode === 'double') {
  emit('PASS', 0);
  fs.mkdirSync('executions/execu_2026-01-01_09-09-09', { recursive: true });
  fs.writeFileSync('executions/execu_2026-01-01_09-09-09/verdict.json', JSON.stringify({ schemaVersion: 1, verdict: 'PASS', exitCode: 0 }));
} else if (mode === 'noauth') {
  // the real 2.1.267 capture, no auth source: exit 1, is_error, api_error
  custom = result({ is_error: true, terminal_reason: 'api_error', result: 'Not logged in · Please run /login ' + SENT });
  process.exitCode = 1;
} else if (mode === 'invalidkey') {
  custom = result({ is_error: true, terminal_reason: 'api_error', result: 'Invalid API key · Please run /login ' + SENT });
  process.exitCode = 1;
} else if (mode === 'auth401') {
  custom = result({ is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'authentication_error ' + SENT });
  process.exitCode = 1;
} else if (mode === 'apierror') {
  custom = result({ is_error: true, terminal_reason: 'api_error', api_error_status: 529, result: 'Overloaded ' + SENT });
  process.exitCode = 1;
} else if (mode === 'denied') {
  // the 2026-08-28 shape: no verdict, PowerShell x2 and Read x1 denied
  custom = result({ permission_denials: [
    denial('PowerShell', { command: 'Get-Content ' + SENT }),
    denial('Read', { file_path: 'C:/' + SENT + '/secret.txt' }),
    denial('PowerShell', { command: 'node ' + SENT }) ] });
} else if (mode === 'denied-many') {
  custom = result({ permission_denials: Array.from({ length: 12 }, (_, i) => denial('Tool' + i, { command: SENT })) });
} else if (mode === 'denied-pass') {
  emit('PASS', 0);
  custom = result({ permission_denials: [denial('PowerShell', { command: SENT })] });
} else if (mode === 'nothing') {
  custom = false; // prints nothing at all
} else if (mode === 'garbage') {
  custom = 'this is not json ' + SENT;
} else if (mode === 'hang') {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report.md'), '# partial report — preserved evidence\\n');
  setInterval(() => {}, 1000);
}
if (custom !== false) console.log(typeof custom === 'string' ? custom : JSON.stringify(custom || { type: 'result', subtype: 'success' }));
`;
function makeStub() {
  const dir = tmp('agentex-cg-stub-');
  const file = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(file, STUB_SRC);
  return file;
}
const STUB = makeStub();

// -- fixture project -------------------------------------------------------------
function proj(base, { ci, envSecretName, dotenv } = {}) {
  const dir = tmp('agentex-cg-proj-');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ name: 'sample', defaultEnvironment: 'qc', ...(ci ? { ci } : {}) }));
  fs.mkdirSync(path.join(dir, 'environments'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'environments', 'qc.json'), JSON.stringify({
    portalUrl: base,
    ...(envSecretName ? { users: { valid_user: { password: { envSecret: envSecretName } } } } : {}),
  }));
  fs.writeFileSync(path.join(dir, '.env'), dotenv !== undefined ? dotenv : '');
  fs.mkdirSync(path.join(dir, 'test', 'suite1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'suite1', 'sample.md'), '# sample spec\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(dir, 'test', 'b.md'), '# b\n');
  return dir;
}

// -- async gate runner (server lives in this process — keep the loop free) --------
function runGate(cwd, args, { plan = 'pass', envExtra = {}, noHandshake = false, script = SCRIPT } = {}) {
  const state = tmp('agentex-cg-state-');
  const env = {
    ...process.env,
    AGENTEX_PWCLI_PROBE_CMD: PWCLI,
    PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
    AGENTEX_CI_RETRY_DELAY_MS: '0',
    STUB_STATE: state,
    STUB_PLAN: plan,
    ...(noHandshake ? { STUB_NO_HANDSHAKE: '1' } : {}),
    AGENTEX_VERDICT_PATH: '', AGENTEX_CI: '', AGENTEX_CI_POLICY: '',
    ...envExtra,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [script, '--claude-cmd', `"${process.execPath}" "${STUB}"`, ...args], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
      const calls = fs.existsSync(path.join(state, 'count')) ? Number(fs.readFileSync(path.join(state, 'count'), 'utf8')) : 0;
      const argvDump = (i) => {
        const f = path.join(state, `argv-${i}.json`);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      };
      resolve({ status, stdout, stderr, lines, calls, argvDump, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null });
    });
  });
}

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- usage / project validation -----------------------------------------------

  await test('no scope form → exit 2 usage, claude never invoked, ONE stdout line', async () => {
    const r = await runGate(proj(base), []);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.lines.length, 1);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
    assert.strictEqual(r.calls, 0);
  });

  await test('two scope forms at once (--suite + --all) → exit 2 usage', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--all']);
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
  });

  await test('not an AgenTeX project dir → exit 2 usage, never 1', async () => {
    const empty = tmp('agentex-cg-empty-');
    const r = await runGate(empty, ['--all']);
    assert.notStrictEqual(r.status, 1);
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
  });

  // ---- the gate moment: PASS / FAIL / BLOCKED ------------------------------------

  await test('PASS end to end: exit 0, one line, contract fields, session composed per design', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--env', 'qc'], { plan: 'pass' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(r.json.verdict, 'PASS');
    assert.strictEqual(r.json.exitCode, 0);
    assert.strictEqual(r.json.attempt, 1);
    assert.strictEqual(r.json.retries, 0);
    assert.strictEqual(r.json.maxAttempts, 4, 'default retries 3 → 4 attempts max');
    assert.strictEqual(r.json.attemptHistory.length, 1);
    assert.deepStrictEqual(r.json.scope, { kind: 'suite', value: 'test/suite1/' });
    assert.strictEqual(r.json.environment, 'qc');
    assert.deepStrictEqual(r.json.policy, { warningsFailGate: true, retries: 3, timeoutMinutes: 60, flakyFailsGate: false });
    assert.strictEqual(r.calls, 1);
    const dump = r.argvDump(1);
    const argvStr = dump.argv.join(' ');
    assert.match(argvStr, /--bare/);
    assert.match(argvStr, /--permission-mode dontAsk/);
    assert.match(argvStr, /--output-format json/);
    assert.ok(argvStr.includes('/agentex:execute-test ci test/suite1/ on qc'), argvStr);
    assert.ok(dump.argv.includes('--plugin-dir'), 'plugin dir self-resolved');
    assert.strictEqual(dump.env.AGENTEX_CI, '1', 'AGENTEX_CI=1 set for the session');
    assert.ok(dump.env.AGENTEX_VERDICT_PATH, 'handshake path provided');
    assert.strictEqual(JSON.parse(dump.env.AGENTEX_CI_POLICY).warningsFailGate, true, 'resolved policy handed to the session');
  });

  await test('final verdict.json is written into the run folder and equals the stdout line', async () => {
    const dir = proj(base);
    const r = await runGate(dir, ['--suite', 'test/suite1/'], { plan: 'pass' });
    assert.strictEqual(r.status, 0);
    const file = path.join(dir, r.json.runDir, 'verdict.json');
    assert.ok(fs.existsSync(file));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), r.json);
  });

  await test('FAIL (real product defects): exit 1, NEVER retried', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'fail' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 1, 'retries never apply to exit 1');
    assert.strictEqual(r.json.verdict, 'FAIL');
    assert.strictEqual(r.json.retries, 0);
  });

  await test('PASS is never retried either (retry is for BLOCKED only)', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'pass' });
    assert.strictEqual(r.calls, 1);
  });

  // ---- retry semantics -------------------------------------------------------------

  await test('BLOCKED retries up to the budget, still BLOCKED → exit 2 with the count visible', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '2'], { plan: 'blocked' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 3, '1 + 2 retries');
    assert.strictEqual(r.json.retries, 2);
    assert.strictEqual(r.json.maxAttempts, 3);
    assert.strictEqual(r.json.attemptHistory.length, 3);
    assert.ok(r.json.attemptHistory.every((a) => a.verdict === 'BLOCKED'));
  });

  await test('BLOCKED then PASS: the first non-BLOCKED attempt is final → exit 0, retries 1', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '2'], { plan: 'blocked,pass' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 2);
    assert.strictEqual(r.json.verdict, 'PASS');
    assert.strictEqual(r.json.retries, 1);
    assert.strictEqual(r.json.attempt, 2);
    assert.deepStrictEqual(r.json.attemptHistory.map((a) => a.verdict), ['BLOCKED', 'PASS']);
    assert.deepStrictEqual(r.json.attemptHistory[0].reasonCodes, ['blocked-scenarios']);
  });

  await test('a BLOCKED whose ONLY reason is `unstable` is NEVER auto-retried (Flake doctrine carve-out)', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'unstable' });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.calls, 1, 'retrying to clear instability is the anti-pattern one level up');
    assert.deepStrictEqual(r.json.attemptHistory[0].reasonCodes, ['unstable']);
  });

  // ---- fail-closed verdict location -------------------------------------------------

  await test('1-vs-2: session concluded nothing (no verdict) → BLOCKED no-verdict, exit 2, never 1', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'silent' });
    assert.notStrictEqual(r.status, 1);
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'no-verdict'), JSON.stringify(r.json.blockedReasons));
  });

  await test('fallback: no handshake copy but a unique fresh executions/*/verdict.json is found → PASS', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/'], { plan: 'pass', noHandshake: true });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.verdict, 'PASS');
  });

  await test('fallback ambiguity: two fresh verdict.json files and no handshake → BLOCKED no-verdict', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'double', noHandshake: true });
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'no-verdict'));
  });

  // ---- timeout ----------------------------------------------------------------------

  await test('1-vs-2: per-attempt timeout kills the process tree, preserves partials → BLOCKED timeout, exit 2', async () => {
    const dir = proj(base);
    const r = await runGate(dir, ['--suite', 'test/suite1/', '--retries', '0', '--timeout-minutes', '0.05'], { plan: 'hang' });
    assert.notStrictEqual(r.status, 1, 'a timeout must never exit 1');
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'timeout'), JSON.stringify(r.json.blockedReasons));
    const partial = path.join(dir, 'executions', 'execu_2026-01-01_00-00-01', 'report.md');
    assert.ok(fs.existsSync(partial), 'the partial report stays on disk (invariant #6)');
    assert.match(fs.readFileSync(partial, 'utf8'), /preserved evidence/);
  });

  // ---- preflight gating (the rest of the adversarial matrix) -------------------------

  await test('1-vs-2: unreachable target → preflight blocks every attempt, claude NEVER spawns, exit 2', async () => {
    const r = await runGate(proj('http://127.0.0.1:9/'), ['--suite', 'test/suite1/', '--retries', '1'], { plan: 'pass' });
    assert.notStrictEqual(r.status, 1);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.calls, 0, 'a session is never spent on a failed preflight');
    assert.strictEqual(r.json.attemptHistory.length, 2, 'preflight re-runs at the top of every attempt');
    assert.ok(r.json.attemptHistory.every((a) => a.reasonCodes.includes('preflight-target')));
  });

  await test('an API-only scope (Drivers: api) never demands a browser: unreachable portalUrl, the session still runs', async () => {
    const dir = proj('http://127.0.0.1:9/');
    fs.writeFileSync(path.join(dir, 'test', 'suite1', 'sample.md'), '# api spec\nDrivers: api\n## Scenarios\n1. api: shop.get(id=1) → 200\n');
    const r = await runGate(dir, ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'pass' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 1);
    assert.match(r.stderr, /drivers for this scope: api/);
  });

  await test('a scope with a mobile spec (Drivers: mobile) is BLOCKED, never run in a browser, never retried', async () => {
    const dir = proj(base);
    fs.mkdirSync(path.join(dir, 'test', 'mobile-suite1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'mobile-suite1', 'login.md'), '# Spec: App login\nDrivers: mobile\n## Scenarios\n1. Tap login\n');
    const r = await runGate(dir, ['--suite', 'test/mobile-suite1/', '--retries', '2'], { plan: 'pass' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 0, 'no session is spent on a mobile spec');
    assert.strictEqual(r.json.attemptHistory.length, 1, 'a deterministic driver block is not retried');
    assert.match(JSON.stringify(r.json.blockedReasons), /mobile specs run via \/execute-mobile-test/);
  });

  await test('1-vs-2: missing secret NAME → exit 2, name listed, never 1', async () => {
    const dir = proj(base, { envSecretName: 'QA_CI_GATE_MISSING_SECRET' });
    const r = await runGate(dir, ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'pass' });
    assert.notStrictEqual(r.status, 1);
    assert.strictEqual(r.status, 2);
    assert.match(JSON.stringify(r.json.blockedReasons), /QA_CI_GATE_MISSING_SECRET/);
  });

  await test('1-vs-2: named environment with no file → exit 2 preflight-environment, never 1', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--env', 'nosuch', '--retries', '0'], { plan: 'pass' });
    assert.notStrictEqual(r.status, 1);
    assert.strictEqual(r.status, 2);
    assert.ok(r.json.blockedReasons.some((b) => b.code === 'preflight-environment'));
  });

  // ---- scope forms ---------------------------------------------------------------------

  await test('scope forms compose the prompt: single spec / explicit list / all', async () => {
    const single = await runGate(proj(base), ['--spec', 'test/a.md'], { plan: 'pass' });
    assert.strictEqual(single.status, 0);
    assert.deepStrictEqual(single.json.scope, { kind: 'spec', value: 'test/a.md' });
    assert.ok(single.argvDump(1).argv.join(' ').includes('/agentex:execute-test ci test/a.md'));

    const list = await runGate(proj(base), ['--spec', 'test/a.md', '--spec', 'test/b.md'], { plan: 'pass' });
    assert.strictEqual(list.status, 0);
    assert.deepStrictEqual(list.json.scope, { kind: 'list', value: 'test/a.md test/b.md' });

    const all = await runGate(proj(base), ['--all'], { plan: 'pass' });
    assert.strictEqual(all.status, 0);
    assert.deepStrictEqual(all.json.scope, { kind: 'all', value: 'all' });
    assert.ok(all.argvDump(1).argv.join(' ').includes('/agentex:execute-test ci all'));
  });

  // ---- policy resolution -----------------------------------------------------------------

  await test('flags > config > defaults: the config ci block is read, flags override it', async () => {
    const viaConfig = await runGate(proj(base, { ci: { retries: 1 } }), ['--suite', 'test/suite1/'], { plan: 'blocked' });
    assert.strictEqual(viaConfig.calls, 2, 'config retries=1 → 2 attempts');
    assert.strictEqual(viaConfig.json.policy.retries, 1);

    const viaFlag = await runGate(proj(base, { ci: { retries: 1 } }), ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'blocked' });
    assert.strictEqual(viaFlag.calls, 1, 'the flag beats the config block');
    assert.strictEqual(viaFlag.json.policy.retries, 0);
  });

  await test('--warnings-fail false reaches the session policy handshake', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--warnings-fail', 'false'], { plan: 'pass' });
    assert.strictEqual(JSON.parse(r.argvDump(1).env.AGENTEX_CI_POLICY).warningsFailGate, false);
    assert.strictEqual(r.json.policy.warningsFailGate, false);
  });

  await test('an explicit --settings file is forwarded to the session verbatim', async () => {
    const settings = path.join(tmp('agentex-cg-settings-'), 'ci-settings.json');
    fs.writeFileSync(settings, '{}');
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--settings', settings], { plan: 'pass' });
    assert.ok(r.argvDump(1).argv.join(' ').includes(settings), 'the settings path travels');
  });

  // ---- plugin-root read grant (D1 regression) ------------------------------------------------
  // The shipped ci-settings.json allows Read(./**) only — the consumer project cwd.
  // A plugin installed anywhere else was therefore unreadable to the spawned session:
  // it could not load references/procedures/ci-run.md (the deterministic verdict step) or
  // write_verdict.js, hand-wrote a nonconforming verdict, locateVerdict rejected it
  // fail-closed, and EVERY run concluded BLOCKED no-verdict. The spawn must grant
  // READ on the self-resolved plugin root in every supported install layout.

  await test('D1 pinned-checkout layout: spawn args grant read on the self-resolved plugin root (--add-dir)', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/'], { plan: 'pass' });
    assert.strictEqual(r.calls, 1, r.stdout + r.stderr);
    const argv = r.argvDump(1).argv;
    const i = argv.indexOf('--add-dir');
    assert.notStrictEqual(i, -1, `--add-dir missing from the spawn args: ${argv.join(' ')}`);
    assert.strictEqual(argv[i + 1], PLUGIN_ROOT, 'the read grant must be the self-resolved plugin root');
    assert.strictEqual(argv[argv.indexOf('--plugin-dir') + 1], argv[i + 1],
      'the grant and --plugin-dir must derive from the SAME resolved root');
  });

  await test('D1 marketplace-managed layout: the grant follows the installed copy, not the consumer cwd', async () => {
    // realpath: on macOS os.tmpdir() is behind the /var → /private/var symlink, and the gate reports real paths.
    const installRoot = path.join(fs.realpathSync(tmp('agentex-cg-install-')), 'some-marketplace', 'agentex', '9.9.9');
    for (const f of [
      'skills/test-execution/scripts/ci_gate.js',
      'skills/test-execution/scripts/ci_preflight.js',
      'skills/test-execution/scripts/preflight.js',
      'skills/test-execution/scripts/spec_drivers.js',
      'skills/test-execution/scripts/write_verdict.js',
      'skills/test-execution/templates/ci/ci-settings.json',
      'scripts/lib/project_config.js',
      '.claude-plugin/plugin.json',
    ]) {
      const dst = path.join(installRoot, ...f.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(PLUGIN_ROOT, ...f.split('/')), dst);
    }
    const installedGate = path.join(installRoot, 'skills', 'test-execution', 'scripts', 'ci_gate.js');
    const r = await runGate(proj(base), ['--suite', 'test/suite1/'], { plan: 'pass', script: installedGate });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 1, 'the installed copy must still spawn the session');
    const argv = r.argvDump(1).argv;
    const i = argv.indexOf('--add-dir');
    assert.notStrictEqual(i, -1, `--add-dir missing from the spawn args: ${argv.join(' ')}`);
    assert.strictEqual(argv[i + 1], installRoot, 'the grant must follow the installed plugin root');
    assert.match(argv.join(' '), /--permission-mode dontAsk/, 'the read grant never relaxes the deny-by-default mode');
  });

  // ---- named causes for a session that left no verdict (ci-blocked-reason) -----------------
  const SENTINEL = 'SENTINEL-7c1e5a';
  const gateLog = (r) => r.stderr.split(/\r?\n/).filter((l) => l.startsWith('ci_gate:'));
  const causeLines = (r, cause) => gateLog(r).filter((l) => l.includes(cause));
  const noSentinelOutside = (dir, r) => {
    assert.ok(!r.stdout.includes(SENTINEL), 'sentinel leaked into the stdout line');
    const vf = path.join(dir, r.json.runDir, 'verdict.json');
    assert.ok(!fs.readFileSync(vf, 'utf8').includes(SENTINEL), 'sentinel leaked into verdict.json');
    assert.ok(!gateLog(r).join('\n').includes(SENTINEL), 'sentinel leaked into a ci_gate log line');
  };

  await test('AC1 not logged in: session-error / not-authenticated, retryable:false, ONE attempt despite --retries 3, exit 2', async () => {
    const dir = proj(base);
    const r = await runGate(dir, ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'noauth' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.json.verdict, 'BLOCKED');
    assert.strictEqual(r.calls, 1, 'no retry on an auth failure');
    assert.strictEqual(r.json.attemptHistory.length, 1);
    assert.strictEqual(r.json.blockedReasons.length, 1);
    const b = r.json.blockedReasons[0];
    assert.strictEqual(b.code, 'session-error');
    assert.strictEqual(b.cause, 'not-authenticated');
    assert.strictEqual(b.retryable, false);
    assert.strictEqual(typeof b.detail, 'string');
    assert.deepStrictEqual(r.json.attemptHistory[0].reasonCodes, ['session-error']);
  });

  await test('AC2 the auth signature also matches "Invalid API key" and api_error_status 401', async () => {
    for (const plan of ['invalidkey', 'auth401']) {
      const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan });
      assert.strictEqual(r.status, 2, `${plan}: ${r.stdout + r.stderr}`);
      assert.strictEqual(r.calls, 1, plan);
      assert.strictEqual(r.json.blockedReasons[0].cause, 'not-authenticated', plan);
    }
  });

  await test('AC2 another is_error status (529), no denials → cause unknown, retried as today', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '2'], { plan: 'apierror' });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.calls, 3, '1 + 2 retries');
    const b = r.json.blockedReasons[0];
    assert.strictEqual(b.code, 'no-verdict');
    assert.strictEqual(b.cause, 'unknown');
    assert.notStrictEqual(b.retryable, false);
  });

  await test('AC3 denied tools: no-verdict / tool-denied, names deduped in first-seen order, no retry (Fork 1 A)', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'denied' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.calls, 1, 'a settings-denied tool is not retried');
    assert.strictEqual(r.json.attemptHistory.length, 1);
    assert.strictEqual(r.json.blockedReasons.length, 1);
    const b = r.json.blockedReasons[0];
    assert.strictEqual(b.code, 'no-verdict');
    assert.strictEqual(b.cause, 'tool-denied');
    assert.deepStrictEqual(b.tools, ['PowerShell', 'Read']);
    assert.strictEqual(b.retryable, false);
    assert.strictEqual(typeof b.detail, 'string');
  });

  await test('AC3 tool names are capped at 10', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '0'], { plan: 'denied-many' });
    assert.strictEqual(r.status, 2);
    assert.deepStrictEqual(r.json.blockedReasons[0].tools, Array.from({ length: 10 }, (_, i) => `Tool${i}`));
  });

  await test('AC4 sentinel in tool_input and in the auth result appears nowhere in stdout, verdict.json or the ci_gate log lines', async () => {
    for (const plan of ['denied', 'noauth', 'invalidkey', 'auth401', 'apierror', 'garbage']) {
      const dir = proj(base);
      const r = await runGate(dir, ['--suite', 'test/suite1/', '--retries', '1'], { plan });
      assert.strictEqual(r.status, 2, plan);
      noSentinelOutside(dir, r);
    }
  });

  await test('AC5 a session that prints nothing, or unparseable output → no-verdict / unknown, today\'s detail, retried (1 + retries)', async () => {
    for (const plan of ['nothing', 'garbage', 'silent']) {
      const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '2'], { plan });
      assert.strictEqual(r.status, 2, plan);
      assert.strictEqual(r.calls, 3, `${plan}: retried`);
      const b = r.json.blockedReasons[0];
      assert.strictEqual(b.code, 'no-verdict', plan);
      assert.strictEqual(b.cause, 'unknown', plan);
      assert.match(b.detail, /the session did not conclude deterministically/, plan);
    }
  });

  await test('AC6 a valid PASS verdict wins over reported denials: PASS, exit 0, no cause added', async () => {
    const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'denied-pass' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.verdict, 'PASS');
    assert.strictEqual(r.calls, 1);
    assert.deepStrictEqual(r.json.blockedReasons, []);
    assert.ok(!JSON.stringify(r.json).includes('tool-denied'));
  });

  await test('AC7 every new path exits 2 and never 1 (1-vs-2 matrix)', async () => {
    for (const plan of ['noauth', 'invalidkey', 'auth401', 'denied', 'denied-many', 'apierror', 'nothing', 'garbage']) {
      const r = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '0'], { plan });
      assert.notStrictEqual(r.status, 1, plan);
      assert.strictEqual(r.status, 2, plan);
      assert.strictEqual(r.json.exitCode, 2, plan);
      assert.strictEqual(r.lines.length, 1, `${plan}: ONE stdout line`);
    }
  });

  await test('AC8 each named cause logs exactly one human line: the cause, the fix, and whether it is retried', async () => {
    const auth = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'noauth' });
    const al = causeLines(auth, 'not-authenticated');
    assert.strictEqual(al.length, 1, gateLog(auth).join('\n'));
    assert.match(al[0], /ANTHROPIC_API_KEY/);
    assert.match(al[0], /not retried/);

    const den = await runGate(proj(base), ['--suite', 'test/suite1/', '--retries', '3'], { plan: 'denied' });
    const dl = causeLines(den, 'tool-denied');
    assert.strictEqual(dl.length, 1, gateLog(den).join('\n'));
    assert.match(dl[0], /ci-settings\.json/);
    assert.match(dl[0], /PowerShell/);
    assert.match(dl[0], /not retried/);
    assert.ok(!gateLog(den).some((l) => /retrying in/.test(l)), 'no retry line on a stopped attempt');
  });

  await test('classifySession (pure, exported): unknown for anything it does not recognise, never guessed', async () => {
    const { classifySession } = require(SCRIPT);
    for (const out of ['', 'nope', '{"type":"result"}', '{"type":"result","is_error":true,"api_error_status":500,"result":"boom"}',
      '{"type":"result","is_error":false,"result":"Not logged in","permission_denials":[]}']) {
      assert.strictEqual(classifySession(out).cause, 'unknown', out);
    }
    assert.strictEqual(classifySession('log line\n{"type":"result","is_error":true,"result":"Not logged in"}\n').cause, 'not-authenticated');
  });

  // ---- structural pin ----------------------------------------------------------------------

  await test('structural pin: ci_gate.js contains no process.exit(', async () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!src.includes('process.exit('), 'ci_gate.js must not force-exit (the exit code IS the product)');
  });

  server.close();
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
