'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validRoot(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  const root = path.resolve(candidate);
  const manifest = ['plugin.json', path.join('.claude-plugin', 'plugin.json')]
    .some((relative) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
        return data && data.name === 'agentex' && typeof data.version === 'string';
      } catch { return false; }
    });
  return manifest && fs.existsSync(path.join(root, 'skills', 'test-execution', 'SKILL.md'))
    && fs.existsSync(path.join(root, 'scripts', 'init.js'));
}

function resolvePluginRoot({ env = process.env, scriptFile = __filename } = {}) {
  for (const key of ['AGENTEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
    if (env[key]) {
      const root = path.resolve(env[key]);
      if (!validRoot(root)) throw new Error(`${key} is not an AgenTeX plugin root: ${root}`);
      return root;
    }
  }
  const root = path.resolve(path.dirname(scriptFile), '..', '..');
  if (!validRoot(root)) throw new Error(`script-relative AgenTeX plugin root is invalid: ${root}`);
  return root;
}

module.exports = { resolvePluginRoot, validRoot };
