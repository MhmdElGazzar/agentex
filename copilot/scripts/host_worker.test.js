'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPackage } = require('./build_package.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-host-worker-'));
const pkg = path.join(scratch, 'package');
buildPackage(pkg);
const host = require(path.join(pkg, 'scripts', 'host_worker.js'));
test.after(() => {
  const real = fs.realpathSync(scratch);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(real).startsWith('agentex-host-worker-')) throw new Error('unsafe cleanup');
  fs.rmSync(real, { recursive: true, force: true });
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(scratch, 'consumer-'));
  fs.mkdirSync(path.join(cwd, 'test', 'suite1'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'executions'));
  const cli = path.join(cwd, 'fake-cli.js');
  fs.writeFileSync(cli, `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), action = args.find(x => ['open','run-code','close','list','screenshot','console','requests'].includes(x));
const stateFile = path.join(process.cwd(), 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { opened:false, done:false, clicks:0 };
if (action === 'list') console.log('(no browsers)');
else if (action === 'open') { state.opened=true; fs.writeFileSync(stateFile,JSON.stringify(state)); setTimeout(()=>console.log('opened'),40); }
else if (action === 'close') console.log('closed');
else if (action === 'screenshot') { const file=args.find(x=>x.startsWith('--filename=')).slice(11); fs.writeFileSync(file,'image'); console.log('saved'); }
else if (action === 'console' || action === 'requests') console.log('[]');
else if (action === 'run-code') {
  const code=args[args.indexOf('run-code')+1];
  let ok=false;
  if (code.includes('getByRole')) {
    const label=JSON.parse(code.match(/name:("[^"]+")/)[1]);
    ok=state.opened && ['Click me','Reveal confirmation','Increment count'].includes(label);
    if(ok) { if(label==='Increment count') state.clicks++; else state.done=true; fs.writeFileSync(stateFile,JSON.stringify(state)); }
  } else {
    const label=JSON.parse(code.match(/getByText\\(("[^"]+")/)[1]);
    ok=state.opened && (label==='AgenTeX Sandbox' || label==='AgenTeX local smoke' ||
      (label==='Done' && state.done) || (label==='Confirmation visible' && state.done) ||
      (label==='1' && state.clicks===1));
  }
  console.log('AGENTEX_STEP_RESULT:'+JSON.stringify({ok,reason:ok?null:'expected visible text absent'}));
}
`);
  return { cwd, cli, write(name, body) {
    const rel = `test/suite1/${name}.md`;
    fs.writeFileSync(path.join(cwd, rel), body);
    return rel;
  } };
}
const preflight = cli => ({ node: { ok: true, version: process.version },
  'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
    command: { executable: process.execPath, args: [cli] } } });
const pass = (click = false) => '# Spec: Content driven\n\n## Scenario\n1. Open the configured application\n2. Verify `AgenTeX Sandbox` is visible\n' +
  (click ? '3. Click `Click me`\n4. Verify `Done` is visible\n' : '3. Verify `AgenTeX Sandbox` is visible\n');
const fail = '# Spec: Content driven\n\n## Scenario\n1. Open the configured application\n2. Click `Click me`\n3. Verify `This text must not exist` is visible\n';

test('renamed controlled failure is determined by content, not filename', async () => {
  const f = fixture();
  const specs = [f.write('sunrise', fail), f.write('completely-unrelated', fail)];
  const result = await host.runCopilotParallel({ cwd: f.cwd, specs, targetUrl: 'http://127.0.0.1:1/',
    loginMode: 'none', concurrency: 2, preflight: preflight(f.cli) });
  assert.equal(result.summary.failed, 2);
  assert.equal(result.summary.blocked, 0);
  assert.ok(result.timing.workerStates.every(s => s.outcome === 'completed'));
  assert.ok(result.summary.failed === result.summary.total);
  assert.ok(result.summary.failed > 0 && result.summary.passed === 0);
});

test('package-only unseen spec flow executes all steps with concurrency two and aggregate 2 PASS 1 product FAIL', async () => {
  const f = fixture();
  const specs = [f.write('unseen-heading-862', pass()), f.write('wild-click-path', pass(true)),
    f.write('zebra-negative', fail)];
  const before = new Set(Object.keys(require.cache));
  const result = await host.runCopilotParallel({ cwd: f.cwd, specs, targetUrl: 'http://127.0.0.1:1/',
    loginMode: 'none', concurrency: 2, preflight: preflight(f.cli) });
  const loaded = Object.keys(require.cache).filter(file => !before.has(file));
  assert.ok(loaded.every(file => file.startsWith(pkg)), 'no source-checkout module fallback');
  assert.deepEqual([result.summary.passed, result.summary.failed, result.summary.blocked], [2, 1, 0]);
  assert.equal(result.timing.concurrency, 2);
  assert.equal(result.timing.maxActive, 2);
  assert.equal(new Set(result.timing.workerStates.map(s => s.session)).size, 3);
  assert.equal(result.codexInvocations, 0);
  assert.deepEqual(result.timing.browserList.ownedRemaining, []);
  for (const state of result.timing.workerStates) {
    const record = JSON.parse(fs.readFileSync(path.join(f.cwd, result.runDir, 'browser-sessions', state.session, 'executor-result.json')));
    assert.equal(record.cleanup.closed, true);
    if (record.status === 'passed') assert.equal(record.coverage.executedStepIds.length,
      host.parseSpec(fs.readFileSync(path.join(f.cwd, record.spec), 'utf8')).steps.length);
  }
});

test('omitted required steps in a worker PASS are rejected as BLOCKED automation', async () => {
  const f = fixture(), spec = f.write('incomplete', pass(true));
  const { runParallel } = require(path.join(pkg, 'core', 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const result = await runParallel({ cwd: f.cwd, specs: [spec], targetUrl: 'http://127.0.0.1:1/',
    loginMode: 'none', preflight: preflight(f.cli), resultValidator: host.validateCoverage,
    worker: assignment => {
      const now = new Date().toISOString();
      fs.writeFileSync(assignment.artifacts.result, JSON.stringify({
        schemaVersion: 1, runDir: assignment.runDir, session: assignment.session, spec: assignment.spec,
        status: 'passed', startedAt: now, endedAt: now, durationMs: 0,
        scenarios: [{ name: 'Incomplete', session: assignment.session, status: 'passed',
          steps: [{ desc: 'Open', status: 'passed' }] }],
        defects: [], failures: [], cleanup: { attempted: true, closed: true, error: null },
        coverage: { specSha256: host.parseSpec(fs.readFileSync(path.join(f.cwd, spec), 'utf8')).digest,
          executedStepIds: ['step-1'] },
      }));
      return { outcome: 'completed' };
    } });
  assert.equal(result.summary.passed, 0);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.blocked, 1);
});

test('unknown requested action fails closed instead of PASS', () => {
  assert.throws(() => host.parseSpec('# Spec: Unseen\n\n## Scenario\n1. Open the application\n2. Transfer money\n'),
    /unsupported scenario instruction/);
  assert.throws(() => host.parseSpec('# Spec: Unseen\n\n## Scenario\n1. Open the application and transfer money\n'),
    /unsupported scenario instruction/);
  assert.throws(() => host.parseSpec('# Spec: Unseen\n\n## Scenario\n1. Open the application\n\n## Preconditions\n- Transfer money\n'),
    /unsupported specification section/);
});
