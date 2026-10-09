'use strict';
// m10 phantom-sample-env — the pre-0.17 scaffold copied the sample environment
// unconditionally, so a wizard save under any other name left it behind as a
// phantom: an environment the user never configured that a run could silently
// resolve against (invariant #10 inverted). This migration detects such a
// leftover and OFFERS its removal — it never deletes on its own (invariant #11).
//
// A file counts as a phantom only when ALL THREE hold:
//   1. it is structurally identical to a sample template the plugin ever
//      shipped (current qc shape or the historical qa-era shape) — zero user
//      values, verified;
//   2. its name is NOT the project's defaultEnvironment;
//   3. at least one other environment file exists (the user's real one).
// A lone pristine sample on an unconfigured project is legitimate scaffolding.
//
// Consent execution: apply() emits a [manual] line (which withholds the stamp —
// a phantom that can satisfy environment resolution must not be waved through
// by a version stamp). After the user confirms through the /update-agentex
// relay, the engine is re-run as `node scripts/migrate.js
// --remove-phantom-sample` and THIS module deletes the file and reports
// [migrated]. Renaming the file or changing any value in it (claiming it) also
// clears detection.
const fs = require('fs');
const path = require('path');
const { isPristineSampleEnv } = require('../lib/scaffold.js');

function phantoms(ctx) {
  const dir = path.join(ctx.projectRoot, 'environments');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length < 2) return [];   // no other environment — nothing is a phantom
  const defaultName = ctx.envName();
  return files.filter(f => {
    if (f.slice(0, -5) === defaultName) return false;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { return false; }          // unreadable → treated as the user's, hands off
    return isPristineSampleEnv(parsed, ctx.pluginRoot);
  });
}

module.exports = {
  id: 'phantom-sample-env',
  title: 'Offer removal of a pristine sample environment left by the old scaffold',

  detect(ctx) {
    return phantoms(ctx).length > 0;
  },

  apply(ctx) {
    const rels = phantoms(ctx).map(f => `environments/${f}`);
    if (ctx.flags && ctx.flags.removePhantomSample) {
      for (const rel of rels) fs.unlinkSync(path.join(ctx.projectRoot, ...rel.split('/')));
      ctx.report.migrated(this.id, `removed pristine phantom sample(s) with your consent: ${rels.join(', ')}`);
      return;
    }
    ctx.report.manual(
      `${rels.join(', ')}: pristine sample environment(s) the old scaffold left behind — ` +
      'structurally identical to the shipped sample (zero user values) and not this project\'s ' +
      'default environment; a run addressed to it would resolve against sample data instead of ' +
      'erroring. To remove: re-run the engine as "node scripts/migrate.js --remove-phantom-sample" ' +
      '(only after the user explicitly confirms). To keep it: rename the file or change any value ' +
      'in it — a claimed file clears this check.'
    );
  },
};
