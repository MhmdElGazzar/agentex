'use strict';
// Coordinator-owned lifecycle ledger. Native delegation itself is performed by
// the Codex host's spawn_agent tool, never by a Node or CLI subprocess.
const fs = require('node:fs');
const path = require('node:path');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeNew = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const statuses = new Set(['completed', 'failed', 'cancelled', 'timed-out', 'launch-failed']);
function context(runRoot, assignmentId) {
  const root = path.resolve(runRoot);
  const custody = read(path.join(root, 'custody.json'));
  if (custody.runRoot !== root || custody.mode !== 'parallel') throw Error('parallel custody required');
  const record = custody.assignments.find(x => x.assignmentId === assignmentId);
  if (!record) throw Error('unknown assignment');
  return { root, custody, record, dir: path.join(root, 'worker-events') };
}
function launch(runRoot, assignmentId, workerId, at = new Date().toISOString()) {
  const { custody, record, dir } = context(runRoot, assignmentId);
  if (fs.existsSync(path.join(dir, assignmentId + '.end.json'))) throw Error('assignment already terminal');
  if (typeof workerId !== 'string' || !/^\/[\w/-]+$/.test(workerId)) throw Error('native worker identity required');
  if (!Number.isFinite(Date.parse(at))) throw Error('launch timestamp required');
  for (const other of custody.assignments) {
    const file = path.join(dir, other.assignmentId + '.launch.json');
    if (fs.existsSync(file) && read(file).workerId === workerId) throw Error('worker identity reused');
  }
  const active = custody.assignments.filter(x => fs.existsSync(path.join(dir, x.assignmentId + '.launch.json')) &&
    !fs.existsSync(path.join(dir, x.assignmentId + '.end.json'))).length;
  if (active >= custody.concurrency) throw Error('native concurrency ceiling reached');
  const event = { assignmentId, attemptId: record.attemptId, workerId, at };
  writeNew(path.join(dir, assignmentId + '.launch.json'), event);
  return event;
}
function finish(runRoot, assignmentId, status, at = new Date().toISOString()) {
  const { record, dir } = context(runRoot, assignmentId);
  if (!statuses.has(status) || !Number.isFinite(Date.parse(at))) throw Error('invalid worker completion');
  const launchFile = path.join(dir, assignmentId + '.launch.json');
  if (!fs.existsSync(launchFile)) {
    if (status !== 'launch-failed') throw Error('worker launch record required');
    const event = { assignmentId, attemptId: record.attemptId, workerId: null, status, at };
    writeNew(path.join(dir, assignmentId + '.end.json'), event);
    return event;
  }
  if (status === 'launch-failed') throw Error('launch-failed requires no launch record');
  const start = read(launchFile);
  if (Date.parse(at) < Date.parse(start.at)) throw Error('completion predates launch');
  // A completed worker must have submitted its result before its lifecycle closes.
  if (status === 'completed' && !fs.existsSync(record.resultFile)) throw Error('completed worker missing result');
  const event = { assignmentId, attemptId: record.attemptId, workerId: start.workerId, status, at };
  writeNew(path.join(dir, assignmentId + '.end.json'), event);
  return event;
}
function audit(runRoot, assignmentId) {
  const { record, dir } = context(runRoot, assignmentId);
  let start, end;
  const launchFile = path.join(dir, assignmentId + '.launch.json');
  if (!fs.existsSync(launchFile)) {
    try { end = read(path.join(dir, assignmentId + '.end.json')); }
    catch { return 'worker-not-launched'; }
    return end.assignmentId === assignmentId && end.attemptId === record.attemptId &&
      end.workerId === null && end.status === 'launch-failed' && Number.isFinite(Date.parse(end.at))
      ? 'worker-launch-failed' : 'worker-identity-mismatch';
  }
  try { start = read(launchFile); } catch { return 'worker-identity-mismatch'; }
  try { end = read(path.join(dir, assignmentId + '.end.json')); } catch { return 'worker-incomplete'; }
  if (start.assignmentId !== assignmentId || end.assignmentId !== assignmentId ||
      start.attemptId !== record.attemptId || end.attemptId !== record.attemptId ||
      start.workerId !== end.workerId || !/^\/[\w/-]+$/.test(start.workerId) ||
      !Number.isFinite(Date.parse(start.at)) || !Number.isFinite(Date.parse(end.at)) ||
      Date.parse(end.at) < Date.parse(start.at)) return 'worker-identity-mismatch';
  if (end.status !== 'completed') return 'worker-' + end.status;
  if (!fs.existsSync(record.resultFile)) return 'worker-missing-result';
  return null;
}
function main(args) {
  try {
    if (args[0] === 'launch' && args.length === 4) return { output: launch(args[1], args[2], args[3]), exitCode: 0 };
    if (args[0] === 'finish' && args.length === 4) return { output: finish(args[1], args[2], args[3]), exitCode: 0 };
    if (args[0] === 'audit' && args.length === 3) {
      const problem = audit(args[1], args[2]);
      return { output: { ok: !problem, problem }, exitCode: problem ? 2 : 0 };
    }
    throw Error('usage: launch <runRoot> <assignmentId> <nativeWorkerId> | finish <runRoot> <assignmentId> <status> | audit <runRoot> <assignmentId>');
  } catch (e) { return { output: { ok: false, error: e.message }, exitCode: 2 }; }
}
module.exports = { launch, finish, audit, main };
if (require.main === module) {
  const result = main(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
