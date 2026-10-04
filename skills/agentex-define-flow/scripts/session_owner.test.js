'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const owner = require('./session_owner.js');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-define-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let snapshot = '- Page URL: http://127.0.0.1:12743/smoke.html\n- button "Reveal confirmation" [ref=e3]\n- text: 0\n';
  let failVerb = null;
  const run = (_exe, args, options) => {
    calls.push({ args, options });
    const verb = args[2];
    if (failVerb === verb) return { status: 1, stderr: 'unavailable', stdout: '' };
    return { status: 0, stderr: '', stdout: verb === 'open' ? 'Browser opened with pid 1234' :
      verb === 'snapshot' ? snapshot : `ran ${verb}` };
  };
  const spawnCalls = [];
  const spawn = (exe, args, options) => {
    spawnCalls.push({ exe, args, options });
    return { pid: 4321, unref() { spawnCalls.at(-1).unref = true; } };
  };
  const deps = { cli: path.join(root, 'Playwright CLI', 'playwright-cli.js'), run, spawn, isAlive: () => true };
  const session = overrides.session || 'define-190000-abcd';
  const target = 'http://127.0.0.1:12743/smoke.html';
  const started = owner.start(root, session, target, overrides.idleMs || 60000, deps);
  return { root, calls, spawnCalls, deps, started, setSnapshot(value) { snapshot = value; }, setFail(value) { failVerb = value; } };
}

test('session names are unique-style and never default', () => {
  assert.equal(owner.validSession('define-190000-abcd'), true);
  assert.equal(owner.validSession('default'), false);
  assert.equal(owner.validSession('../other'), false);
});
test('target rejects credentials, non-web protocols, and fragments', () => {
  assert.throws(() => owner.validTarget('http://user:pass@localhost/a'), /unsafe/);
  assert.throws(() => owner.validTarget('file:///etc/passwd'), /unsafe/);
  assert.throws(() => owner.validTarget('http://localhost/a#x'), /unsafe/);
});
test('owner file stays under the chosen consumer project', (t) => {
  const f = fixture(t);
  assert.ok(f.started.file.startsWith(fs.realpathSync(f.root)));
  assert.equal(path.basename(f.started.file), `${f.started.session}.json`);
});
test('start opens exactly its assigned URL and records browser identity', (t) => {
  const f = fixture(t);
  assert.equal(f.started.browserPid, 1234);
  assert.deepEqual(f.calls[0].args.slice(1), [`-s=${f.started.session}`, 'open', f.started.target]);
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'open');
});
test('start launches a detached hidden watcher independent of tool stdout', (t) => {
  const f = fixture(t);
  assert.equal(f.started.watcherPid, 4321);
  assert.equal(f.spawnCalls[0].options.detached, true);
  assert.equal(f.spawnCalls[0].options.windowsHide, true);
  assert.equal(f.spawnCalls[0].options.stdio, 'ignore');
  assert.equal(f.spawnCalls[0].unref, true);
});
test('watcher lease remains open while a parent/tool invocation ends', (t) => {
  const f = fixture(t);
  assert.equal(owner.watchTick(f.started.file, f.started.id, Date.now() + 1000, f.deps), 'waiting');
  assert.equal(owner.command(f.started.file, f.started.id, 'status', {}, f.deps).url, f.started.target);
});
test('snapshot returns a stable state hash for the original session', (t) => {
  const f = fixture(t);
  const a = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  const b = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[a-f0-9]{64}$/);
});
test('approved click uses the same session and retained page state', (t) => {
  const f = fixture(t);
  const before = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  owner.command(f.started.file, f.started.id, 'click', { ref: 'e3', hash: before.hash }, f.deps);
  assert.deepEqual(f.calls.at(-1).args.slice(1), [`-s=${f.started.session}`, 'click', 'e3']);
});
test('changed page state requires re-observation and does not click', (t) => {
  const f = fixture(t);
  const before = owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps);
  f.setSnapshot('- Page URL: http://127.0.0.1:12743/smoke.html\n- text: changed\n');
  assert.throws(() => owner.command(f.started.file, f.started.id, 'click', { ref: 'e3', hash: before.hash }, f.deps), /changed/);
  assert.equal(f.calls.some(c => c.args[2] === 'click'), false);
});
test('click without a confirmed-state hash is refused', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'click', { ref: 'e3' }, f.deps), /hash/);
  assert.equal(f.calls.some(c => c.args[2] === 'click'), false);
});
test('invalid element reference is refused before browser action', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'click', { ref: ';whoami', hash: 'a'.repeat(64) }, f.deps), /reference/);
});
test('decline closes the assigned session without action', (t) => {
  const f = fixture(t);
  owner.closeOwned(f.started.file, owner.readOwner(f.started.file, f.started.id), 'closed', f.deps);
  assert.equal(f.calls.some(c => c.args[2] === 'click'), false);
  assert.deepEqual(f.calls.at(-1).args.slice(1), [`-s=${f.started.session}`, 'close']);
});
test('close is idempotent and never issues close-all', (t) => {
  const f = fixture(t);
  const current = owner.readOwner(f.started.file, f.started.id);
  owner.closeOwned(f.started.file, current, 'closed', f.deps);
  const count = f.calls.length;
  owner.closeOwned(f.started.file, owner.readOwner(f.started.file, f.started.id), 'closed', f.deps);
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.some(c => c.args.includes('close-all') || c.args.includes('kill-all')), false);
});
test('timeout closes only the assigned browser', (t) => {
  const f = fixture(t);
  assert.equal(owner.watchTick(f.started.file, f.started.id, Date.now() + 70000, f.deps), 'expired');
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'expired');
  assert.equal(f.calls.at(-1).args[2], 'close');
});
test('expired lease cannot act even if watcher has not ticked yet', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'snapshot', { now: Date.now() + 70000 }, f.deps), /expired/);
});
test('lost browser is reported without silently reopening', (t) => {
  const f = fixture(t);
  f.setFail('snapshot');
  assert.throws(() => owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps), /Playwright command failed/);
  assert.equal(f.calls.filter(c => c.args[2] === 'open').length, 1);
});
test('target-origin drift is reported before action', (t) => {
  const f = fixture(t);
  f.setSnapshot('- Page URL: https://example.com/\n- button "Reveal confirmation" [ref=e3]\n');
  assert.throws(() => owner.command(f.started.file, f.started.id, 'snapshot', {}, f.deps), /left assigned target origin/);
});
test('controller crash is classified and attempts owned cleanup', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'status', {}, { ...f.deps, isAlive: () => false }), /controller crashed/);
  assert.equal(owner.readOwner(f.started.file, f.started.id).state, 'crashed');
  assert.equal(f.calls.at(-1).args[2], 'close');
});
test('stale owner ID is rejected', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.readOwner(f.started.file, '0'.repeat(32)), /stale or foreign/);
});
test('foreign session owner cannot control this session', (t) => {
  const a = fixture(t, { session: 'define-190001-abcd' });
  const b = fixture(t, { session: 'define-190002-abcd' });
  assert.throws(() => owner.command(a.started.file, b.started.id, 'snapshot', {}, a.deps), /stale or foreign/);
});
test('two flows retain separate sessions, directories, and actions', (t) => {
  const a = fixture(t, { session: 'define-190003-abcd' });
  const b = fixture(t, { session: 'define-190004-abcd' });
  const hash = owner.command(a.started.file, a.started.id, 'snapshot', {}, a.deps).hash;
  owner.command(a.started.file, a.started.id, 'click', { ref: 'e3', hash }, a.deps);
  assert.equal(b.calls.some(c => c.args[2] === 'click'), false);
  assert.notEqual(a.started.file, b.started.file);
});
test('Windows install path with spaces is one argument, not shell-concatenated', (t) => {
  const f = fixture(t);
  assert.equal(f.calls[0].args[0], f.deps.cli);
  assert.match(f.calls[0].args[0], /Playwright CLI/);
});
test('unsupported arbitrary command is rejected', (t) => {
  const f = fixture(t);
  assert.throws(() => owner.command(f.started.file, f.started.id, 'shell', {}, f.deps), /unsupported/);
  assert.equal(f.calls.some(c => c.args.includes('shell')), false);
});
test('visibility query encodes user text as data', (t) => {
  const f = fixture(t);
  owner.command(f.started.file, f.started.id, 'visible-text', { text: "x'; process.exit(1); //" }, f.deps);
  assert.equal(f.calls.at(-1).args[2], 'eval');
  assert.ok(f.calls.at(-1).args[3].includes(JSON.stringify("x'; process.exit(1); //")));
});
test('screenshot remains in the assigned consumer scratch', (t) => {
  const f = fixture(t);
  const result = owner.command(f.started.file, f.started.id, 'screenshot', {}, f.deps);
  assert.ok(result.filename.startsWith(fs.realpathSync(f.root)));
  assert.equal(f.calls.at(-1).args[2], 'screenshot');
});
test('invalid idle timeout is refused before launching browser', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-owner-range-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => owner.start(root, 'define-190005-abcd', 'http://localhost/', 1000, { cli: 'x' }), /idle timeout/);
});
