'use strict';
// m07 fill-gaps — any current-scaffold piece the old project predates (executions/,
// config, environment, catalog samples, sample specs when test/ has none) is created
// by the SAME shared routine /init-test runs, creating only what is absent. Runs
// after the rename (m01) and all carries (m02–m04), so templates land only where
// nothing was carried.
const { scaffoldProject } = require('../lib/scaffold.js');

module.exports = {
  id: 'fill-gaps',
  title: 'Create missing current-scaffold pieces (shared /init-test routine)',

  detect(ctx) {
    return scaffoldProject(ctx.projectRoot, ctx.pluginRoot, { dryRun: true })
      .some(a => a.kind === 'created');
  },

  apply(ctx) {
    const created = scaffoldProject(ctx.projectRoot, ctx.pluginRoot)
      .filter(a => a.kind === 'created');
    ctx.report.migrated(this.id, `created missing scaffold piece(s): ${created.map(a => a.path).join(', ')}`);
  },
};
