'use strict';
// Phase 8C focused deterministic tests — Define Flow conversational boundary
// contract under Copilot. Self-contained: no network, no browser daemon, no
// repo mutation (scratch dirs under os.tmpdir() only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildPackage } = require('./build_package.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const adapter = path.join(repoRoot, 'copilot', 'skills', 'agentex-define-flow', 'SKILL.md');
const shared = path.join(repoRoot, 'skills', 'define-flow', 'SKILL.md');
const owner = require(path.join(repoRoot, 'skills', 'agentex-define-flow', 'scripts', 'session_owner.js'));
const { saveSpec, validateBody } = require(path.join(repoRoot, 'skills', 'define-flow', 'scripts', 'save_spec.js'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-phase8c-df-'));
test.after(() => {
  const real = fs.realpathSync(scratch);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(real).startsWith('agentex-phase8c-df-')) throw new Error('unsafe cleanup target');
  fs.rmSync(real, { recursive: true, force: true });
});

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const packageRoot = path.join(scratch, 'package');
buildPackage(packageRoot);

// 1. Adapter packaged.
test('D1 define-flow adapter is packaged byte-identical with valid frontmatter', () => {
  const body = fs.readFileSync(adapter, 'utf8');
  assert.match(body, /^---\nname: agentex-define-flow\n/);
  assert.equal(sha(fs.readFileSync(adapter)),
    sha(fs.readFileSync(path.join(packageRoot, 'skills', 'agentex-define-flow', 'SKILL.md'))));
});

// 2. Session owner survives the conversational boundary (tool turn ends).
function liveFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const run = (_exe, args) => {
    calls.push(args);
    const verb = args[2];
    return { status: 0, stderr: '', stdout: verb === 'open' ? 'Browser opened with pid 1111' :
      verb === 'snapshot' ? '- Page URL: http://127.0.0.1:12744/confirmation-button.html\n- button "Apply change" [ref=e3]\n'
        : `ran ${verb}` };
  };
  const deps = { cli: path.join(root, 'pw-cli.js'), run, spawn: () => ({ pid: 2222, unref() {} }), isAlive: () => true };
  const started = owner.start(root, overrides.session || 'define-190100-abcd',
    'http://127.0.0.1:12744/confirmation-button.html', 60000, deps);
  return { root, calls, deps, started };
}

test('D2 owner lease survives tool-turn boundary (new process context reads same owner)', t => {
  const f = liveFixture(t);
  // Simulate a NEW invocation (what happens after the user replies): a fresh
  // liveOwner read through command() with no in-memory state.
  const st = owner.command(f.started.file, f.started.id, 'status', {}, f.deps);
  assert.equal(st.url, 'http://127.0.0.1:12744/confirmation-button.html');
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'open');
});

test('D3 same-session action after boundary: click goes to the SAME named session', t => {
  const f = liveFixture(t);
  const before = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  owner.command(f.started.file, f.started.id, 'click', { ref: 'e3', hash: before.hash }, f.deps);
  const clickCall = f.calls.filter(c => c[2] === 'click').at(-1);
  assert.equal(clickCall[1], `-s=${f.started.session}`);
  assert.equal(clickCall[2], 'click');
});

test('D4 page-state verification: stable hash; drift blocks action', t => {
  const f = liveFixture(t);
  const a = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  const b = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[a-f0-9]{64}$/);
  // Drift: page changed under us → click refused without browser action.
  const drift = liveFixture(t);
  const observed = owner.command(drift.started.file, drift.started.id, 'snapshot', {}, drift.deps).snapshot;
  const callsBeforeClick = drift.calls.length;
  // Mutate the snapshot between observe and act.
  drift.deps.run = (_e, args) => ({ status: 0, stderr: '', stdout:
    args[2] === 'snapshot' ? '- Page URL: http://127.0.0.1:12744/confirmation-button.html\n- text: changed\n' : `ran ${args[2]}` });
  assert.throws(() => owner.command(drift.started.file, drift.started.id, 'click',
    { ref: 'e3', hash: crypto.createHash('sha256').update(observed).digest('hex') }, drift.deps), /changed/);
  assert.equal(drift.calls.slice(callsBeforeClick).some(c => c[2] === 'click'), false);
});

test('D5 no silent browser reopen: failed observation never triggers open', t => {
  const f = liveFixture(t);
  const failing = { ...f.deps, run: (_e, args) => ({ status: 1, stderr: 'not open', stdout: '' }) };
  assert.throws(() => owner.command(f.started.file, f.started.id, 'snapshot', {}, failing), /Playwright command failed/);
  assert.equal(f.calls.filter(c => c[2] === 'open').length, 1, 'only the original start() may open');
});

test('D6 decline = zero action (close without any click)', t => {
  const f = liveFixture(t);
  owner.closeOwned(f.started.file, owner.readOwner(f.started.file, f.started.id), 'closed', f.deps);
  assert.equal(f.calls.some(c => c[2] === 'click'), false);
  assert.equal(f.calls.at(-1)[2], 'close');
});

test('D7 timeout cleanup: expired lease closes only its own session', t => {
  const f = liveFixture(t);
  assert.equal(owner.watchTick(f.started.file, f.started.id, Date.now() + 70000, f.deps), 'expired');
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'expired');
  assert.equal(f.calls.at(-1)[2], 'close');
  assert.equal(f.calls.some(c => c.includes('close-all') || c.includes('kill-all')), false);
});

test('D8 crash cleanup classification: controller loss marks crashed and cleans', t => {
  const f = liveFixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'status', {}, { ...f.deps, isAlive: () => false }), /crashed/);
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'crashed');
  assert.equal(f.calls.at(-1)[2], 'close');
});

test('D9 concurrent flows are isolated (separate owners, sessions, actions)', t => {
  const a = liveFixture(t, { session: 'define-190200-abcd' });
  const b = liveFixture(t, { session: 'define-190300-abcd' });
  const hash = owner.command(a.started.file, a.started.id, 'snapshot', {}, a.deps).hash;
  owner.command(a.started.file, a.started.id, 'click', { ref: 'e3', hash }, a.deps);
  assert.equal(b.calls.some(c => c[2] === 'click'), false);
  assert.notEqual(a.started.file, b.started.file);
  assert.notEqual(a.started.session, b.started.session);
});

test('D10 save guard unchanged: exclusive create, no overwrite, test/-scoped', () => {
  const cwd = fs.mkdtempSync(path.join(scratch, 'save-'));
  fs.mkdirSync(path.join(cwd, 'test', 'suite1'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.playwright-cli'));
  const body = '# Spec: Guarded flow\n\nTarget: http://127.0.0.1:12744/\n\n## Acceptance criteria\n- Expected result is stated.\n\n## Scenarios\n1. Open; expect the page.\n';
  fs.writeFileSync(path.join(cwd, '.playwright-cli', 'define-flow-draft.md'), body);
  assert.equal(saveSpec({ cwd, draft: '.playwright-cli/define-flow-draft.md', output: 'test/suite1/guarded.md' }), 'test/suite1/guarded.md');
  assert.throws(() => saveSpec({ cwd, draft: '.playwright-cli/define-flow-draft.md', output: 'test/suite1/guarded.md' }), /EEXIST/);
  assert.throws(() => saveSpec({ cwd, draft: '.playwright-cli/define-flow-draft.md', output: 'test/../../escape.md' }), /under test/);
});

test('D11 spec discovery: saved spec is found by the shared resolver', () => {
  const { resolveSpecs } = require(path.join(repoRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  const cwd = fs.mkdtempSync(path.join(scratch, 'disc-'));
  fs.mkdirSync(path.join(cwd, 'test', 'suite1'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'test', 'suite1', 'confirm-gate.md'),
    '# Spec: Confirm gate\n\nTarget: http://127.0.0.1:12744/\n\n## Scenarios\n1. Open\n');
  assert.deepEqual(resolveSpecs(cwd, { specDir: 'test/suite1' }), ['test/suite1/confirm-gate.md']);
  assert.deepEqual(resolveSpecs(cwd, { specs: ['test/suite1/confirm-gate.md'] }), ['test/suite1/confirm-gate.md']);
});

test('D12 generated spec body validates and executes as a normal AgenTeX spec', () => {
  const generated = fs.readFileSync(path.join(repoRoot, 'test', 'suite1', 'confirm-gate.md'), 'utf8');
  assert.match(generated, /^# Spec: /);
  assert.match(generated, /^Target: http:/m);
  assert.match(generated, /## Acceptance criteria/);
  assert.match(generated, /## Scenarios/);
  assert.deepEqual(validateBody(generated), [], 'live-generated spec must pass shared validation');
});

test('D13 runtime-neutral paths: adapter references resolve through resolve_runtime coreRoot', () => {
  const { resolveRuntime } = require(path.join(repoRoot, 'copilot', 'scripts', 'resolve_runtime.js'));
  const body = fs.readFileSync(adapter, 'utf8');
  assert.match(body, /resolve_runtime\.js/);
  assert.match(body, /skills\/define-flow\/SKILL\.md/);
  assert.match(body, /save_spec\.js/);
  // Source mode coreRoot = repo root; package mode coreRoot = <pkg>/core.
  const source = resolveRuntime();
  assert.equal(source.mode, 'source');
  assert.equal(fs.existsSync(path.join(source.coreRoot, 'skills', 'define-flow', 'SKILL.md')), true);
  const packaged = resolveRuntime({ packageRoot });
  assert.equal(packaged.mode, 'package');
  assert.equal(fs.existsSync(path.join(packaged.coreRoot, 'skills', 'define-flow', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(packaged.coreRoot, 'skills', 'define-flow', 'scripts', 'save_spec.js')), true);
});
