'use strict';
// m11 user-field-schema — wizard design #4 made the test-user and defaults
// field sets a consumer-owned schema: `userFields` + `defaultsFields`
// descriptor arrays in config/project.json (defined once, shared across ALL
// environments; values stay per-environment). The template now ships the
// built-in arrays; this migration backfills them into existing projects.
// Semantics-preserving by construction: the built-ins describe exactly the
// fields the wizard has always written. Additive + idempotent, à la m09:
// an existing array is never rewritten (a customized schema wins), only a
// missing one is added, and environment files / user values are never touched.
const fs = require('fs');
const path = require('path');
const { BUILTIN_USER_FIELDS, BUILTIN_DEFAULTS_FIELDS } = require('../wizard/engine.js');

function projectConfigPath(ctx) { return path.join(ctx.projectRoot, 'config', 'project.json'); }

function missingArrays(ctx) {
  const file = projectConfigPath(ctx);
  if (!fs.existsSync(file)) return [];                // m07's job, from the new template
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }                                // unreadable config: not this migration's business
  const missing = [];
  if (config.userFields === undefined) missing.push('userFields');
  if (config.defaultsFields === undefined) missing.push('defaultsFields');
  return missing;
}

module.exports = {
  id: 'user-field-schema',
  title: 'Add the userFields/defaultsFields built-in arrays to config/project.json (consumer-owned field schema)',

  detect(ctx) {
    return missingArrays(ctx).length > 0;
  },

  apply(ctx) {
    const file = projectConfigPath(ctx);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const done = [];
    const builtins = {
      userFields: ctx.templates.project.userFields || BUILTIN_USER_FIELDS,
      defaultsFields: ctx.templates.project.defaultsFields || BUILTIN_DEFAULTS_FIELDS,
    };
    for (const which of missingArrays(ctx)) {
      config[which] = JSON.parse(JSON.stringify(builtins[which]));
      done.push(`config/project.json += ${which} (built-ins — exactly the fields the wizard always wrote)`);
    }
    ctx.saveJson(file, config);
    ctx.report.migrated(this.id, done.join('; '));
  },
};
