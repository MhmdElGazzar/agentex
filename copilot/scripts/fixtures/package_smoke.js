'use strict';

// Local acceptance harness only. The coordinator and report scripts are loaded
// exclusively from --package; this fixture supplies a localhost page and worker.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--package', '--consumer', '--worker', '--mode'].includes(argv[i]) || !argv[i + 1]) throw new Error('expected --package, --consumer, --worker, optional --mode');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.package || !out.consumer) throw new Error('missing acceptance argument');
  if (out.mode && !['sequential', 'parallel', 'both'].includes(out.mode)) throw new Error('invalid mode');
  return out;
}

function runJson(script, argv, cwd) {
  const r = spawnSync(process.execPath, [script, ...argv], { cwd, encoding: 'utf8', timeout: 90000, shell: false });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(script)}: ${r.error?.message || r.stdout || r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
}

function runWorker(workerFile, assignment, cli) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [workerFile, JSON.stringify(assignment)], {
      cwd: assignment.sessionDir, shell: false, windowsHide: true,
      env: { ...process.env, AGENTEX_PW_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', error => resolve({ outcome: 'launch-failed', detail: error.message }));
    child.on('close', code => resolve(code === 0 ? { outcome: 'completed' } : { outcome: 'crashed', detail: `exit ${code}: ${stderr}` }));
  });
}

async function main() {
  const input = args(process.argv.slice(2));
  const pkg = fs.realpathSync(input.package);
  const consumer = fs.realpathSync(input.consumer);
  const workerFile = input.worker ? fs.realpathSync(input.worker) : null;
  const core = path.join(pkg, 'core');
  const repoFixture = path.resolve(__dirname, '..', '..', '..', 'evals', 'codex-foundation');
  const page = fs.readFileSync(path.join(repoFixture, 'smoke.html'));
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' || !['/', '/smoke.html'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const targetUrl = `http://127.0.0.1:${server.address().port}/smoke.html`;
    const specDir = path.join(consumer, 'test', 'suite1');
    fs.mkdirSync(specDir, { recursive: true });
    fs.mkdirSync(path.join(consumer, 'executions'), { recursive: true });
    const names = [['pass-counter.md', 'amber-unknown.md'],
      ['pass-reveal.md', 'violet-unknown.md'], ['fail-reveal.md', 'cedar-unknown.md']];
    for (const [source, name] of names) {
      const destination = path.join(specDir, name);
      if (!fs.existsSync(destination)) fs.copyFileSync(path.join(repoFixture, 'parallel', source), destination, fs.constants.COPYFILE_EXCL);
    }
    const preflight = runJson(path.join(core, 'skills', 'test-execution', 'scripts', 'preflight.js'), [], consumer);
    if (preflight['playwright-cli']?.status !== 'READY') throw new Error(`preflight ${preflight['playwright-cli']?.status}`);
    const cli = preflight['playwright-cli'].command.args[0];
    let sequential = null;
    if (input.mode !== 'parallel') {
    const init = runJson(path.join(core, 'skills', 'test-execution', 'scripts', 'init_run.js'),
      ['--sessions', 'violet-unknown'], consumer);
    const [session, info] = Object.entries(init.sessions)[0];
    const assignment = { runDir: init.runDir.replace(/\\/g, '/'), session, loginMode: 'none',
      spec: 'test/suite1/violet-unknown.md', targetUrl, browserWorkingDir: path.join(consumer, info.dir),
      sessionDir: path.join(consumer, info.dir) };
    const sequentialWorker = workerFile
      ? await runWorker(workerFile, assignment, cli)
      : await require(path.join(pkg, 'scripts', 'host_worker.js')).executeAssignment({
        ...assignment, workingDir: consumer, executionDir: path.join(consumer, init.runDir),
        targetUrl, playwrightCommand: preflight['playwright-cli'].command,
        artifacts: { screenshots: path.join(consumer, info.dir, 'screenshots'),
          logs: path.join(consumer, info.dir, 'logs'),
          result: path.join(consumer, info.dir, 'executor-result.json') } });
    if (sequentialWorker.outcome !== 'completed') throw new Error(`sequential worker ${JSON.stringify(sequentialWorker)}`);
    const resultFile = path.join(assignment.sessionDir, 'executor-result.json');
    const validation = runJson(path.join(core, 'skills', 'test-execution', 'scripts', 'validate_executor_result.js'),
      [resultFile], consumer);
    if (!validation.ok) throw new Error(`sequential result invalid: ${JSON.stringify(validation)}`);
    const projected = runJson(path.join(core, 'skills', 'test-execution', 'scripts', 'project_executor_result.js'),
      ['--result', resultFile, '--target-url', targetUrl, '--login-mode', 'none'], consumer);
    if (!projected.ok) throw new Error(`sequential projection failed: ${JSON.stringify(projected)}`);
    const sequentialSummary = JSON.parse(fs.readFileSync(path.join(consumer, init.runDir, 'run-summary.json')));
    sequential = { runDir: init.runDir, status: sequentialSummary.testCases[0]?.status,
      passed: sequentialSummary.summary.passed, failed: sequentialSummary.summary.failed,
      blocked: sequentialSummary.summary.blocked,
      cleanup: JSON.parse(fs.readFileSync(resultFile)).cleanup };
    }
    let parallel = null;
    if (input.mode !== 'sequential') {
    const { runCopilotParallel } = require(path.join(pkg, 'scripts', 'host_worker.js'));
    const result = await runCopilotParallel({ cwd: consumer,
      specs: names.map(([, name]) => `test/suite1/${name}`),
      targetUrl, loginMode: 'none', concurrency: 2, preflight });
    parallel = { runDir: result.runDir, status: result.status, passed: result.summary.passed,
      failed: result.summary.failed, blocked: result.summary.blocked, maxActive: result.timing.maxActive,
      sessions: result.timing.workerStates.map(state => state.session),
      codexInvocations: result.codexInvocations, cleanupIssues: result.timing.browserList.ownedRemaining };
    }
    const packageLoaded = Object.keys(require.cache).filter(file => file.startsWith(pkg));
    const output = { packageRoot: pkg, coreRoot: core, targetUrl, sequential, parallel,
      packageLoadedCount: packageLoaded.length };
    console.log(JSON.stringify(output));
    if ((sequential && (sequential.passed !== 1 || sequential.failed || sequential.blocked || !sequential.cleanup.closed)) ||
        (parallel && (parallel.passed !== 2 || parallel.failed !== 1 || parallel.blocked ||
          parallel.maxActive !== 2 || parallel.codexInvocations || parallel.cleanupIssues?.length))) process.exitCode = 1;
  } finally { await new Promise(resolve => server.close(resolve)); }
}

main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; });
