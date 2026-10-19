'use strict';
// m06 claude-md-bullet — the executions/ guidance bullet in the consumer's
// CLAUDE.md. Append-only via the shared scaffold action: existing user lines are
// never rewritten.
const { claudeMdHasBullet, ensureClaudeMdBullet } = require('../lib/scaffold.js');

module.exports = {
  id: 'claude-md-bullet',
  title: 'Ensure CLAUDE.md carries the executions/ guidance bullet',

  detect(ctx) { return !claudeMdHasBullet(ctx.projectRoot); },

  apply(ctx) {
    const a = ensureClaudeMdBullet(ctx.projectRoot);
    ctx.report.migrated(this.id, `${a.path} — ${a.note}`);
  },
};
