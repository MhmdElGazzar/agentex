'use strict';
// m05 gitignore-env — 0.3+ scaffolds gitignore .env; older projects may lack the
// entry. Append-only, via the same shared scaffold action /init-test uses.
const { gitignoreHasEnvEntry, ensureGitignoreEnv } = require('../lib/scaffold.js');

module.exports = {
  id: 'gitignore-env',
  title: 'Ensure .gitignore has a .env entry',

  detect(ctx) { return !gitignoreHasEnvEntry(ctx.projectRoot); },

  apply(ctx) {
    const a = ensureGitignoreEnv(ctx.projectRoot);
    ctx.report.migrated(this.id, `${a.path} — ${a.note}`);
  },
};
