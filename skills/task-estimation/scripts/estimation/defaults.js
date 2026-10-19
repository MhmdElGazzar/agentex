'use strict';
// estimation/defaults.js — the estimation engine's tunable defaults (policy Q8),
// in one place. These are defaults, not guarantees: changing one changes which
// values a proposal flags or how ratings map to hours, never the file format.
//
// The file's own defaults (the starter tasks and the default factors) live with
// the schema, in scripts/lib/estimation_config.js; they are re-exported here so
// the engine reads every tunable from one module.
const path = require('node:path');
const ec = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'estimation_config.js'));

// The agent's only judgment: an integer rating per factor, relative to the
// team's typical story — 0 none · 1 light · 2 typical · 3 heavy · 4 the most this team sees.
const RATING_MIN = 0;
const RATING_MAX = 4;

// Interior hours land on this grid (rounded half-up); the endpoints are always
// the file's own min and max.
const HOURS_STEP = 0.5;

// Outlier rule for a first-run proposal: within one task name, a past estimate
// is abnormally HIGH above median × OUTLIER_RATIO and abnormally LOW under
// median ÷ OUTLIER_RATIO; names with fewer than OUTLIER_MIN_SAMPLE estimates are
// never checked.
const OUTLIER_RATIO = 3;
const OUTLIER_MIN_SAMPLE = 3;

module.exports = {
  RATING_MIN, RATING_MAX, HOURS_STEP, OUTLIER_RATIO, OUTLIER_MIN_SAMPLE,
  STARTER_TASKS: ec.STARTER_TASKS, DEFAULT_FACTORS: ec.DEFAULT_FACTORS, DEFAULT_SPRINTS: ec.DEFAULT_SPRINTS,
};
