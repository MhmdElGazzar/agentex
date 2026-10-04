'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, validateConcurrency, resolveSpecs,
  resolveTarget, resolveAuthState, prepareAuthCopies, cleanupAuthCopies,
  schedule, runParallel, codexWorker, safeWorkerDiagnostic, hasSession, parseArgs,
  resolveRunHandoff, writeRunHandoff } = require('./parallel.js');

test('sanitized worker diagnostics retain error signals without transcript values', () => {
  const secret = 'fixture-sensitive-value-98765';
  const diagnostic = safeWorkerDiagnostic('stderr', 99, `Error: ECONNREFUSED ${secret}`, 1, 'crashed');
  assert.match(diagnostic, /ECONNREFUSED/);
  assert.match(diagnostic, /exitCode=1/);
  assert.doesNotMatch(diagnostic, new RegExp(secret));
});

test('crashing Codex process retains safe per-session stdout/stderr diagnostics and stays BLOCKED', async () => {
  const f = fixture();
  try {
    const spec1 = f.write('crash.md'), spec2 = f.write('sibling.md');
    const secret = 'fixture-sensitive-value-98765';
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.pid = 4242; child.exitCode = null;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end(`model transcript ${secret} authentication failed\n`);
        child.stderr.end(`Error: ECONNREFUSED ${secret}\n`);
        child.exitCode = 1;
        child.emit('close', 1);
      });
      return child;
    };
    let index = 0;
    const out = await runParallel({ ...runOptions(f, spec1, null, { specs: [spec1, spec2],
      worker: assignment => ++index === 1
        ? codexWorker(assignment, { timeoutMs: 10000, spawnWorker: fakeSpawn })
        : Promise.resolve(writePassingResult(assignment)), concurrency: 1 }) });
    assert.deepEqual([out.summary.passed, out.summary.failed, out.summary.blocked], [1, 0, 1]);
    const crash = out.timing.workerStates[0];
    assert.equal(crash.outcome, 'crashed');
    const logs = path.join(f.cwd, out.runDir, 'browser-sessions', crash.session, 'logs');
    const stdout = fs.readFileSync(path.join(logs, 'worker-stdout.log'), 'utf8');
    const stderr = fs.readFileSync(path.join(logs, 'worker-stderr.log'), 'utf8');
    assert.match(stdout, /AUTHENTICATION/);
    assert.match(stderr, /ECONNREFUSED/);
    assert.match(stderr, /exitCode=1/);
    for (const value of [stdout, stderr, ...['run-summary.json', 'parallel-manifest.json', 'parallel-timing.json']
      .map(name => fs.readFileSync(path.join(f.cwd, out.runDir, name), 'utf8'))]) {
      assert.equal(value.includes(secret), false);
    }
    assert.equal(out.summary.failed, 0, 'process output is not a product assertion');
  } finally { f.close(); }
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-parallel-coord-'));
  fs.mkdirSync(path.join(cwd, 'test', 'regression'), { recursive: true });
  const write = (name, body = '# Spec: Browser check\n\n## Scenarios\n1. Open the page') => {
    const file = path.join(cwd, 'test', 'regression', name);
    fs.writeFileSync(file, body);
    return path.relative(cwd, file).replace(/\\/g, '/');
  };
  return { cwd, write, close: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const assignments = n => Array.from({ length: n }, (_, i) => ({ workerId: `worker-${i + 1}`, session: `session-${i + 1}` }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fakePreflight(f) {
  const fakeCli = path.join(f.cwd, 'fake-cli.js');
  fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
  return { node: { ok: true, version: process.version },
    'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
      command: { executable: process.execPath, args: [fakeCli] } } };
}

function writePassingResult(assignment) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
    schemaVersion: 1, runDir: assignment.runDir, session: assignment.session,
    spec: assignment.spec, status: 'passed', startedAt: now, endedAt: now, durationMs: 1,
    scenarios: [{ name: 'Handoff check', session: assignment.session, status: 'passed',
      steps: [{ desc: 'Check fixture', status: 'passed' }] }],
    defects: [], failures: [], cleanup: { attempted: true, closed: true, error: null }
  }));
  return { outcome: 'completed' };
}

const runOptions = (f, spec, worker, extra = {}) => ({ cwd: f.cwd, specs: [spec],
  targetUrl: 'http://127.0.0.1:12743/smoke.html', loginMode: 'none',
  worker, preflight: fakePreflight(f), ...extra });

test('concurrency defaults to conservative 2, caps to test count, accepts 1 and 4', () => {
  assert.equal(DEFAULT_CONCURRENCY, 2);
  assert.equal(MAX_CONCURRENCY, 4);
  assert.equal(validateConcurrency(undefined, 5), 2);
  assert.equal(validateConcurrency(1, 5), 1);
  assert.equal(validateConcurrency(4, 2), 2);
});

test('concurrency rejects zero, negative, fractional, excessive and nonnumeric', () => {
  for (const bad of [0, -1, 1.5, 5, 99, 'bad', NaN, Infinity]) {
    assert.throws(() => validateConcurrency(bad, 3), /concurrency/);
  }
});

test('directory discovery is deterministic and ignores unrelated Markdown', () => {
  const f = fixture();
  try {
    f.write('b.md'); f.write('a.md');
    f.write('README.md', '# Notes\n\n## Scenarios\nNot a spec');
    f.write('other.md', '# Spec: incomplete');
    assert.deepEqual(resolveSpecs(f.cwd, { specDir: 'test/regression' }),
      ['test/regression/a.md', 'test/regression/b.md']);
  } finally { f.close(); }
});

test('explicit scope preserves order and rejects duplicates or non-spec files', () => {
  const f = fixture();
  try {
    const a = f.write('a.md'), b = f.write('b.md');
    const readme = f.write('README.md', '# Notes');
    assert.deepEqual(resolveSpecs(f.cwd, { specs: [b, a] }), [b, a]);
    assert.throws(() => resolveSpecs(f.cwd, { specs: [a, a] }), /duplicate/);
    assert.throws(() => resolveSpecs(f.cwd, { specs: [readme] }), /not an AgenTeX/);
    assert.throws(() => resolveSpecs(f.cwd, { specs: ['../../outside.md'] }), /not found inside/);
  } finally { f.close(); }
});

test('Arabic saved spec titles remain discoverable', () => {
  const f = fixture();
  try {
    f.write('تسجيل-الدخول.md', '# Spec: تسجيل الدخول\n\n## Scenario\n1. افتح الصفحة');
    const found = resolveSpecs(f.cwd, { specDir: 'test/regression' });
    assert.equal(found.length, 1);
    assert.match(found[0], /تسجيل-الدخول/);
  } finally { f.close(); }
});

test('target resolves explicit localhost and session mode without embedded credentials', () => {
  const f = fixture();
  try {
    const out = resolveTarget(f.cwd, { targetUrl: 'http://127.0.0.1:12743/smoke.html', loginMode: 'none' });
    assert.equal(out.loginMode, 'none');
    assert.equal(out.targetUrl, 'http://127.0.0.1:12743/smoke.html');
    assert.equal(resolveTarget(f.cwd, { targetUrl: out.targetUrl, loginMode: 'session' }).loginMode, 'session');
    assert.throws(() => resolveTarget(f.cwd, { targetUrl: 'file:///tmp/x' }), /HTTP/);
    assert.throws(() => resolveTarget(f.cwd, { targetUrl: 'https://user:password@example.com' }), /embedded credentials/);
  } finally { f.close(); }
});

test('session auth resolution rejects missing, ambiguous, escaping, and invalid states', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveAuthState(f.cwd, null), /saved test\/\.auth state/);
    const dir = path.join(f.cwd, 'test', '.auth');
    fs.mkdirSync(dir);
    const one = path.join(dir, 'alice-state.json');
    fs.writeFileSync(one, JSON.stringify({ cookies: [], origins: [] }));
    assert.equal(resolveAuthState(f.cwd, null), one);
    assert.equal(resolveAuthState(f.cwd, null, 'test/.auth/alice-state.json'), one);
    assert.throws(() => resolveAuthState(f.cwd, null, 'test/regression/other.md'), /inside test\/\.auth/);
    fs.writeFileSync(path.join(dir, 'bob-state.json'), JSON.stringify({ cookies: [], origins: [] }));
    assert.throws(() => resolveAuthState(f.cwd, null), /multiple saved states/);
    fs.writeFileSync(path.join(dir, 'broken-state.json'), '{}');
    assert.throws(() => resolveAuthState(f.cwd, null, 'test/.auth/broken-state.json'), /invalid saved auth state/);
  } finally { f.close(); }
});

test('session auth copies are independent, source-preserving, and removed after use', () => {
  const f = fixture();
  let copies = [];
  try {
    const dir = path.join(f.cwd, 'test', '.auth');
    fs.mkdirSync(dir);
    const source = path.join(dir, 'alice-state.json');
    const original = JSON.stringify({ cookies: [], origins: [] });
    fs.writeFileSync(source, original);
    const workers = assignments(2);
    copies = prepareAuthCopies(workers, resolveAuthState(f.cwd, null));
    assert.equal(copies.length, 2);
    assert.notEqual(workers[0].authStatePath, workers[1].authStatePath);
    fs.writeFileSync(workers[0].authStatePath, JSON.stringify({ cookies: [{ name: 'a' }], origins: [] }));
    assert.equal(fs.readFileSync(workers[1].authStatePath, 'utf8'), original);
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    assert.deepEqual(cleanupAuthCopies(copies), []);
    assert.ok(copies.every(copy => !fs.existsSync(copy.dir)));
    copies = [];
  } finally { cleanupAuthCopies(copies); f.close(); }
});

test('target resolves environment, passes only unresolved testData references', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.cwd, 'config'));
    fs.mkdirSync(path.join(f.cwd, 'environments'));
    fs.writeFileSync(path.join(f.cwd, 'config', 'project.json'), JSON.stringify({ defaultEnvironment: 'qa', login: { mode: 'fresh' } }));
    fs.writeFileSync(path.join(f.cwd, 'environments', 'qa.json'), JSON.stringify({ portalUrl: 'http://127.0.0.1:12743/',
      defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { tester: { name: 'Tester' } } }));
    const out = resolveTarget(f.cwd);
    assert.equal(out.environment, 'qa');
    assert.deepEqual(out.testData.defaults.password, { envSecret: 'QA_PASSWORD' });
    assert.equal(out.loginMode, 'fresh');
    assert.throws(() => resolveTarget(f.cwd, { environment: 'missing' }), /not found/);
  } finally { f.close(); }
});

test('one spec with concurrency 1 runs exactly once', async () => {
  const calls = [];
  const out = await schedule(assignments(1), 1, async a => { calls.push(a.workerId); return { outcome: 'completed' }; }, { timeoutMs: 100 });
  assert.deepEqual(calls, ['worker-1']);
  assert.equal(out.maxActive, 1);
  assert.equal(out.states[0].outcome, 'completed');
});

test('three specs with concurrency 2 never exceed two active workers', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [], active = new Set();
  const run = schedule(assignments(3), 2, async a => {
    const index = Number(a.workerId.split('-')[1]) - 1;
    started.push(index); active.add(index);
    assert.ok(active.size <= 2);
    await gates[index].promise;
    active.delete(index);
    return { outcome: 'completed' };
  }, { timeoutMs: 10000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  gates[2].resolve(); gates[0].resolve();
  const out = await run;
  assert.equal(out.maxActive, 2);
  assert.deepEqual(out.states.map(s => s.workerId), ['worker-1', 'worker-2', 'worker-3']);
  assert.equal(new Set(out.states.map(s => s.session)).size, 3);
});

test('worker crash does not cancel remaining scheduled work', async () => {
  const seen = [];
  const out = await schedule(assignments(3), 2, async a => {
    seen.push(a.workerId);
    if (a.workerId === 'worker-1') throw new Error('crashed');
    return { outcome: 'completed' };
  }, { timeoutMs: 100 });
  assert.equal(seen.length, 3);
  assert.equal(out.states[0].outcome, 'crashed');
  assert.equal(out.states[2].outcome, 'completed');
});

test('watchdog turns never-settling worker into terminal timeout', async () => {
  const out = await schedule(assignments(1), 1, () => new Promise(() => {}),
    { timeoutMs: 10, watchdogGraceMs: 0 });
  assert.equal(out.states[0].outcome, 'timeout');
});

test('coordinator interruption stops pending launches and marks each terminal', async () => {
  const controller = new AbortController(), gate = deferred(), started = [];
  const run = schedule(assignments(3), 1, async a => {
    started.push(a.workerId);
    await gate.promise;
    return { outcome: 'cancelled' };
  }, { timeoutMs: 1000, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); gate.resolve();
  const out = await run;
  assert.deepEqual(started, ['worker-1']);
  assert.deepEqual(out.states.map(s => s.outcome), ['cancelled', 'cancelled', 'cancelled']);
});

test('CLI parsing keeps explicit order and rejects unknown or missing arguments', () => {
  const parsed = parseArgs(['--spec', 'b.md', '--spec', 'a.md', '--concurrency', '2']);
  assert.deepEqual(parsed.specs, ['b.md', 'a.md']);
  assert.equal(parsed.concurrency, 2);
  assert.throws(() => parseArgs(['--concurrency']), /missing value/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /unknown argument/);
  assert.equal(parseArgs(['--spec', 'a.md', '--run-handoff', 'job/handoff.json']).runHandoff, 'job/handoff.json');
  assert.equal(parseArgs(['--spec', 'a.md', '--invocation-id', 'job-12345']).invocationId, 'job-12345');
  assert.throws(() => parseArgs(['--run-handoff']), /missing value/);
  assert.throws(() => parseArgs(['--run-handoff', 'a', '--run-handoff', 'b']), /duplicate/);
});

test('handoff path validation accepts relative and absolute destinations, rejects missing parent and collisions', () => {
  const f = fixture();
  try {
    const job = path.join(f.cwd, 'job');
    fs.mkdirSync(job);
    const file = path.join(job, 'handoff.json');
    assert.equal(resolveRunHandoff(f.cwd, 'job/handoff.json'), file);
    assert.equal(resolveRunHandoff(f.cwd, file), file);
    assert.throws(() => resolveRunHandoff(f.cwd, 'missing/handoff.json'), /parent directory/);
    fs.writeFileSync(path.join(f.cwd, 'not-a-directory'), 'fixture');
    assert.throws(() => resolveRunHandoff(f.cwd, 'not-a-directory/handoff.json'), /parent directory/);
    assert.throws(() => resolveRunHandoff(f.cwd, ''), /path is required/);
    fs.writeFileSync(file, 'original');
    assert.throws(() => resolveRunHandoff(f.cwd, file), /already exists/);
  } finally { f.close(); }
});

test('atomic handoff publication refuses a destination created after validation', () => {
  const f = fixture();
  try {
    const file = resolveRunHandoff(f.cwd, 'handoff.json');
    fs.writeFileSync(file, 'other invocation');
    assert.throws(() => writeRunHandoff(file, 'executions/execu_fixture'), /EEXIST/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'other invocation');
    assert.deepEqual(fs.readdirSync(f.cwd).filter(name => name.startsWith('.agentex-run-handoff-')), []);
  } finally { f.close(); }
});

test('missing handoff parent fails before allocating a run', async () => {
  const f = fixture();
  try {
    const spec = f.write('a.md');
    await assert.rejects(runParallel(runOptions(f, spec, writePassingResult,
      { runHandoff: 'missing/handoff.json' })), /parent directory/);
    assert.equal(fs.existsSync(path.join(f.cwd, 'executions')), false);
  } finally { f.close(); }
});

test('invalid or unpaired invocation identity fails before allocating a run', async () => {
  const f = fixture();
  try {
    const spec = f.write('a.md');
    await assert.rejects(runParallel(runOptions(f, spec, writePassingResult,
      { invocationId: 'job-12345' })), /requires a run handoff/);
    await assert.rejects(runParallel(runOptions(f, spec, writePassingResult,
      { runHandoff: 'handoff.json', invocationId: 'bad' })), /invocation ID/);
    assert.equal(fs.existsSync(path.join(f.cwd, 'executions')), false);
  } finally { f.close(); }
});

test('successful run publishes minimal handoff before worker and finalizes exactly once', async () => {
  const f = fixture();
  try {
    const spec = f.write('a.md');
    const job = path.join(f.cwd, 'job');
    fs.mkdirSync(job);
    const handoffFile = path.join(job, 'handoff.json');
    const invocationId = 'job-success-12345';
    let calls = 0;
    const out = await runParallel(runOptions(f, spec, assignment => {
      calls++;
      assert.ok(fs.existsSync(path.join(assignment.executionDir, 'coordinator-owner.json')));
      const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
      assert.deepEqual(handoff, { schemaVersion: 1, runId: path.basename(assignment.runDir),
        runDir: assignment.runDir, invocationId });
      assert.equal(fs.existsSync(path.join(assignment.executionDir, 'run-summary.json')), false);
      return writePassingResult(assignment);
    }, { runHandoff: 'job/handoff.json', invocationId }));
    const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
    assert.equal(calls, 1);
    assert.equal(out.status, 'passed');
    assert.equal(out.runDir, handoff.runDir);
    assert.equal(out.terminal, 1);
    const runRoot = path.join(f.cwd, handoff.runDir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runRoot, 'coordinator-owner.json'))).invocationId, invocationId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runRoot, 'run-summary.json'))).schemaVersion, 2);
    for (const name of ['report.md', 'extent-report.html', 'parallel-timing.json']) {
      assert.ok(fs.existsSync(path.join(runRoot, name)));
    }
    assert.deepEqual(fs.readdirSync(job), ['handoff.json']);
  } finally { f.close(); }
});

test('worker startup throw leaves exact handoff and original blocked classification', async () => {
  const f = fixture();
  try {
    const spec = f.write('crash.md');
    const handoffFile = path.join(f.cwd, 'handoff.json');
    const out = await runParallel(runOptions(f, spec, assignment => {
      assert.equal(JSON.parse(fs.readFileSync(handoffFile)).runDir, assignment.runDir);
      throw new Error('mock startup crash');
    }, { runHandoff: handoffFile, invocationId: 'job-crash-12345' }));
    const handoff = JSON.parse(fs.readFileSync(handoffFile));
    const summary = JSON.parse(fs.readFileSync(path.join(f.cwd, handoff.runDir, 'run-summary.json')));
    assert.equal(out.status, 'blocked');
    assert.equal(out.runDir, handoff.runDir);
    assert.equal(summary.summary.blocked, 1);
    assert.equal(summary.testCases[0].status, 'blocked');
  } finally { f.close(); }
});

test('existing handoff cannot be overwritten and no second run is allocated', async () => {
  const f = fixture();
  try {
    const spec = f.write('a.md');
    const handoffFile = path.join(f.cwd, 'handoff.json');
    fs.writeFileSync(handoffFile, '{"other":"run"}\n');
    await assert.rejects(runParallel(runOptions(f, spec, writePassingResult,
      { runHandoff: handoffFile })), /already exists/);
    assert.equal(fs.readFileSync(handoffFile, 'utf8'), '{"other":"run"}\n');
    assert.equal(fs.existsSync(path.join(f.cwd, 'executions')), false);
  } finally { f.close(); }
});

test('two simultaneous invocations keep distinct exact run and handoff identities', async () => {
  const f = fixture();
  try {
    const spec = f.write('a.md');
    const gate = deferred();
    const handoffA = path.join(f.cwd, 'handoff-A.json');
    const handoffB = path.join(f.cwd, 'handoff-B.json');
    const first = runParallel(runOptions(f, spec, async assignment => {
      assert.equal(JSON.parse(fs.readFileSync(handoffA)).runDir, assignment.runDir);
      await gate.promise;
      return writePassingResult(assignment);
    }, { runHandoff: handoffA, invocationId: 'job-A-12345678' }));
    const second = runParallel(runOptions(f, spec, assignment => {
      assert.equal(JSON.parse(fs.readFileSync(handoffB)).runDir, assignment.runDir);
      return writePassingResult(assignment);
    }, { runHandoff: handoffB, invocationId: 'job-B-12345678' }));
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'passed');
    assert.equal(b.status, 'passed');
    assert.notEqual(a.runDir, b.runDir);
    assert.equal(JSON.parse(fs.readFileSync(handoffA)).runDir, a.runDir);
    assert.equal(JSON.parse(fs.readFileSync(handoffB)).runDir, b.runDir);
    assert.equal(fs.existsSync(path.join(f.cwd, 'latest-run.json')), false);
  } finally { f.close(); }
});

test('browser list matching requires exact owned session, not a substring', () => {
  assert.equal(hasSession('  - pass-123 open', 'pass-123'), true);
  assert.equal(hasSession('  - pass-123-other open', 'pass-123'), false);
  assert.equal(hasSession('  (no browsers)', 'pass-123'), false);
});

test('mocked end-to-end coordinator writes one deterministic HTML run for 2 PASS + 1 product FAIL', async () => {
  const f = fixture();
  try {
    const specs = [f.write('a.md'), f.write('b.md'), f.write('c.md')];
    const fakeCli = path.join(f.cwd, 'fake-cli.js');
    fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
    let active = 0, maxActive = 0;
    const worker = async assignment => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      const isFail = assignment.spec.endsWith('c.md');
      const shot = `browser-sessions/${assignment.session}/screenshots/evidence.png`;
      fs.writeFileSync(path.join(assignment.executionDir, shot), 'fixture screenshot');
      const now = new Date().toISOString();
      const status = isFail ? 'failed' : 'passed';
      const result = { schemaVersion: 1, runDir: assignment.runDir, session: assignment.session,
        spec: assignment.spec, status, startedAt: now, endedAt: now, durationMs: 1,
        scenarios: [{ name: `Scenario ${assignment.workerId}`, session: assignment.session, status,
          steps: [{ desc: 'Check fixture', status }], screenshots: [{ path: shot }] }],
        defects: isFail ? [{ title: 'Controlled mismatch', severity: 'Medium', expected: 'A', actual: 'B', evidence: [shot] }] : [],
        failures: isFail ? [{ kind: 'product', detail: 'expected A, observed B' }] : [],
        cleanup: { attempted: true, closed: true, error: null } };
      fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify(result));
      active--;
      return { outcome: 'completed' };
    };
    const preflight = { node: { ok: true, version: process.version },
      'playwright-cli': { ok: true, status: 'READY', version: 'fixture', command: { executable: process.execPath, args: [fakeCli] } } };
    const out = await runParallel({ cwd: f.cwd, specs, targetUrl: 'http://127.0.0.1:12743/smoke.html',
      loginMode: 'none', concurrency: 2, worker, preflight });
    const root = path.join(f.cwd, out.runDir);
    assert.equal('invocationId' in JSON.parse(fs.readFileSync(path.join(root, 'coordinator-owner.json'))), false);
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'run-summary.json'), 'utf8'));
    const timing = JSON.parse(fs.readFileSync(path.join(root, 'parallel-timing.json'), 'utf8'));
    assert.equal(out.status, 'failed');
    assert.equal(summary.summary.passed, 2);
    assert.equal(summary.summary.failed, 1);
    assert.equal(summary.defects.length, 1);
    assert.equal(summary.run.mode, 'parallel');
    assert.equal(maxActive, 2);
    assert.equal(timing.maxActive, 2);
    assert.equal(timing.browserList.ok, true);
    assert.deepEqual(timing.browserList.ownedRemaining, []);
    assert.equal(new Set(summary.run.sessions.map(s => s.session)).size, 3);
    assert.ok(fs.existsSync(path.join(root, 'extent-report.html')));
    assert.ok(fs.readFileSync(path.join(root, 'extent-report.html'), 'utf8').includes('Controlled mismatch'));
  } finally { f.close(); }
});

test('coordinator gives session workers private auth state without persisting its path or changes', async () => {
  const f = fixture();
  try {
    const spec = f.write('auth.md');
    const authDir = path.join(f.cwd, 'test', '.auth');
    fs.mkdirSync(authDir);
    const source = path.join(authDir, 'tester-state.json');
    const original = JSON.stringify({ cookies: [], origins: [] });
    fs.writeFileSync(source, original);
    const fakeCli = path.join(f.cwd, 'fake-cli.js');
    fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
    const preflight = { node: { ok: true, version: process.version },
      'playwright-cli': { ok: true, status: 'READY', version: 'fixture', command: { executable: process.execPath, args: [fakeCli] } } };
    let privatePath;
    const worker = async assignment => {
      privatePath = assignment.authStatePath;
      assert.ok(privatePath.startsWith(os.tmpdir()));
      fs.writeFileSync(privatePath, JSON.stringify({ cookies: [{ name: 'refreshed' }], origins: [] }));
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
        schemaVersion: 1, runDir: assignment.runDir, session: assignment.session,
        spec: assignment.spec, status: 'passed', startedAt: now, endedAt: now, durationMs: 1,
        scenarios: [{ name: 'Auth check', session: assignment.session, status: 'passed', steps: [{ desc: 'Check', status: 'passed' }] }],
        defects: [], failures: [], cleanup: { attempted: true, closed: true, error: null }
      }));
      return { outcome: 'completed' };
    };
    const out = await runParallel({ cwd: f.cwd, specs: [spec], targetUrl: 'http://127.0.0.1:12743/smoke.html',
      loginMode: 'session', worker, preflight });
    assert.equal(out.status, 'passed');
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    assert.equal(fs.existsSync(privatePath), false);
    const root = path.join(f.cwd, out.runDir);
    assert.equal('invocationId' in JSON.parse(fs.readFileSync(path.join(root, 'coordinator-owner.json'))), false);
    for (const name of ['parallel-manifest.json', 'run-summary.json', 'report.md', 'parallel-timing.json']) {
      const artifact = fs.readFileSync(path.join(root, name), 'utf8');
      assert.equal(artifact.includes(privatePath), false);
      assert.equal(artifact.includes('refreshed'), false);
    }
  } finally { f.close(); }
});
