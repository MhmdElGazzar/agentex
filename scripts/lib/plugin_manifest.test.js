'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const portable = read('plugin.json');
const codex = read('.codex-plugin/plugin.json');
const claude = read('.claude-plugin/plugin.json');

assert.equal(portable.name, 'agentex');
assert.equal(codex.name, portable.name);
assert.equal(claude.name, portable.name);
assert.equal(codex.version, claude.version);
assert.equal(portable.version, claude.version);

const sharedSkills = path.resolve(root, codex.skills);
assert.equal(sharedSkills, path.join(root, 'skills'));
for (const name of ['agentex-init', 'agentex-test', 'agentex-executor', 'agentex-define-flow',
  'agentex-ask-kb', 'agentex-estimate-story', 'agentex-design-test', 'agentex-bug-report-azure', 'agentex-update', 'test-execution', 'browser-driver']) {
  assert.equal(fs.existsSync(path.join(sharedSkills, name, 'SKILL.md')), true, name);
  const skill = fs.readFileSync(path.join(sharedSkills, name, 'SKILL.md'), 'utf8');
  assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, 'm'), name);
  assert.match(skill, /^description:/m, name);
}
assert.equal(fs.existsSync(path.join(root, '.codex-plugin', 'skills')), false);
assert.equal(fs.existsSync(path.join(root, 'skills', 'agentex-define-flow', 'scripts', 'session_owner.js')), true);
console.log('plugin manifests and shared skill paths: 16 passed');
