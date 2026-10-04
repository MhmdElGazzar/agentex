'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..', '..');
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-codex-init-'));
const instructions = '# Existing project instructions\nDo not replace me.\n';

try {
  fs.writeFileSync(path.join(consumer, 'AGENTS.md'), instructions);
  const run = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'init.js'), consumer], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.readFileSync(path.join(consumer, 'AGENTS.md'), 'utf8'), instructions);
  assert.equal(fs.existsSync(path.join(consumer, 'CLAUDE.md')), true);
  assert.equal(fs.existsSync(path.join(consumer, '.agentex', 'version.json')), true);
  console.log('agentex-init: 3 passed');
} finally {
  fs.rmSync(consumer, { recursive: true, force: true });
}
