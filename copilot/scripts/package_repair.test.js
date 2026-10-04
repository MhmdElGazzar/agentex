'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildPackage } = require('./build_package.js');
const { validatePackage } = require('./validate_package.js');

const source = path.resolve(__dirname, '..', '..');
const releaseVersion = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8')).version;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-package-repair-'));
const pkg = path.join(scratch, 'package');
const consumer = path.join(scratch, 'consumer');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
buildPackage(pkg);
fs.mkdirSync(consumer);
fs.mkdirSync(path.join(consumer, 'test', 'suite1'), { recursive: true });
fs.mkdirSync(path.join(consumer, 'executions'));
fs.mkdirSync(path.join(consumer, '.agentex'));
fs.writeFileSync(path.join(consumer, '.agentex', 'version.json'), JSON.stringify({ version: releaseVersion }));
test.after(() => {
  const real = fs.realpathSync(scratch);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(real).startsWith('agentex-package-repair-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(real, { recursive: true, force: true });
});

test('all explicit packaged Copilot skill script and resource references exist', () => {
  for (const skill of fs.readdirSync(path.join(pkg, 'skills'))) {
    const body = fs.readFileSync(path.join(pkg, 'skills', skill, 'SKILL.md'), 'utf8');
    const refs = [...body.matchAll(/<(coreRoot|root)>\/([A-Za-z0-9._/-]+\.(?:js|md))/g)];
    for (const [, base, relative] of refs) {
      const root = base === 'coreRoot' ? path.join(pkg, 'core') : pkg;
      assert.equal(fs.existsSync(path.join(root, ...relative.split('/'))), true, `${skill}: ${base}/${relative}`);
    }
  }
});

test('packaged coordinator is byte-identical to the one canonical shared source', () => {
  const relative = 'skills/agentex-test/scripts/parallel.js';
  assert.equal(sha(path.join(pkg, 'core', relative)), sha(path.join(source, relative)));
  assert.equal(fs.existsSync(path.join(pkg, 'core', 'skills', 'agentex-test', 'SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(pkg, 'core', 'skills', 'agentex-executor')), false);
  assert.equal(fs.existsSync(path.join(pkg, 'core', 'scripts', 'codex_update.js')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(pkg, 'skills', 'agentex-update', 'SKILL.md'), 'utf8'),
    /<coreRoot>\/commands\//);
});

test('package build is deterministic and post-build contamination fails closed', () => {
  const second = path.join(scratch, 'second-package');
  const one = validatePackage(pkg);
  const two = buildPackage(second);
  assert.equal(one.fingerprint, two.fingerprint);
  const extra = path.join(second, 'unexpected.txt');
  fs.writeFileSync(extra, 'contamination');
  assert.throws(() => validatePackage(second), /inventory differs/);
});

test('packaged update check resolves only the package core and consumer', () => {
  const script = path.join(pkg, 'scripts', 'copilot_update.js');
  const r = spawnSync(process.execPath, [script, 'check', '--project', consumer],
    { cwd: consumer, encoding: 'utf8', env: { ...process.env, AGENTEX_PLUGIN_ROOT: '' } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.coreRoot, fs.realpathSync(path.join(pkg, 'core')));
  assert.equal(out.packageVersion, releaseVersion);
  assert.equal(out.projectState, 'current');
  assert.equal(out.packageAction, 'none');
});

test('packaged sequential scripts load without a source-checkout module', () => {
  const core = path.join(pkg, 'core');
  for (const relative of ['skills/test-execution/scripts/preflight.js',
    'skills/test-execution/scripts/init_run.js',
    'skills/test-execution/scripts/validate_executor_result.js',
    'skills/test-execution/scripts/project_executor_result.js',
    'skills/extent-report/scripts/make_html_report.js']) {
    assert.equal(fs.existsSync(path.join(core, relative)), true, relative);
  }
  const r = spawnSync(process.execPath, [path.join(core, 'skills', 'test-execution', 'scripts', 'init_run.js'),
    '--sessions', 'package-smoke'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.ok(out.runDir.startsWith('executions'));
  assert.equal(Object.keys(out.sessions).length, 1);
});

test('package-only parallel coordinator injects a Copilot worker and aggregates 2 PASS 1 FAIL', async () => {
  const cacheBefore = new Set(Object.keys(require.cache));
  const coordinator = require(path.join(pkg, 'core', 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const newlyLoaded = Object.keys(require.cache).filter(file => !cacheBefore.has(file));
  assert.ok(newlyLoaded.length > 0);
  assert.ok(newlyLoaded.every(file => file.startsWith(pkg)),
    `package import fell back to source: ${newlyLoaded.filter(file => !file.startsWith(pkg)).join(', ')}`);
  const specs = ['pass-a.md', 'pass-b.md', 'fail-c.md'].map(name => {
    const relative = `test/suite1/${name}`;
    fs.writeFileSync(path.join(consumer, relative), '# Spec: Local fixture\n\n## Scenarios\n1. Check local UI\n');
    return relative;
  });
  const fakeCli = path.join(consumer, 'fixture-cli.js');
  fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
  let active = 0, maxActive = 0;
  const worker = async assignment => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    const failed = assignment.spec.includes('fail-');
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
      schemaVersion: 1, runDir: assignment.runDir, session: assignment.session, spec: assignment.spec,
      status: failed ? 'failed' : 'passed', startedAt: now, endedAt: now, durationMs: 1,
      scenarios: [{ name: 'Local fixture', session: assignment.session, status: failed ? 'failed' : 'passed',
        steps: [{ desc: 'Check', status: failed ? 'failed' : 'passed' }] }],
      defects: [], failures: failed ? [{ kind: 'product', detail: 'controlled mismatch' }] : [],
      cleanup: { attempted: true, closed: true, error: null },
    }));
    active--;
    return { outcome: 'completed' };
  };
  const out = await coordinator.runParallel({ cwd: consumer, specs, targetUrl: 'http://127.0.0.1:12743/smoke.html',
    loginMode: 'none', concurrency: 2, worker,
    preflight: { node: { ok: true, version: process.version },
      'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
        command: { executable: process.execPath, args: [fakeCli] } } } });
  assert.equal(out.summary.passed, 2);
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.blocked, 0);
  assert.equal(out.status, 'failed');
  assert.equal(out.timing.maxActive, 2);
  assert.equal(maxActive, 2);
  assert.equal(new Set(out.timing.workerStates.map(state => state.session)).size, 3);
  assert.equal(out.codexInvocations, 0);
  assert.ok(newlyLoaded.some(file => file.endsWith(path.join('skills', 'agentex-test', 'scripts', 'parallel.js'))));
});

test('package-only parallel CLI refuses its Codex default before allocation', async () => {
  const coordinator = require(path.join(pkg, 'core', 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  await assert.rejects(() => coordinator.runParallel({ cwd: consumer, specs: ['test/suite1/pass-a.md'],
    targetUrl: 'http://127.0.0.1:12743/smoke.html' }), /host-owned worker callback/);
});

test('packaged entrypoints contain no developer path or certification dependency', () => {
  for (const relative of ['skills/agentex-test/SKILL.md', 'skills/agentex-update/SKILL.md',
    'core/skills/agentex-test/scripts/parallel.js', 'scripts/copilot_update.js']) {
    const body = fs.readFileSync(path.join(pkg, relative), 'utf8');
    assert.doesNotMatch(body, /C:[\\/]Users[\\/]|executions[\\/]phase8/i, relative);
  }
});
