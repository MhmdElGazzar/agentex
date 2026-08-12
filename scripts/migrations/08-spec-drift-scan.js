'use strict';
// m08 spec-drift-scan — REPORT-ONLY. User-authored specs under test/ are never
// rewritten (binding decision: plugin-created files only); when spec conventions
// drifted between versions this scan flags them instead. Always runs; never
// modifies a file — which is exactly what keeps the byte-identical-specs AC true.
//
// Initial drift signals (design default for open question 5 — extend as user
// reports surface more):
//   - references to the old integrations/ catalog folder (renamed 0.7);
//   - legacy .env variable names (their values now live in the JSON config files);
//   - retired artifacts: agentex.config.json (KB era) and the /qa-test command
//     (renamed /execute-test in 0.2).
const fs = require('fs');
const path = require('path');
const { ENV_KEY_MAP } = require('../lib/env_key_map.js');

const PATTERNS = [
  [/integrations\//, 'references the old integrations/ catalog folder (now integration/)'],
  [new RegExp(`\\b(${Object.keys(ENV_KEY_MAP).join('|')})\\b`),
    'references a legacy .env key — its value now lives in config/project.json / environments/<env>.json'],
  [/agentex\.config\.json/, 'references the retired agentex.config.json (kb settings now live in config/project.json)'],
  [/\/qa-test\b/, 'references the retired /qa-test command (now /execute-test)'],
];

function* specFiles(dir, root) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* specFiles(full, root);
    else if (/\.md$/i.test(entry.name) && entry.name.toLowerCase() !== 'readme.md') {
      yield { full, rel: path.relative(root, full).split(path.sep).join('/') };
    }
  }
}

module.exports = {
  id: 'spec-drift-scan',
  title: 'Flag stale conventions in user-authored specs (report-only)',

  detect() { return true; },   // always runs; apply never modifies anything

  apply(ctx) {
    for (const { full, rel } of specFiles(path.join(ctx.projectRoot, 'test'), ctx.projectRoot)) {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      const flaggedPatterns = new Set();   // one flag per (file, pattern) — first hit
      lines.forEach((line, i) => {
        PATTERNS.forEach(([re, msg], p) => {
          if (flaggedPatterns.has(p)) return;
          const m = line.match(re);
          if (m) {
            flaggedPatterns.add(p);
            const what = m[1] ? msg.replace('a legacy .env key', `legacy .env key ${m[1]}`) : msg;
            ctx.report.flag(`spec drift ${rel}:${i + 1} — ${what}; specs are yours — the migration never edits them`);
          }
        });
      });
    }
  },
};
