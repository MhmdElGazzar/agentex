'use strict';

// Azure-facing orchestration only. QA decisions remain in evaluate_release_gate.js.
// No Azure API calls, run discovery, finalization, or deployment occur here.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { evaluateHandoffRun, resolveHandoffFile, resolveOwnedRun } = require('./evaluate_handoff_run.js');

const COORDINATOR = path.join(__dirname, 'parallel.js');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function makeInvocationId({ buildId, jobId, jobAttempt, uuid = crypto.randomUUID() }) {
  if (!/^\d+$/.test(String(buildId || '')) || !/^[A-Za-z0-9-]{8,64}$/.test(String(jobId || '')) ||
    !/^\d+$/.test(String(jobAttempt || '')) || !/^[0-9a-f-]{36}$/.test(uuid)) {
    throw new Error('Azure build/job/attempt identity is required');
  }
  const id = `b${buildId}-j${jobId}-a${jobAttempt}-${uuid}`;
  if (id.length > 128) throw new Error('Azure job identity is too long');
  return id;
}

function createJobPaths(tempDirectory, invocationId) {
  const root = fs.realpathSync(tempDirectory);
  const parent = path.join(root, 'agentex-quality');
  fs.mkdirSync(parent, { recursive: true });
  const jobDir = path.join(parent, invocationId);
  fs.mkdirSync(jobDir); // No reuse: a duplicate job identity is an error.
  return { jobDir, handoff: path.join(jobDir, 'run-handoff.json'), stageDir: path.join(jobDir, 'artifact') };
}

function coordinatorArgs({ specDir, environment, concurrency = 2, workerTimeoutMs = 900000, handoff, invocationId }) {
  if (typeof specDir !== 'string' || !specDir.trim()) throw new Error('spec directory is required');
  if (!Number.isInteger(Number(concurrency)) || Number(concurrency) < 1 || Number(concurrency) > 4) {
    throw new Error('concurrency must be 1..4');
  }
  if (!Number.isInteger(Number(workerTimeoutMs)) || Number(workerTimeoutMs) < 1000 || Number(workerTimeoutMs) > 3600000) {
    throw new Error('worker timeout must be 1000..3600000 ms');
  }
  const args = [COORDINATOR, '--spec-dir', specDir, '--concurrency', String(concurrency),
    '--timeout-ms', String(workerTimeoutMs), '--run-handoff', handoff, '--invocation-id', invocationId];
  if (environment) args.push('--environment', environment);
  return args;
}

function runCoordinator({ cwd, args, signal }) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(process.execPath, args, { cwd, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, AGENTEX_CI: '1' } }); }
    catch { resolve(2); return; }
    let settled = false;
    const finish = code => { if (settled) return; settled = true;
      signal?.removeEventListener('abort', abort); resolve(Number.isInteger(code) ? code : 2); };
    const abort = () => { try { child.kill('SIGINT'); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Drain, but never forward model/tool transcripts or environment-derived errors.
    child.stdout?.resume(); child.stderr?.resume();
    child.on('error', () => finish(2));
    child.on('close', code => finish(code));
  });
}

function verifiedRun(cwd, handoff, invocationId) {
  const file = resolveHandoffFile(cwd, handoff);
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  return resolveOwnedRun(cwd, identity, invocationId);
}

function safeCopy(runRoot, stageDir, relative) {
  const normalized = relative.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relative) ||
    normalized.split('/').some(part => part === '..' || part === '.' || part === '')) return false;
  const source = path.resolve(runRoot, ...normalized.split('/'));
  if (!inside(runRoot, source)) return false;
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(fs.realpathSync(runRoot), fs.realpathSync(source))) return false;
  } catch { return false; }
  const destination = path.join(stageDir, ...normalized.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  return true;
}

function imageReferences(summary) {
  const refs = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const normalized = value.replace(/\\/g, '/');
    if ((/^browser-sessions\/[^/]+\/screenshots\/.+\.(png|jpe?g|webp)$/i.test(normalized) ||
      /^bugs\/screenshots\/.+\.(png|jpe?g|webp)$/i.test(normalized))) refs.add(normalized);
  };
  for (const item of Array.isArray(summary?.testCases) ? summary.testCases : []) {
    for (const shot of item?.screenshots || []) add(shot?.path);
    for (const step of item?.steps || []) {
      for (const evidence of step?.evidence || []) add(evidence?.path);
      add(step?.uiCheck?.baselineImage); add(step?.uiCheck?.actualImage);
    }
    for (const evidence of item?.flaky?.attempt1Evidence || []) add(typeof evidence === 'string' ? evidence : evidence?.path);
    for (const evidence of item?.flaky?.attempt2Evidence || []) add(typeof evidence === 'string' ? evidence : evidence?.path);
    for (const deferred of item?.deferred || []) { add(deferred?.baselineImage); add(deferred?.actualImage); }
  }
  for (const defect of Array.isArray(summary?.defects) ? summary.defects : []) {
    for (const evidence of defect?.evidence || []) add(evidence);
  }
  return [...refs].sort();
}

function stageArtifacts({ cwd, handoff, invocationId, stageDir, decision }) {
  const { runRoot, runDir } = verifiedRun(cwd, handoff, invocationId);
  fs.mkdirSync(stageDir); // New job-private directory; never publish an old staging tree.
  const copied = [];
  const copy = relative => { if (safeCopy(runRoot, stageDir, relative)) copied.push(relative); };
  for (const relative of ['run-summary.json', 'gate-result.json', 'report.md', 'extent-report.html']) copy(relative);
  if (decision !== 'PASS') {
    copy('coordinator-owner.json'); // Safe identity diagnostic for an owned but unfinished run.
    copy('parallel-timing.json');
    copy('bugs/bug-list.md');
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(runRoot, 'run-summary.json'), 'utf8'));
      for (const reference of imageReferences(summary)) copy(reference);
    } catch {} // Preserve available core diagnostics for an incomplete/malformed run.
  }
  return { runId: path.basename(runDir), copied, ready: copied.length > 0 };
}

async function runQualityGate({ cwd, tempDirectory = os.tmpdir(), buildId, jobId, jobAttempt,
  specDir, environment, concurrency = 2, workerTimeoutMs = 900000, flakyPolicy = 'review',
  artifactName = 'agentex-quality', publishArtifacts = true,
  execute = runCoordinator, bridge = evaluateHandoffRun, signal } = {}) {
  cwd = fs.realpathSync(cwd);
  if (!['review', 'fail', 'allow'].includes(flakyPolicy) || !/^[A-Za-z0-9._-]{1,60}$/.test(artifactName)) {
    throw new Error('invalid flaky policy or artifact name');
  }
  const invocationId = makeInvocationId({ buildId, jobId, jobAttempt });
  const paths = createJobPaths(tempDirectory, invocationId);
  const args = coordinatorArgs({ specDir, environment, concurrency, workerTimeoutMs,
    handoff: paths.handoff, invocationId });
  let coordinatorExit;
  try { coordinatorExit = await execute({ cwd, args, signal, invocationId, handoff: paths.handoff }); }
  catch { coordinatorExit = 2; }
  let gateResult;
  try { gateResult = bridge({ cwd, handoff: paths.handoff, invocationId, flakyPolicy }); }
  catch { gateResult = { decision: 'REVIEW', exitCode: 2, reasons: [{ code: 'bridge-invocation-invalid', category: 'integrity' }] }; }
  let staged = { ready: false, copied: [], runId: '' }, stagingError = false;
  if (publishArtifacts) {
    try { staged = stageArtifacts({ cwd, handoff: paths.handoff, invocationId,
      stageDir: paths.stageDir, decision: gateResult.decision }); }
    catch { stagingError = true; }
  }
  const releaseEligible = gateResult.decision === 'PASS' && gateResult.exitCode === 0 && coordinatorExit === 0 &&
    !stagingError && (!publishArtifacts || staged.ready);
  return { invocationId, handoff: paths.handoff, artifactPath: paths.stageDir,
    artifactName: `${artifactName}-${buildId}-${jobId}-${jobAttempt}`,
    artifactReady: staged.ready, stagedFiles: staged.copied, runId: staged.runId || gateResult.runId || '',
    coordinatorExit, gateResult, releaseEligible,
    exitCode: stagingError || (gateResult.exitCode === 0 && coordinatorExit !== 0) ? 2 : gateResult.exitCode };
}

function azureOutput(name, value) {
  const safe = String(value).replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `##vso[task.setvariable variable=${name};isOutput=true]${safe}`;
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runQualityGate({ cwd: process.env.AGENTEX_CONSUMER_ROOT || process.cwd(),
    tempDirectory: process.env.AGENT_TEMPDIRECTORY,
    buildId: process.env.BUILD_BUILDID, jobId: process.env.SYSTEM_JOBID,
    jobAttempt: process.env.SYSTEM_JOBATTEMPT, specDir: process.env.AGENTEX_SPEC_DIR,
    environment: process.env.AGENTEX_ENVIRONMENT || undefined,
    concurrency: process.env.AGENTEX_CONCURRENCY || 2,
    workerTimeoutMs: process.env.AGENTEX_WORKER_TIMEOUT_MS || 900000,
    flakyPolicy: process.env.AGENTEX_FLAKY_POLICY || 'review',
    artifactName: process.env.AGENTEX_ARTIFACT_NAME || 'agentex-quality',
    publishArtifacts: String(process.env.AGENTEX_PUBLISH_ARTIFACTS || 'true').toLowerCase() !== 'false',
    signal: controller.signal })
    .then(result => {
      console.log(`AgenTeX invocation ${result.invocationId}; handoff ${result.handoff}; run ${result.runId || 'unavailable'}; ` +
        `coordinator ${result.coordinatorExit}; gate ${result.gateResult.decision}/${result.gateResult.exitCode}; ` +
        `artifact ${result.artifactReady ? 'staged' : 'unavailable'}`);
      for (const [name, value] of Object.entries({ AgentexGateDecision: result.gateResult.decision,
        AgentexGateExitCode: result.gateResult.exitCode, AgentexReleaseEligible: result.releaseEligible,
        AgentexRunId: result.runId, AgentexArtifactReady: result.artifactReady,
        AgentexArtifactPath: result.artifactReady ? result.artifactPath : '',
        AgentexArtifactName: result.artifactReady ? result.artifactName : '' })) console.log(azureOutput(name, value));
      process.exitCode = result.exitCode;
    })
    .catch(() => { console.log('AgenTeX Azure quality gate setup failed; release blocked'); process.exitCode = 2; });
}

module.exports = { makeInvocationId, createJobPaths, coordinatorArgs, runCoordinator, verifiedRun,
  safeCopy, imageReferences, stageArtifacts, runQualityGate, azureOutput };
