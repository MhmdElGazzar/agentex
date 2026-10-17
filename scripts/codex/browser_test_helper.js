'use strict';
// In-memory CLI for host tests. It never starts a browser or a child process.
const { preflight, command, close } = require('./browser_mode');

function completeBrowser(c, { mode = 'HEADLESS', failAfterSuccess = false } = {}) {
  const groups = new Map();
  for (const assignment of c.assignments.filter(a => a.drivers.includes('browser'))) {
    const group = groups.get(assignment.sessionId) || [];
    group.push(assignment);
    groups.set(assignment.sessionId, group);
  }
  for (const [sessionId, records] of groups) {
    const state = { opened: false, closed: false, failAction: false };
    const browser = { name: sessionId, status: 'open', attached: false,
      browserType: 'chrome', headed: mode === 'HEADED', pid: 4242 };
    const runner = args => {
      if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ browsers:
        state.opened && !state.closed ? [browser] : [] }) };
      if (args.includes('open')) {
        state.opened = true;
        return { status: 0, stdout: JSON.stringify({ session: sessionId, pid: 4242 }) };
      }
      if (args.includes('goto') && state.failAction) return { status: 1, stderr: 'synthetic secret' };
      if (args.includes('close')) state.closed = true;
      return { status: 0, stdout: '' };
    };
    const context = record => ({ projectRoot: c.runRoot, runId: c.runId,
      assignmentId: record.assignmentId, sessionDir: record.sessionDir,
      sessionId, requestedMode: mode, runner, isAlive: () => true });
    const first = context(records[0]);
    if (!preflight(first).verified) throw Error('mock preflight failed');
    for (const record of records) command(context(record), ['goto', 'about:blank']);
    if (failAfterSuccess) {
      state.failAction = true;
      try { command(context(records.at(-1)), ['goto', 'about:blank']); }
      catch { /* The host audit must reject the claimed PASS. */ }
    }
    close(context(records.at(-1)));
  }
}
module.exports = { completeBrowser };
