'use strict';
// Tests for write_verdict.js — the deterministic gate step: run-summary in,
// contract-v1 verdict out (one JSON line + <runDir>/verdict.json + optional
// AGENTEX_VERDICT_PATH copy), process.exitCode = the verdict's exit code.
//
// The heart of this file is the 1-vs-2 adversarial matrix: for EVERY
// environment/indeterminate input class the exit code is asserted to be 2 and
// NEVER 1, case by case — exit 1 is reachable only through product observations
// (failed scenarios, or warnings under the default policy).
//
// Run: node skills/browser-testing/scripts/write_verdict.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'write_verdict.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL = 'SENTINEL-secret-value-writeverdict-77ab21';

function proj(ciBlock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-wv-'));
  if (ciBlock !== undefined) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({ name: 'sample', ci: ciBlock }));
  }
  fs.mkdirSync(path.join(dir, 'executions', 'execu_2026-01-01_00-00-00'), { recursive: true });
  return dir;
}

const ZERO = { total: 0, passed: 0, failed: 0, blocked: 0, warnings: 0, viewMismatch: 0, flaky: 0, naDescoped: 0, notRun: 0 };

// Writes a run-summary file and runs the script. counts are merged over ZERO.
function runVerdict(counts, { args = [], env = {}, cwd, summaryExtra = {}, noSummary = false, rawSummary } = {}) {
  const dir = cwd || proj();
  const runDir = 'executions/execu_2026-01-01_00-00-00';
  const summaryFile = path.join(dir, 'run-summary.json');
  if (!noSummary) {
    const body = rawSummary !== undefined ? rawSummary
      : JSON.stringify({ title: 'CI run', date: '2026-01-01', summary: { ...ZERO, ...counts }, ...summaryExtra });
    fs.writeFileSync(summaryFile, body);
  }
  const argv = [SCRIPT];
  if (!noSummary) argv.push('--summary', summaryFile);
  argv.push('--run-dir', runDir, ...args);
  const r = spawnSync(process.execPath, argv, { cwd: dir, encoding: 'utf8', env: { ...process.env, AGENTEX_VERDICT_PATH: '', AGENTEX_CI_POLICY: '', ...env } });
  const lines = r.stdout.trim() ? r.stdout.trim().split(/\r?\n/) : [];
  return {
    dir, runDir,
    status: r.status, stdout: r.stdout, stderr: r.stderr, lines,
    json: lines.length ? JSON.parse(lines[lines.length - 1]) : null,
    verdictFile: path.join(dir, runDir, 'verdict.json'),
  };
}

// ---- the verdict mapping matrix ------------------------------------------------

test('all pass → PASS / exit 0', () => {
  const r = runVerdict({ total: 3, passed: 3 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.json.verdict, 'PASS');
  assert.strictEqual(r.json.exitCode, 0);
  assert.deepStrictEqual(r.json.blockedReasons, []);
});

test('failed > 0 → FAIL / exit 1 (real product defects)', () => {
  const r = runVerdict({ total: 3, passed: 2, failed: 1 });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.verdict, 'FAIL');
});

test('warnings > 0 under the DEFAULT policy → FAIL / exit 1 (owner decision 5)', () => {
  const r = runVerdict({ total: 3, passed: 2, warnings: 1 });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.verdict, 'FAIL');
});

test('warnings > 0 with warningsFailGate=false → PASS / exit 0 (consumer relaxed it)', () => {
  const r = runVerdict({ total: 3, passed: 2, warnings: 1 }, { args: ['--warnings-fail-gate', 'false'] });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.verdict, 'PASS');
  assert.strictEqual(r.json.counts.warnings, 1, 'still visible in the counts');
});

test('mixed failed + blocked → FAIL / exit 1, blocked counts stay visible', () => {
  const r = runVerdict({ total: 4, passed: 2, failed: 1, blocked: 1 });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.counts.blocked, 1);
});

test('mapping order pin: warnings (product) beat blocked (environment) — FAIL / exit 1', () => {
  const r = runVerdict({ total: 4, passed: 2, warnings: 1, blocked: 1 });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.verdict, 'FAIL');
});

test('naDescoped never gates → PASS / exit 0', () => {
  const r = runVerdict({ total: 3, passed: 2, naDescoped: 1 });
  assert.strictEqual(r.status, 0, r.stdout);
});

test('flaky with the DEFAULT policy (flakyFailsGate:false) → PASS / exit 0, flaky visible', () => {
  const r = runVerdict({ total: 3, passed: 2, flaky: 1 });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.counts.flaky, 1);
});

test('flaky with flakyFailsGate=true → BLOCKED / exit 2, reason unstable, marked non-retryable', () => {
  const r = runVerdict({ total: 3, passed: 2, flaky: 1 }, { args: ['--flaky-fails-gate', 'true'] });
  assert.strictEqual(r.status, 2, 'environment-flavored per the Flake doctrine — never 1');
  const unstable = r.json.blockedReasons.find((b) => b.code === 'unstable');
  assert.ok(unstable, JSON.stringify(r.json.blockedReasons));
  assert.strictEqual(unstable.retryable, false);
});

// ---- the adversarial 1-vs-2 matrix: environment classes are exit 2, NEVER 1 ----

const envCases = [
  ['blocked scenarios', { total: 3, passed: 2, blocked: 1 }, [], 'blocked-scenarios'],
  ['view mismatch', { total: 3, passed: 2, viewMismatch: 1 }, [], 'view-mismatch'],
  ['not-run scenarios (incomplete run)', { total: 3, passed: 2, notRun: 1 }, [], 'incomplete'],
  ['needs-user (question named, never silently resolved)', { total: 3, passed: 3 }, ['--run-reason', 'needs-user:is the timestamp block drift acceptable? baseline vs actual attached'], 'needs-user'],
  ['interaction required', { total: 3, passed: 3 }, ['--run-reason', 'interaction-required:a confirmation gate was reached'], 'interaction-required'],
  ['captcha or unobtainable OTP', { total: 3, passed: 3 }, ['--run-reason', 'captcha-or-otp:login presented an uncataloged captcha'], 'captcha-or-otp'],
  ['run-level timeout', { total: 3, passed: 1, notRun: 2 }, ['--run-reason', 'timeout:attempt budget exceeded'], 'timeout'],
  ['session error', { total: 3, passed: 0, notRun: 3 }, ['--run-reason', 'session-error:the browser session died'], 'session-error'],
];
for (const [label, counts, args, code] of envCases) {
  test(`1-vs-2 promise: ${label} → BLOCKED / exit 2, never 1`, () => {
    const r = runVerdict(counts, { args });
    assert.notStrictEqual(r.status, 1, `${label} must never exit 1`);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.json.verdict, 'BLOCKED');
    assert.ok(r.json.blockedReasons.some((b) => b.code === code), JSON.stringify(r.json.blockedReasons));
  });
}

test('needs-user carries the precise question as detail', () => {
  const r = runVerdict({ total: 1, passed: 1 }, { args: ['--run-reason', 'needs-user:which variant is current: A or B?'] });
  const reason = r.json.blockedReasons.find((b) => b.code === 'needs-user');
  assert.strictEqual(reason.detail, 'which variant is current: A or B?');
});

test('an unknown run-reason code is refused (closed vocabulary) → usage, exit 2', () => {
  const r = runVerdict({ total: 1, passed: 1 }, { args: ['--run-reason', 'made-up-code:x'] });
  assert.strictEqual(r.status, 2);
  assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
});

// ---- artifact + contract mechanics ---------------------------------------------

test('verdict.json is written into the run dir and matches the stdout line', () => {
  const r = runVerdict({ total: 2, passed: 2 });
  assert.ok(fs.existsSync(r.verdictFile), 'verdict.json exists');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.verdictFile, 'utf8')), r.json);
});

test('AGENTEX_VERDICT_PATH copy is written by the script itself (script-to-script handshake)', () => {
  const handoff = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-wv-handoff-')), 'deep', 'verdict.json');
  const r = runVerdict({ total: 2, passed: 2 }, { env: { AGENTEX_VERDICT_PATH: handoff } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(handoff, 'utf8')), r.json);
});

test('contract snapshot: the v1 field set is pinned exactly', () => {
  const r = runVerdict({ total: 2, passed: 2 }, {
    args: ['--env', 'uat', '--scope-kind', 'suite', '--scope-value', 'test/suite3/', '--started-at', '2026-01-01T00:00:00.000Z'],
  });
  assert.deepStrictEqual(Object.keys(r.json).sort(), [
    'attempt', 'attemptHistory', 'blockedReasons', 'counts', 'durationMs', 'environment',
    'exitCode', 'finishedAt', 'maxAttempts', 'pluginVersion', 'policy', 'reportPath', 'retries',
    'runDir', 'schemaVersion', 'scope', 'startedAt', 'verdict',
  ].sort());
  assert.strictEqual(r.json.schemaVersion, 1);
  assert.deepStrictEqual(Object.keys(r.json.counts).sort(),
    ['blocked', 'failed', 'flaky', 'naDescoped', 'notRun', 'passed', 'viewMismatch', 'warnings'].sort());
  assert.deepStrictEqual(Object.keys(r.json.policy).sort(),
    ['flakyFailsGate', 'retries', 'timeoutMinutes', 'warningsFailGate'].sort());
  assert.deepStrictEqual(r.json.scope, { kind: 'suite', value: 'test/suite3/' });
  assert.strictEqual(r.json.environment, 'uat');
  assert.ok(typeof r.json.pluginVersion === 'string' && r.json.pluginVersion.length > 0);
  assert.ok(typeof r.json.durationMs === 'number' && r.json.durationMs >= 0);
  assert.strictEqual(r.json.runDir, 'executions/execu_2026-01-01_00-00-00');
  assert.strictEqual(r.json.reportPath, 'executions/execu_2026-01-01_00-00-00/report.md');
});

test('policy defaults land in the verdict: warningsFailGate true, retries 3, timeoutMinutes 60, flakyFailsGate false', () => {
  const r = runVerdict({ total: 1, passed: 1 });
  assert.deepStrictEqual(r.json.policy, { warningsFailGate: true, retries: 3, timeoutMinutes: 60, flakyFailsGate: false });
});

test('policy precedence: config ci block beats defaults', () => {
  const dir = proj({ warningsFailGate: false, retries: 1 });
  const r = runVerdict({ total: 2, passed: 1, warnings: 1 }, { cwd: dir });
  assert.strictEqual(r.status, 0, 'config relaxed the warnings gate');
  assert.strictEqual(r.json.policy.warningsFailGate, false);
  assert.strictEqual(r.json.policy.retries, 1);
  assert.strictEqual(r.json.policy.timeoutMinutes, 60, 'unset keys keep defaults');
});

test('policy precedence: AGENTEX_CI_POLICY (the gate handshake) beats config; flags beat both', () => {
  const dir = proj({ warningsFailGate: false });
  const viaEnv = runVerdict({ total: 2, passed: 1, warnings: 1 },
    { cwd: dir, env: { AGENTEX_CI_POLICY: JSON.stringify({ warningsFailGate: true }) } });
  assert.strictEqual(viaEnv.status, 1, 'env policy re-tightened the gate over config');
  const viaFlag = runVerdict({ total: 2, passed: 1, warnings: 1 },
    { cwd: proj({ warningsFailGate: true }), args: ['--warnings-fail-gate', 'false'], env: { AGENTEX_CI_POLICY: JSON.stringify({ warningsFailGate: true }) } });
  assert.strictEqual(viaFlag.status, 0, 'the flag wins over env and config');
});

test('ONE stdout line in every mode (PASS, FAIL, BLOCKED)', () => {
  for (const counts of [{ total: 1, passed: 1 }, { total: 1, failed: 1 }, { total: 1, blocked: 1 }]) {
    const r = runVerdict(counts);
    assert.strictEqual(r.lines.length, 1, `stdout was:\n${r.stdout}`);
  }
});

test('secret-shaped input is never echoed: the verdict is built from a whitelist', () => {
  const r = runVerdict({ total: 1, passed: 1 }, {
    summaryExtra: {
      secretLeak: SENTINEL,
      testCases: [{ name: 'login', status: 'passed', steps: [{ desc: 'login', status: 'passed', note: SENTINEL }] }],
    },
  });
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL), 'stdout/stderr clean');
  assert.ok(!fs.readFileSync(r.verdictFile, 'utf8').includes(SENTINEL), 'verdict.json clean');
});

// ---- fail-closed usage handling -------------------------------------------------

test('missing --summary → exit 2 usage, and NO verdict.json is written', () => {
  const r = runVerdict({}, { noSummary: true });
  assert.strictEqual(r.status, 2);
  assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
  assert.ok(!fs.existsSync(r.verdictFile), 'a garbage input must not produce a trusted artifact');
});

test('unparseable summary → exit 2 usage, never 0 or 1', () => {
  const r = runVerdict({}, { rawSummary: '{not json' });
  assert.strictEqual(r.status, 2);
  assert.ok(r.json.blockedReasons.some((b) => b.code === 'usage'));
});

test('summary without a summary object → exit 2 usage', () => {
  const r = runVerdict({}, { rawSummary: JSON.stringify({ title: 'x' }) });
  assert.strictEqual(r.status, 2);
});

test('a negative or non-numeric count → exit 2 usage (the mapping never guesses)', () => {
  const r = runVerdict({}, { rawSummary: JSON.stringify({ summary: { ...ZERO, failed: 'many' } }) });
  assert.strictEqual(r.status, 2);
});

// ---- structural pin --------------------------------------------------------------

test('structural pin: write_verdict.js contains no process.exit(', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!src.includes('process.exit('), 'write_verdict.js must not force-exit (exitCode + drain)');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
