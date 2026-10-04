'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runParallel } = require('./parallel.js');
const { makeInvocationId, createJobPaths, coordinatorArgs, imageReferences, safeCopy,
  runQualityGate, azureOutput } = require('./azure_quality_gate.js');

const TEMPLATE = path.resolve(__dirname, '..', 'templates', 'ci', 'azure-quality-gate.yml');
const EXAMPLE = path.resolve(__dirname, '..', 'templates', 'ci', 'azure-quality-gate.example.yml');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-azure-flow-'));
  const specDir = 'test/regression';
  fs.mkdirSync(path.join(cwd, specDir), { recursive: true });
  fs.writeFileSync(path.join(cwd, specDir, 'check.md'), '# Spec: Azure fixture\n\n## Scenario\n1. Check\n');
  const tempDirectory = path.join(cwd, 'agent-temp');
  fs.mkdirSync(tempDirectory);
  const fakeCli = path.join(cwd, 'fake-cli.js');
  fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
  const preflight = { node: { ok: true, version: process.version },
    'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
      command: { executable: process.execPath, args: [fakeCli] } } };
  const mockExecute = status => async ({ args, handoff, invocationId }) => {
    assert.equal(args[args.indexOf('--run-handoff') + 1], handoff);
    assert.equal(args[args.indexOf('--invocation-id') + 1], invocationId);
    assert.equal(fs.existsSync(handoff), false);
    const worker = assignment => {
      if (status === 'blocked') throw new Error('fixture worker unavailable');
      const now = new Date().toISOString();
      const image = `browser-sessions/${assignment.session}/screenshots/evidence.png`;
      fs.writeFileSync(path.join(assignment.executionDir, image), 'fixture image');
      fs.writeFileSync(path.join(assignment.executionDir, '.env'), 'AZURE_PAT=DO_NOT_PUBLISH');
      fs.writeFileSync(path.join(assignment.sessionDir, 'logs', 'token.txt'), 'DO_NOT_PUBLISH');
      fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
        schemaVersion: 1, runDir: assignment.runDir, session: assignment.session,
        spec: assignment.spec, status, startedAt: now, endedAt: now, durationMs: 1,
        scenarios: [{ name: 'Fixture case', session: assignment.session, status,
          screenshots: [{ path: image }], steps: [{ desc: 'Check', status }] }],
        defects: status === 'failed' ? [{ title: 'Controlled mismatch', severity: 'Medium',
          expected: 'A', actual: 'B', evidence: [image] }] : [],
        failures: status === 'failed' ? [{ kind: 'product', detail: 'controlled mismatch' }] : [],
        cleanup: { attempted: true, closed: true, error: null }
      }));
      return { outcome: 'completed' };
    };
    const out = await runParallel({ cwd, specDir, targetUrl: 'http://127.0.0.1:12743/',
      loginMode: 'none', worker, preflight, runHandoff: handoff, invocationId });
    return out.status === 'passed' ? 0 : out.status === 'failed' ? 1 : 2;
  };
  return { cwd, specDir, tempDirectory, mockExecute,
    close: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const options = f => ({ cwd: f.cwd, tempDirectory: f.tempDirectory,
  buildId: '4711', jobId: '12345678-1234-1234-1234-123456789abc', jobAttempt: '1', specDir: f.specDir });

test('identity uses build, job attempt, and UUID; retry and concurrent paths cannot collide', () => {
  const f = fixture();
  try {
    const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const a = makeInvocationId({ buildId: '1', jobId: '12345678-aaaa', jobAttempt: '1', uuid });
    const retry = makeInvocationId({ buildId: '1', jobId: '12345678-aaaa', jobAttempt: '2', uuid });
    const other = makeInvocationId({ buildId: '1', jobId: '12345678-aaaa', jobAttempt: '1',
      uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    assert.notEqual(a, retry); assert.notEqual(a, other);
    const first = createJobPaths(f.tempDirectory, a);
    const second = createJobPaths(f.tempDirectory, retry);
    assert.notEqual(first.handoff, second.handoff);
    assert.ok(first.handoff.startsWith(f.tempDirectory));
    assert.throws(() => createJobPaths(f.tempDirectory, a), /EEXIST/);
  } finally { f.close(); }
});

test('coordinator arguments are separate values, never shell-concatenated', () => {
  const args = coordinatorArgs({ specDir: 'test/my suite', environment: 'qa',
    handoff: 'C:/job/run handoff.json', invocationId: 'job-12345678' });
  assert.deepEqual(args.slice(1, 3), ['--spec-dir', 'test/my suite']);
  assert.equal(args[args.indexOf('--run-handoff') + 1], 'C:/job/run handoff.json');
  assert.equal(args[args.indexOf('--environment') + 1], 'qa');
  assert.throws(() => coordinatorArgs({ specDir: '', handoff: 'x', invocationId: 'job-12345678' }), /spec directory/);
});

test('offline Azure PASS flow stages only verified core artifacts and allows release', async () => {
  const f = fixture();
  try {
    const out = await runQualityGate({ ...options(f), execute: f.mockExecute('passed') });
    assert.equal(out.coordinatorExit, 0);
    assert.equal(out.gateResult.decision, 'PASS'); assert.equal(out.exitCode, 0);
    assert.equal(out.releaseEligible, true); assert.equal(out.artifactReady, true);
    assert.deepEqual(out.stagedFiles.sort(), ['extent-report.html', 'gate-result.json', 'report.md', 'run-summary.json']);
    assert.equal(fs.existsSync(path.join(out.artifactPath, '.env')), false);
    assert.equal(fs.existsSync(path.join(out.artifactPath, 'browser-sessions')), false);
    assert.ok(out.runId.startsWith('execu_'));
  } finally { f.close(); }
});

test('offline Azure product FAIL reaches gate and still stages selected evidence', async () => {
  const f = fixture();
  try {
    const out = await runQualityGate({ ...options(f), execute: f.mockExecute('failed') });
    assert.equal(out.coordinatorExit, 1);
    assert.equal(out.gateResult.decision, 'FAIL'); assert.equal(out.exitCode, 1);
    assert.equal(out.releaseEligible, false); assert.equal(out.artifactReady, true);
    assert.ok(out.stagedFiles.includes('parallel-timing.json'));
    assert.ok(out.stagedFiles.includes('bugs/bug-list.md'));
    assert.ok(out.stagedFiles.some(file => file.endsWith('/screenshots/evidence.png')));
    assert.equal(fs.existsSync(path.join(out.artifactPath, '.env')), false);
    assert.equal(fs.existsSync(path.join(out.artifactPath, 'browser-sessions', 'logs')), false);
  } finally { f.close(); }
});

test('offline Azure infrastructure REVIEW blocks release and retains available reports', async () => {
  const f = fixture();
  try {
    const out = await runQualityGate({ ...options(f), execute: f.mockExecute('blocked') });
    assert.equal(out.coordinatorExit, 2);
    assert.equal(out.gateResult.decision, 'REVIEW'); assert.equal(out.exitCode, 2);
    assert.equal(out.releaseEligible, false); assert.equal(out.artifactReady, true);
    assert.ok(out.stagedFiles.includes('gate-result.json'));
    assert.ok(out.stagedFiles.includes('parallel-timing.json'));
  } finally { f.close(); }
});

test('missing handoff and bridge ownership error cannot publish or release', async () => {
  const f = fixture();
  try {
    const missing = await runQualityGate({ ...options(f), execute: async () => 2 });
    assert.equal(missing.gateResult.decision, 'REVIEW');
    assert.equal(missing.releaseEligible, false); assert.equal(missing.artifactReady, false);
    const swapped = await runQualityGate({ ...options(f), execute: async ({ handoff }) => {
      fs.writeFileSync(handoff, JSON.stringify({ schemaVersion: 1, runId: 'execu_old',
        runDir: 'executions/execu_old', invocationId: 'stale-job-12345678' }));
      return 0;
    } });
    assert.equal(swapped.gateResult.decision, 'REVIEW');
    assert.equal(swapped.releaseEligible, false); assert.equal(swapped.artifactReady, false);
  } finally { f.close(); }
});

test('owned but unfinished run publishes only safe identity diagnostic and blocks release', async () => {
  const f = fixture();
  try {
    const out = await runQualityGate({ ...options(f), execute: async ({ handoff, invocationId }) => {
      const runId = 'execu_partial';
      const runDir = `executions/${runId}`;
      const runRoot = path.join(f.cwd, runDir);
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(runRoot, 'coordinator-owner.json'), JSON.stringify({
        schemaVersion: 1, runId, invocationId, pid: process.pid, startedAt: new Date().toISOString() }));
      fs.writeFileSync(handoff, JSON.stringify({ schemaVersion: 1, runId, runDir, invocationId }));
      fs.writeFileSync(path.join(runRoot, '.env'), 'DO_NOT_PUBLISH');
      return 2;
    } });
    assert.equal(out.gateResult.decision, 'REVIEW');
    assert.equal(out.gateResult.reasons[0].code, 'run-not-finalized');
    assert.equal(out.releaseEligible, false); assert.equal(out.artifactReady, true);
    assert.deepEqual(out.stagedFiles, ['coordinator-owner.json']);
    assert.equal(fs.existsSync(path.join(out.artifactPath, '.env')), false);
  } finally { f.close(); }
});

test('artifact references cannot escape the exact run or include logs and auth', () => {
  const f = fixture();
  try {
    const runRoot = path.join(f.cwd, 'executions', 'execu_fixture');
    const stage = path.join(f.cwd, 'stage');
    fs.mkdirSync(runRoot, { recursive: true }); fs.mkdirSync(stage);
    fs.writeFileSync(path.join(f.cwd, '.env'), 'secret');
    assert.equal(safeCopy(runRoot, stage, '../../.env'), false);
    assert.equal(safeCopy(runRoot, stage, 'test/.auth/state.json'), false);
    const refs = imageReferences({ testCases: [{ screenshots: [
      { path: 'browser-sessions/s/screenshots/a.png' },
      { path: 'browser-sessions/s/logs/token.txt' },
      { path: 'browser-sessions/../screenshots/evil.png' }], steps: [] }], defects: [] });
    assert.deepEqual(refs, ['browser-sessions/../screenshots/evil.png', 'browser-sessions/s/screenshots/a.png']);
    assert.equal(safeCopy(runRoot, stage, refs[0]), false);
  } finally { f.close(); }
});

test('Azure output escaping cannot inject a second logging command', () => {
  assert.equal(azureOutput('AgentexRunId', 'x%\ny'),
    '##vso[task.setvariable variable=AgentexRunId;isOutput=true]x%AZP25%0Ay');
});

test('inactive Azure template and example are structurally bounded and non-deploying', () => {
  const yaml = fs.readFileSync(TEMPLATE, 'utf8');
  const example = fs.readFileSync(EXAMPLE, 'utf8');
  for (const content of [yaml, example]) {
    assert.equal(content.includes('\t'), false);
    assert.match(content, /^jobs:/m);
    assert.doesNotMatch(content, /Get-ChildItem|Sort-Object|ls -t|latest-run|newest execution|finalizeParallel|ci_gate\.js/);
    assert.doesNotMatch(content, /AzureWebApp|AzureCLI@|deployment:|sk-[A-Za-z0-9]/);
  }
  assert.match(yaml, /NodeTool@0/);
  assert.match(yaml, /azure_quality_gate\.js/);
  assert.match(yaml, /AGENT_TEMPDIRECTORY: \$\(Agent\.TempDirectory\)/);
  assert.match(yaml, /SYSTEM_JOBID: \$\(System\.JobId\)/);
  assert.match(yaml, /AgentexCodexHome: \$\{\{ parameters\.codexHome \}\}/);
  assert.match(yaml, /CODEX_HOME: \$\(AgentexCodexHome\)/);
  assert.match(yaml, /PublishBuildArtifacts@1/);
  assert.match(yaml, /condition: and\(always\(\), eq\(variables\['RunGate\.AgentexArtifactReady'\], 'true'\)\)/);
  assert.doesNotMatch(yaml, /summary\.failed|summary\.blocked|testCases|gate-result\.json|executions\/execu_/);
  assert.match(example, /trigger: none/);
  assert.match(example, /dependencies\.AgentexQualityGate\.outputs\['RunGate\.AgentexReleaseEligible'\]/);
  assert.match(example, /condition: and\(succeeded\(\), eq\(.+, 'true'\)\)/);
});
