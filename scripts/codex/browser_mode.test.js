'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflight, command, close, audit, verify, evidenceFile, actionsFile, closeFile } = require('./browser_mode');

const sessionId = 'codex-00000000-0000-4000-8000-000000000001';
function fixture(requestedMode, observed, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mode-'));
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
  const calls = [];
  let lists = 0;
  const state = { browsers: observed, alive: true, closed: false };
  const runner = (args) => {
    calls.push(args);
    if (args[0] === 'list') {
      const current = lists++ >= 2 && options.cleanupObserved !== undefined ? options.cleanupObserved : state.browsers;
      return { status: 0, stdout: JSON.stringify({ browsers: lists > 1 && !state.closed ? current : [] }) };
    }
    if (args.includes('open') && options.failLaunch) return { status: 1, stderr: 'private launch text' };
    if (args.includes('open')) return { status: 0, stdout: JSON.stringify({ session: sessionId, pid: 4242 }) };
    if (args.includes('goto') && options.failAction) return { status: 1, stderr: 'private application text' };
    if (args.includes('goto') && options.postMode) state.browsers = [browser(options.postMode === 'HEADED')];
    if (args.includes('close') && options.throwCleanup) throw Error('cleanup threw');
    if (args.includes('close') && options.closeFailure) return { status: 1, stderr: 'private close text' };
    if (args.includes('close') && !options.remainsOpen) state.closed = true;
    return { status: 0, stdout: '' };
  };
  const context = { projectRoot: root, runId: 'run-1', assignmentId: 'assignment-1', sessionDir, sessionId,
    requestedMode, runner, isAlive: () => state.alive };
  const record = preflight(context);
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile(sessionDir))), record);
  return { record, calls, context, state };
}
const browser = (headed, name = sessionId, pid = 4242) =>
  ({ name, status: 'open', attached: false, browserType: 'chrome', headed, ...(pid ? { pid } : {}) });

test('HEADLESS requested and actual remains the default launch', () => {
  const { record, calls } = fixture('HEADLESS', [browser(false)]);
  assert.equal(record.verified, true);
  assert.deepEqual(calls[1], [`-s=${sessionId}`, 'open', 'about:blank', '--json']);
  assert.equal(calls.length, 3);
});
test('HEADED requested and actual is verified before scenario work', () => {
  const { record, calls } = fixture('HEADED', [browser(true)]);
  assert.equal(record.verified, true);
  assert.equal(record.actualMode, 'HEADED');
  assert.deepEqual(calls[1], [`-s=${sessionId}`, 'open', 'about:blank', '--headed', '--json']);
});
for (const [label, observed, reason] of [
  ['headless actual', [browser(false)], 'browser-mode-mismatch'],
  ['missing metadata', [{ ...browser(true), headed: undefined }], 'browser-mode-metadata-missing'],
  ['incorrect session ID', [browser(true, 'other')], 'owned-session-metadata-missing'],
  ['foreign session metadata', [browser(true, 'foreign')], 'owned-session-metadata-missing'],
]) test('HEADED blocks on ' + label + ' without closing unconfirmed ownership', () => {
  const { record, calls } = fixture('HEADED', observed);
  assert.equal(record.verified, false);
  assert.match(record.reason, new RegExp(reason));
  const owned = observed.some(x => x.name === sessionId);
  assert.equal(calls.some(args => args.includes('close')), owned);
  assert.equal(record.cleanup.status, owned ? 'completed' : 'unresolved');
  assert.equal(calls.some(args => args.includes('close-all') || args.includes('kill-all')), false);
});
test('foreign metadata cannot satisfy exact owned identity', () => {
  assert.equal(verify([browser(true, 'foreign')], sessionId, 'HEADED').verified, false);
});
test('foreign session remains untouched when owned session verifies', () => {
  const { record, calls } = fixture('HEADED', [browser(true, 'foreign'), browser(true)]);
  assert.equal(record.verified, true);
  assert.equal(calls.some(args => args.includes('close')), false);
});
test('worker browser command cannot start before mandatory preflight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mode-'));
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
  const calls = [];
  assert.throws(() => command({ projectRoot: root, sessionDir, sessionId, requestedMode: 'HEADED',
    runner: args => { calls.push(args); return { status: 0 }; } }, ['goto', 'about:blank']), /preflight missing/);
  assert.equal(calls.length, 0);
});
test('worker browser command cannot start after failed preflight', () => {
  const { context, calls } = fixture('HEADED', [browser(false)]);
  const before = calls.length;
  assert.throws(() => command(context, ['goto', 'about:blank']), /preflight failed/);
  assert.equal(calls.length, before);
});
test('headed preflight cannot authorize a replacement headless browser', () => {
  const { context, state, calls } = fixture('HEADED', [browser(true)]);
  state.browsers = [browser(false)];
  const before = calls.length;
  assert.throws(() => command(context, ['goto', 'about:blank']), /browser-mode-mismatch/);
  assert.equal(calls.slice(before).some(args => args.includes('goto')), false);
});
test('previous launch PID and stale verification cannot authorize scenario action', () => {
  const { context, state, calls } = fixture('HEADED', [browser(true)]);
  state.alive = false; // Same session ID may have been reopened, but the verified daemon is gone.
  const before = calls.length;
  assert.throws(() => command(context, ['goto', 'about:blank']), /no longer running/);
  assert.equal(calls.length, before);
});
test('verified browser action uses the same launch and leaves auditable evidence', () => {
  const { context, record, calls } = fixture('HEADED', [browser(true)]);
  assert.equal(command(context, ['goto', 'about:blank']).launchedPid, record.launchedPid);
  assert.deepEqual(calls.at(-2), [`-s=${sessionId}`, 'goto', 'about:blank']);
  assert.match(audit(context.sessionDir, sessionId, 'HEADED', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), /cleanup/);
  close(context);
  assert.equal(audit(context.sessionDir, sessionId, 'HEADED', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), null);
  assert.ok(fs.existsSync(actionsFile(context.sessionDir)));
  assert.ok(fs.existsSync(closeFile(context.sessionDir)));
  assert.throws(() => command(context, ['open', 'about:blank']), /not allowed/);
});

test('original PID alive does not authorize a listed replacement PID', () => {
  const { context, state, calls } = fixture('HEADED', [{ ...browser(true), pid: 4242 }]);
  state.browsers = [{ ...browser(true), pid: 5252 }];
  const before = calls.length;
  assert.throws(() => command(context, ['goto', 'about:blank']), /pid-mismatch/);
  assert.equal(calls.slice(before).some(args => args.includes('goto')), false);
});
test('failed guarded action records failure without leaking CLI stderr', () => {
  const { context } = fixture('HEADLESS', [browser(false)], { failAction: true });
  assert.throws(() => command(context, ['goto', 'about:blank']), /browser command failed/);
  const events = fs.readFileSync(actionsFile(context.sessionDir), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map(e => e.status), ['attempted', 'failed']);
  assert.equal(events[1].exitStatus, 1);
  assert.equal(fs.readFileSync(actionsFile(context.sessionDir), 'utf8').includes('private application text'), false);
});
test('successful action followed by failed action cannot pass after verified close', () => {
  const options = {};
  const { context } = fixture('HEADLESS', [browser(false)], options);
  command(context, ['goto', 'about:blank']);
  options.failAction = true;
  assert.throws(() => command(context, ['goto', 'about:blank']), /browser command failed/);
  close(context);
  assert.match(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), /action failed/);
});
test('pre-action verification failure is persisted with its phase and safe reason', () => {
  const { context, state } = fixture('HEADED', [browser(true)]);
  state.alive = false;
  assert.throws(() => command(context, ['goto', 'about:blank']), /no longer running/);
  const events = fs.readFileSync(actionsFile(context.sessionDir), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map(e => e.status), ['attempted', 'failed']);
  assert.equal(events[1].phase, 'pre-action-verification');
  assert.equal(events[1].failureCode, 'launch-not-running');
});
test('post-action mode verification failure records a failed attempt', () => {
  const { context } = fixture('HEADED', [browser(true)], { postMode: 'HEADLESS' });
  assert.throws(() => command(context, ['goto', 'about:blank']), /browser-mode-mismatch/);
  const events = fs.readFileSync(actionsFile(context.sessionDir), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map(e => e.status), ['attempted', 'failed']);
});
test('preflight retains primary mode mismatch when cleanup throws', () => {
  const { record, context } = fixture('HEADED', [browser(false)], { throwCleanup: true });
  assert.match(record.reason, /browser-mode-mismatch/);
  assert.equal(record.cleanup.status, 'failed');
  assert.equal(record.cleanup.failureCode, 'operation-threw');
  assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFile(context.sessionDir))), record);
});
test('failed launch records diagnostics without closing an unverified session identity', () => {
  const { record, calls } = fixture('HEADLESS', [], { failLaunch: true });
  assert.match(record.reason, /browser launch failed/);
  assert.equal(record.launch.exitStatus, 1);
  assert.equal(record.cleanup.status, 'unresolved');
  assert.equal(calls.some(args => args.includes('close')), false);
  assert.equal(JSON.stringify(record).includes('private launch text'), false);
});
for (const [label, cleanupObserved] of [
  ['missing session', []],
  ['replacement PID', [browser(false, sessionId, 5252)]],
  ['missing PID proof', [browser(false, sessionId, null)]],
]) test('failed preflight preserves ' + label + ' without closing it', () => {
  const { record, calls } = fixture('HEADED', [browser(false)], { cleanupObserved });
  assert.match(record.reason, /browser-mode-mismatch/);
  assert.equal(record.cleanup.status, 'unresolved');
  assert.equal(record.cleanup.failureCode, 'cleanup-ownership-unconfirmed');
  assert.equal(calls.some(args => args.includes('close')), false);
});
test('primary preflight failure survives a secondary close verification failure', () => {
  const { record } = fixture('HEADED', [browser(false)], { remainsOpen: true });
  assert.match(record.reason, /browser-mode-mismatch/);
  assert.equal(record.cleanup.status, 'failed');
  assert.equal(record.cleanup.failureCode, 'preflight-close-unverified');
});
test('secret-bearing stderr is absent from persisted evidence and emitted errors', () => {
  const secret = 'token=PRIVATE-SECRET';
  const { context } = fixture('HEADLESS', [browser(false)]);
  context.runner = args => args[0] === 'list'
    ? { status: 0, stdout: JSON.stringify({ browsers: [browser(false)] }) }
    : { status: 1, stderr: secret };
  assert.throws(() => command(context, ['goto', 'about:blank']), e => !String(e).includes(secret));
  assert.throws(() => close(context), e => !String(e).includes(secret));
  const persisted = fs.readFileSync(actionsFile(context.sessionDir), 'utf8') +
    fs.readFileSync(closeFile(context.sessionDir), 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.match(persisted, /stderrSha256/);
});
for (const value of [undefined, 'invalid']) test('audit rejects preflight verifiedAt ' + value, () => {
  const { context } = fixture('HEADLESS', [browser(false)]);
  command(context, ['goto', 'about:blank']); close(context);
  const record = JSON.parse(fs.readFileSync(evidenceFile(context.sessionDir)));
  if (value === undefined) delete record.verifiedAt;
  else record.verifiedAt = value;
  fs.writeFileSync(evidenceFile(context.sessionDir), JSON.stringify(record));
  assert.match(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), /preflight/);
});
for (const change of [
  record => { record.assignmentId = 'foreign-assignment'; },
  record => { record.actualMode = 'HEADED'; },
]) test('audit rejects mismatched preflight ownership or actual mode', () => {
  const { context } = fixture('HEADLESS', [browser(false)]);
  command(context, ['goto', 'about:blank']); close(context);
  const record = JSON.parse(fs.readFileSync(evidenceFile(context.sessionDir)));
  change(record);
  fs.writeFileSync(evidenceFile(context.sessionDir), JSON.stringify(record));
  assert.notEqual(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), null);
});
test('audit rejects action outcome and close chronology corruption', () => {
  const { context } = fixture('HEADLESS', [browser(false)]);
  command(context, ['goto', 'about:blank']); close(context);
  const file = actionsFile(context.sessionDir);
  const original = fs.readFileSync(file, 'utf8');
  const events = original.trim().split(/\r?\n/).map(JSON.parse);
  events[1].completedAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
  assert.match(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), /stale/);
  fs.writeFileSync(file, original);
  const closes = fs.readFileSync(closeFile(context.sessionDir), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  closes[1].verifiedAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(closeFile(context.sessionDir), closes.map(JSON.stringify).join('\n') + '\n');
  assert.match(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
    { runId: context.runId, closeOwners: [context.assignmentId] }), /cleanup/);
});
for (const [name, options] of [['command fails', { closeFailure: true }],
  ['closure verification fails', { remainsOpen: true }]])
  test('owned browser close ' + name + ' and remains unverified', () => {
    const { context } = fixture('HEADLESS', [browser(false)], options);
    command(context, ['goto', 'about:blank']);
    assert.throws(() => close(context), /close failed|remains open/);
    const events = fs.readFileSync(closeFile(context.sessionDir), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(events.map(e => e.status), ['attempted', 'failed']);
    assert.match(audit(context.sessionDir, sessionId, 'HEADLESS', context.assignmentId,
      { runId: context.runId, closeOwners: [context.assignmentId] }), /cleanup/);
  });
