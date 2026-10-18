'use strict';
// m01 rename-integrations-folder — 0.6 → 0.7 rename of the consumer catalog folder:
// integrations/ → integration/. Runs FIRST so gap-fill (m07) never scaffolds a fresh
// integration/ beside the old folder. If both folders exist the engine never guesses
// a merge — it emits [manual] and leaves everything untouched.
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'rename-integrations-folder',
  title: 'Rename legacy integrations/ catalog folder to integration/',

  detect(ctx) {
    const legacy = path.join(ctx.projectRoot, 'integrations');
    return fs.existsSync(legacy) && fs.statSync(legacy).isDirectory();
  },

  apply(ctx) {
    const legacy = path.join(ctx.projectRoot, 'integrations');
    const current = path.join(ctx.projectRoot, 'integration');
    if (fs.existsSync(current)) {
      ctx.report.manual('both integrations/ and integration/ exist — merge by hand: move the catalog files you keep into integration/, then delete integrations/');
      return;
    }
    fs.renameSync(legacy, current);
    ctx.report.migrated(this.id, 'integrations/ → integration/ (contents untouched)');
  },
};
