'use strict';
// Deprecated path. The CI gate moved to skills/test-execution/scripts/ci_gate.js.
// This forwarder keeps pipelines that pasted the old template path working: it runs the
// real gate with the same arguments, stdio, and exit code. Update your pipeline to the new
// path; this file will be removed in a later minor release.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REAL = path.join(__dirname, '..', '..', 'test-execution', 'scripts', 'ci_gate.js');
process.stderr.write('ci_gate: DEPRECATED path skills/browser-testing/scripts/ci_gate.js — use skills/test-execution/scripts/ci_gate.js\n');
const r = spawnSync(process.execPath, [REAL, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = r.status ?? 2;
