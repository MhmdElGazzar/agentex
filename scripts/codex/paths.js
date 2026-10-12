'use strict';
const fs = require('node:fs');
const path = require('node:path');
function resolvePaths(projectRoot, skillName) {
  if (!/^[a-z0-9-]+$/.test(skillName)) throw Error('invalid skill name');
  const { pluginRoot } = JSON.parse(fs.readFileSync(path.join(projectRoot, '.agentex', 'codex.json'), 'utf8'));
  if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot)) throw Error('absolute plugin root required');
  const skillDir = path.join(pluginRoot, 'skills', skillName);
  if (!fs.statSync(path.join(skillDir, 'SKILL.md')).isFile()) throw Error('shared skill unavailable');
  return { pluginRoot, skillDir, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_SKILL_DIR: skillDir };
}
if (require.main === module) {
  try { console.log(JSON.stringify(resolvePaths(process.argv[2], process.argv[3]))); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2; }
}
module.exports = { resolvePaths };
