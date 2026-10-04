'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePluginRoot, validRoot } = require('./plugin_root.js');

const root = path.resolve(__dirname, '..', '..');
assert.equal(validRoot(root), true);
assert.equal(resolvePluginRoot({ env: { AGENTEX_PLUGIN_ROOT: root }, scriptFile: __filename }), root);
assert.equal(resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: root }, scriptFile: __filename }), root);
assert.equal(resolvePluginRoot({ env: {}, scriptFile: __filename }), root);
assert.equal(resolvePluginRoot({ env: { AGENTEX_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: 'bad' }, scriptFile: __filename }), root);

const invalid = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-invalid-root-'));
assert.equal(validRoot(invalid), false);
assert.throws(() => resolvePluginRoot({ env: { AGENTEX_PLUGIN_ROOT: invalid }, scriptFile: __filename }), /AGENTEX_PLUGIN_ROOT/);
assert.throws(() => resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: invalid }, scriptFile: __filename }), /CLAUDE_PLUGIN_ROOT/);
assert.throws(() => resolvePluginRoot({ env: {}, scriptFile: path.join(invalid, 'scripts', 'lib', 'plugin_root.js') }), /script-relative/);
fs.rmdirSync(invalid);
console.log('plugin_root: 8 passed');
