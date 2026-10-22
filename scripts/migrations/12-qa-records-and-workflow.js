'use strict';
// m12 qa-records-and-workflow — skill consolidation (1.0.0) made two config
// blocks plugin-owned and typed (read through project_config.js getStructured):
// testDesign and qaRecords at the top level of config/project.json, plus a
// `workflow` block inside the CONFIGURED tracker's provider block
// (azure.workflow or jira.workflow). The template ships the two top-level
// blocks and the wizard's save seeds the provider's workflow; this migration
// backfills both into existing projects. The [Testing] task list is not one of
// them: config/estimation.json `tasks[]` (0.24) is its one source.
//
// It goes through withPluginConfigBlocks() — the SAME function the wizard's
// save calls — so a migrated project and a fresh one end with identical blocks.
// Semantics-preserving by construction: the defaults reproduce today's
// behaviour (consolidated approval, workflow states EMPTY so no lifecycle step
// ever guesses a state). Additive + idempotent, à la
// m09/m11:
//   - an existing block is never rewritten (a customized testDesign or
//     workflow wins, parsed-equal, key order kept);
//   - a provider block is never created: a Jira or tracker-less project gets no
//     azure.workflow; with TWO provider blocks neither is touched and a [flag]
//     points at the wizard;
//   - only the qaRecords PATH block is written — the QA watchlist files
//     themselves are created lazily by qa-records.js on first use, never here;
//   - reproSummaryRow is never written (absent = true);
//   - an unreadable config is left alone; environment files, specs and .env are
//     never opened.
const fs = require('fs');
const path = require('path');
const { withPluginConfigBlocks } = require('../lib/project_config.js');

const TOP_LEVEL = ['testDesign', 'qaRecords'];
const PROVIDERS = ['azure', 'jira'];

function projectConfigPath(ctx) { return path.join(ctx.projectRoot, 'config', 'project.json'); }

function readConfig(ctx) {
  const file = projectConfigPath(ctx);
  if (!fs.existsSync(file)) return null;          // m07's job, from the new template
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  } catch { return null; }                        // unreadable config: not this migration's business
}

const configuredProviders = (cfg) =>
  PROVIDERS.filter((p) => cfg[p] && typeof cfg[p] === 'object' && !Array.isArray(cfg[p]) && Object.keys(cfg[p]).length > 0);

// What withPluginConfigBlocks would add to this config (nothing = up to date).
function pending(cfg) {
  const seeded = withPluginConfigBlocks(cfg);
  const blocks = TOP_LEVEL.filter((k) => !(k in cfg));
  const workflow = PROVIDERS.filter((p) => seeded[p] && cfg[p] && !('workflow' in cfg[p]) && 'workflow' in seeded[p]);
  return { seeded, blocks, workflow };
}

module.exports = {
  id: 'qa-records-and-workflow',
  title: 'Add the plugin-owned config blocks (testDesign, qaRecords) and the configured tracker\'s workflow block to config/project.json',

  detect(ctx) {
    const cfg = readConfig(ctx);
    if (!cfg) return false;
    const p = pending(cfg);
    return p.blocks.length > 0 || p.workflow.length > 0;
  },

  apply(ctx) {
    const cfg = readConfig(ctx);
    if (!cfg) return;
    const { seeded, blocks, workflow } = pending(cfg);
    const done = [];
    if (blocks.length) {
      done.push(`config/project.json += ${blocks.join(', ')} (the defaults — today's behaviour; the QA watchlist paths only, its files are created on first use)`);
    }
    for (const p of workflow) done.push(`${p}.workflow (every state empty — name your states to enable the lifecycle steps)`);
    if (configuredProviders(cfg).length > 1) {
      ctx.report.flag('config/project.json has more than one tracker block (azure and jira) — no workflow block was added; fix with the /init-test wizard (choose one tracker)');
    }
    if (!done.length) return;
    ctx.saveJson(projectConfigPath(ctx), seeded);
    ctx.report.migrated(this.id, done.join('; '));
  },
};
