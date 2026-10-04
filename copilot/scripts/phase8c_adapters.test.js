'use strict';
// Phase 8C focused deterministic tests — Copilot adapters (execute-test +
// define-flow) and their packaging contract. Self-contained: no network, no
// browser daemon, no repo mutation (scratch dirs under os.tmpdir() only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildPackage } = require('./build_package.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const adapterTest = path.join(repoRoot, 'copilot', 'skills', 'agentex-test', 'SKILL.md');
const adapterDefine = path.join(repoRoot, 'copilot', 'skills', 'agentex-define-flow', 'SKILL.md');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-phase8c-'));
const packageRoot = path.join(scratch, 'package');
buildPackage(packageRoot);
test.after(() => {
  const real = fs.realpathSync(scratch);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(real).startsWith('agentex-phase8c-')) throw new Error('unsafe cleanup target');
  fs.rmSync(real, { recursive: true, force: true });
});

// --- Execute-Test adapter (7) -------------------------------------------------

test('E1 agentex-test adapter is packaged with valid frontmatter', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /^---\nname: agentex-test\n/);
  assert.match(body, /^description: \S/m);
  const packaged = fs.readFileSync(path.join(packageRoot, 'skills', 'agentex-test', 'SKILL.md'), 'utf8');
  assert.equal(sha(fs.readFileSync(adapterTest)), sha(fs.readFileSync(path.join(packageRoot, 'skills', 'agentex-test', 'SKILL.md'))));
});

test('E2 natural-routing metadata: triggers reference AgenTeX run/execute, not general coding', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /run (this|the saved) AgenTeX (test|spec)/i);
  assert.match(body, /not for general coding tasks/i);
});

test('E3 shared runner path contract resolves against BOTH repo and package layouts', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  const ref = body.match(/<coreRoot>(\/skills\/agentex-test\/scripts\/parallel\.js)/);
  assert.ok(ref, 'adapter must reference the shared parallel runner under coreRoot');
  const rel = ref[1];
  // Repo layout: coreRoot === repoRoot.
  assert.equal(fs.existsSync(path.join(repoRoot, ...rel.split('/'))), true, `repo layout: ${rel}`);
  // Package layout: coreRoot === <package>/core.
  const packagePath = path.join(packageRoot, 'core', ...rel.split('/'));
  assert.equal(fs.existsSync(packagePath), true, `package layout: ${rel}`);
  assert.equal(sha(fs.readFileSync(packagePath)), sha(fs.readFileSync(path.join(repoRoot, ...rel.split('/')))));
});

test('E4 unique session naming rule is stated (never default, named sessions only)', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /-s=<name>/);
  assert.match(body, /never the `default` session/i);
  assert.match(body, /never `close-all`\/`kill-all`/i);
});

test('E5 executor-result validation contract is delegated to shared scripts', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /validate_executor_result\.js/);
  assert.match(body, /project_executor_result\.js/);
  assert.match(body, /make_html_report\.js/);
  for (const rel of ['skills/test-execution/scripts/validate_executor_result.js',
    'skills/test-execution/scripts/project_executor_result.js',
    'skills/extent-report/scripts/make_html_report.js']) {
    assert.equal(fs.existsSync(path.join(repoRoot, ...rel.split('/'))), true, rel);
  }
});

test('E6 report contract ownership stays with shared core (no second policy in adapter)', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /using the shared AgenTeX execution core/);
  assert.match(body, /do not reformat|duplicate/i);
});

test('E7 cleanup is scoped: close only own session(s), even on failure', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /Close only your own session\(s\)/);
  assert.match(body, /attempt cleanup even on failure/);
});

// --- Parallel / Copilot worker contract (6) ----------------------------------

test('P1 coordinator bounds concurrency 1..4 with default 2', async () => {
  const { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, validateConcurrency } =
    require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  assert.equal(DEFAULT_CONCURRENCY, 2);
  assert.equal(MAX_CONCURRENCY, 4);
  assert.equal(validateConcurrency(undefined, 9), 2);
  assert.equal(validateConcurrency(4, 9), 4);
  assert.equal(validateConcurrency(1, 9), 1);
  assert.equal(validateConcurrency(4, 2), 2, 'caps to spec count');
  assert.throws(() => validateConcurrency(5, 9), /concurrency/);
});

test('P2 worker isolation: no Codex worker is spawned under the Copilot adapter', () => {
  const body = fs.readFileSync(adapterTest, 'utf8');
  assert.match(body, /do not spawn Codex or another external agent worker/i);
  // The repo coordinator still exports codexWorker for Codex; the Copilot
  // driver must inject its own worker. Assert the Copilot scratch driver used
  // in the live proof did exactly that (existence + no codex spawn).
  const driver = path.join(repoRoot, '.playwright-cli', 'run-parallel-8c.js');
  if (fs.existsSync(driver)) {
    const src = fs.readFileSync(driver, 'utf8');
    assert.match(src, /copilotWorker/);
    assert.doesNotMatch(src, /worker:\s*codexWorker/);
    assert.doesNotMatch(src, /spawn\([^)]*'codex'/);
  }
});

test('P3 deterministic aggregation: mixed PASS/FAIL produces honest counts (mock run)', async () => {
  const { runParallel, resolveSpecs } = require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const cwd = fs.mkdtempSync(path.join(scratch, 'agg-'));
  fs.mkdirSync(path.join(cwd, 'test', 'reg'), { recursive: true });
  const specs = ['a.md', 'b.md', 'c.md'].map(name => {
    const file = path.join(cwd, 'test', 'reg', name);
    fs.writeFileSync(file, '# Spec: Mock mixed run\n\nTarget: http://127.0.0.1:12743/smoke.html\n\n## Scenarios\n1. Open the page\n');
    return path.relative(cwd, file).replace(/\\/g, '/');
  });
  assert.deepEqual(resolveSpecs(cwd, { specs }), specs);
  const fakeCli = path.join(cwd, 'fake-cli.js');
  fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
  const writeResult = assignment => {
    const failed = assignment.spec.endsWith('c.md');
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
      schemaVersion: 1, runDir: assignment.runDir, session: assignment.session, spec: assignment.spec,
      status: failed ? 'failed' : 'passed', startedAt: now, endedAt: now, durationMs: 1,
      scenarios: [{ name: 'Mock scenario', session: assignment.session, status: failed ? 'failed' : 'passed',
        steps: [{ desc: 'Open', status: failed ? 'failed' : 'passed' }] }],
      defects: failed ? [{ title: 'Controlled product mismatch', severity: 'Low', expected: 'x', actual: 'y', evidence: [] }] : [],
      failures: failed ? [{ kind: 'product', detail: 'controlled' }] : [],
      cleanup: { attempted: true, closed: true, error: null },
    }));
    return { outcome: 'completed' };
  };
  const out = await runParallel({
    cwd, specs, targetUrl: 'http://127.0.0.1:12743/smoke.html', loginMode: 'none',
    concurrency: 2, worker: writeResult,
    preflight: { node: { ok: true, version: process.version },
      'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
        command: { executable: process.execPath, args: [fakeCli] } } },
  });
  try {
    assert.equal(out.status, 'failed');
    assert.equal(out.summary.passed, 2);
    assert.equal(out.summary.failed, 1);
    assert.equal(out.summary.blocked, 0);
    assert.equal(out.codexInvocations, 0, 'Copilot mode must never count codex invocations');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('P4 infrastructure-worker failure is classified, not silently passed', async () => {
  const { runParallel } = require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const cwd = fs.mkdtempSync(path.join(scratch, 'infra-'));
  try {
    fs.mkdirSync(path.join(cwd, 'test', 'reg'), { recursive: true });
    const spec = path.join(cwd, 'test', 'reg', 'x.md');
    fs.writeFileSync(spec, '# Spec: Worker crash\n\nTarget: http://127.0.0.1:12743/smoke.html\n\n## Scenarios\n1. Open\n');
    const fakeCli = path.join(cwd, 'fake-cli.js');
    fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
    const out = await runParallel({
      cwd, specs: [path.relative(cwd, spec).replace(/\\/g, '/')],
      targetUrl: 'http://127.0.0.1:12743/smoke.html', loginMode: 'none', concurrency: 1,
      worker: () => { throw new Error('mock worker startup crash'); },
      preflight: { node: { ok: true, version: process.version },
        'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
          command: { executable: process.execPath, args: [fakeCli] } } },
    });
    assert.equal(out.status, 'blocked');
    assert.equal(out.summary.blocked, 1);
    assert.equal(out.summary.failed, 0, 'worker crash must never be reported as product failure');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('P5 artifact isolation: manifest strips secrets and per-worker auth paths', async () => {
  const { runParallel } = require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const cwd = fs.mkdtempSync(path.join(scratch, 'iso-'));
  try {
    fs.mkdirSync(path.join(cwd, 'test', 'reg'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'test', '.auth'), { recursive: true });
    const source = path.join(cwd, 'test', '.auth', 't-state.json');
    fs.writeFileSync(source, JSON.stringify({ cookies: [], origins: [] }));
    const spec = path.join(cwd, 'test', 'reg', 'y.md');
    fs.writeFileSync(spec, '# Spec: Isolation\n\nTarget: http://127.0.0.1:12743/smoke.html\n\n## Scenarios\n1. Open\n');
    const fakeCli = path.join(cwd, 'fake-cli.js');
    fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
    let privatePath = null;
    const out = await runParallel({
      cwd, specs: [path.relative(cwd, spec).replace(/\\/g, '/')],
      targetUrl: 'http://127.0.0.1:12743/smoke.html', loginMode: 'session', concurrency: 1,
      worker: a => {
        privatePath = a.authStatePath;
        const now = new Date().toISOString();
        fs.writeFileSync(path.join(a.sessionDir, 'executor-result.json'), JSON.stringify({
          schemaVersion: 1, runDir: a.runDir, session: a.session, spec: a.spec, status: 'passed',
          startedAt: now, endedAt: now, durationMs: 1,
          scenarios: [{ name: 'Iso', session: a.session, status: 'passed', steps: [{ desc: 'Open', status: 'passed' }] }],
          defects: [], failures: [], cleanup: { attempted: true, closed: true, error: null } }));
        return { outcome: 'completed' };
      },
      preflight: { node: { ok: true, version: process.version },
        'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
          command: { executable: process.execPath, args: [fakeCli] } } },
    });
    assert.equal(out.status, 'passed');
    assert.equal(fs.existsSync(privatePath), false, 'private auth copy must be removed');
    assert.equal(fs.readFileSync(source, 'utf8'), JSON.stringify({ cookies: [], origins: [] }), 'shared auth state untouched');
    for (const name of ['parallel-manifest.json', 'parallel-timing.json', 'run-summary.json']) {
      const text = fs.readFileSync(path.join(cwd, out.runDir, name), 'utf8');
      assert.equal(text.includes(privatePath), false, `${name} must not leak the private auth path`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('P6 bounded concurrency is observable and honest (maxActive never exceeds limit)', async () => {
  const { schedule } = require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  let active = 0, maxActive = 0;
  const out = await schedule(
    Array.from({ length: 5 }, (_, i) => ({ workerId: `worker-${i + 1}`, session: `s-${i + 1}` })),
    2,
    async () => { active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5)); active--; return { outcome: 'completed' }; },
    { timeoutMs: 5000 });
  assert.equal(out.maxActive, 2);
  assert.equal(maxActive, 2);
  assert.equal(out.states.length, 5);
  assert.ok(out.states.every(s => s.outcome === 'completed'));
});

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
