#!/usr/bin/env node
'use strict';
// AgenTeX pre-commit hook installer — the mechanics behind /init-test step 6.
//
//   node scripts/precommit_hook.js status  [projectDir]
//   node scripts/precommit_hook.js install [projectDir]   (only after the user's explicit yes)
//   node scripts/precommit_hook.js print   [projectDir]   (standalone script for an existing hook)
//
// One JSON line on stdout. status: absent | installed | stale | foreign |
// shared-hooks-path | not-a-repo. install: installed | already-installed |
// refreshed | refused (foreign / shared-hooks-path) | not-a-repo. Exit 0 when the
// hook is in place (or for status/print), 1 when the install was refused, 2 when it
// could not run (not a git repository, git missing, usage). Writes only on install,
// only into the repository's own hooks location, never over an existing hook.
const path = require('path');
const hook = require('./lib/precommit_hook.js');

const USAGE = 'usage: precommit_hook.js (status | install | print) [projectDir]';

function main(argv) {
  const [action, dir] = argv;
  const projectRoot = path.resolve(dir || process.cwd());
  if (action === 'status') return { ...hook.status(projectRoot), exit: 0 };
  if (action === 'install') return hook.install(projectRoot);
  if (action === 'print') { const r = hook.printScript(projectRoot); return { exit: 0, ...r }; }
  return { action: action || null, error: 'usage', message: USAGE, exit: 2 };
}

let r;
try { r = main(process.argv.slice(2)); }
catch (e) {
  r = { error: e.code === 'git-missing' ? 'git-missing' : 'failed', message: e.code === 'git-missing' ? 'git was not found on this machine' : 'the hook installer stopped unexpectedly', exit: 2 };
}
const { exit, ...out } = r;
process.stdout.write(JSON.stringify(out) + '\n');
process.exitCode = exit;
