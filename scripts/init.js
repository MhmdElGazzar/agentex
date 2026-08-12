// AgenTeX project scaffolder — the file-scaffolding steps of /init-test in a single call.
//
// Usage: node init.js [projectDir]   (default: current working directory)
// Idempotent and non-destructive: never overwrites an existing file; CLAUDE.md and
// .gitignore are append-only. Prints one [created]/[skipped] line per action and a
// final summary. Exit 0 on success, 1 on error.
//
// The scaffold actions themselves live in scripts/lib/scaffold.js, shared with the
// /update-agentex migration engine — one definition of "current conventions".
const path = require('path');
const {
  scaffoldProject, hasLegacySignals, readVersionStamp, writeVersionStamp, readPluginVersion, STAMP_REL,
} = require('./lib/scaffold.js');

const pluginRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || process.cwd());

if (projectRoot === pluginRoot) {
  console.error('[error] refusing to scaffold inside the AgenTeX plugin itself — run from your project root');
  process.exit(1);
}

let created = 0, skipped = 0;
const print = a => {
  if (a.kind === 'created') created++; else skipped++;
  console.log(`[${a.kind}] ${a.path}${a.note ? ` — ${a.note}` : ''}`);
};

for (const action of scaffoldProject(projectRoot, pluginRoot)) print(action);

// Version stamp — written at scaffold time so /update-agentex can compare exact
// versions later. Two cases where init must NOT write it:
//   - an existing stamp is never overwritten (re-stamping would hide the project's
//     real age from the migrator — only /update-agentex moves a stamp forward);
//   - a project with legacy signals (pre-rename integrations/, agentex.config.json,
//     legacy keys in .env) stays stamp-less, or the migrator would fast-path it as
//     up to date while legacy conventions remain; /update-agentex stamps it after
//     migrating.
if (readVersionStamp(projectRoot)) {
  print({ kind: 'skipped', path: STAMP_REL, note: 'already stamped — run /update-agentex after plugin updates' });
} else if (hasLegacySignals(projectRoot)) {
  print({ kind: 'skipped', path: STAMP_REL, note: 'legacy conventions detected — run /update-agentex to migrate this project and stamp it' });
} else {
  print(writeVersionStamp(projectRoot, readPluginVersion(pluginRoot)));
}

console.log(`\nAgenTeX scaffold done: ${created} created, ${skipped} skipped (existing files are never overwritten).`);
