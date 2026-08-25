'use strict';
// m05 gitignore-secrets — 0.3+ scaffolds the .env entry; older projects may lack
// it, and NO project scaffolded before this migration existed has the entries for
// the saved login sessions (test/.auth/) or the playwright-cli scratch profile,
// both of which hold a live session. It also adds test/.ui-baselines/ — the ui-check
// fallback baseline cache, no credential but no reason to commit either. Append-only,
// per missing entry, via the same shared scaffold action /init-test uses.
const { gitignoreMissing, ensureGitignore } = require('../lib/scaffold.js');

module.exports = {
  id: 'gitignore-secrets',
  title: 'Ensure .gitignore covers .env, saved sessions, browser scratch and the baseline cache',

  detect(ctx) { return gitignoreMissing(ctx.projectRoot).length > 0; },

  apply(ctx) {
    const a = ensureGitignore(ctx.projectRoot);
    ctx.report.migrated(this.id, `${a.path} — ${a.note}`);
  },
};
