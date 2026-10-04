'use strict';

const fs = require('node:fs');
const path = require('node:path');

function manifest(root) {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (value.name !== 'agentex' || typeof value.version !== 'string') {
    throw new Error('not an AgenTeX package');
  }
  return value;
}

function resolveRuntime({ packageRoot = path.resolve(__dirname, '..') } = {}) {
  const adapterRoot = fs.realpathSync(packageRoot);
  const packaged = fs.existsSync(path.join(adapterRoot, 'core'));
  const coreRoot = fs.realpathSync(packaged ? path.join(adapterRoot, 'core') : path.join(adapterRoot, '..'));
  const { validRoot } = require(path.join(coreRoot, 'scripts', 'lib', 'plugin_root.js'));
  if (!validRoot(coreRoot)) throw new Error('shared AgenTeX core is missing or invalid');
  const core = manifest(coreRoot);
  const claude = JSON.parse(fs.readFileSync(path.join(coreRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (claude.name !== 'agentex' || claude.version !== core.version) {
    throw new Error('shared core manifests disagree');
  }
  if (packaged) {
    const adapter = manifest(adapterRoot);
    if (adapter.version !== core.version) throw new Error('Copilot package and core versions disagree');
  } else if (path.basename(adapterRoot) !== 'copilot' ||
      !fs.existsSync(path.join(adapterRoot, 'skills', 'agentex-init', 'SKILL.md'))) {
    throw new Error('not a Copilot source adapter');
  }
  return { packageRoot: adapterRoot, coreRoot, version: core.version, mode: packaged ? 'package' : 'source' };
}

if (require.main === module) {
  try { console.log(JSON.stringify({ ok: true, ...resolveRuntime() })); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; }
}

module.exports = { resolveRuntime };
