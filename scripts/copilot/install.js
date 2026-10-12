'use strict';
// Install only the two workspace custom agents. Never overwrite consumer edits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProjectRoot, assertManagedPath } = require('../lib/install_paths');
const pluginRoot = path.resolve(__dirname, '../..');
const names = ['agentex-copilot-parallel', 'agentex-copilot-executor'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const metadataParts = ['.agentex', 'copilot.json'];
const agentParts = name => ['.github', 'agents', name + '.agent.md'];
function preflight(projectRoot) {
  assertManagedPath(projectRoot, metadataParts);
  for (const name of names) assertManagedPath(projectRoot, agentParts(name), { preserveLeafLink: true });
}
function linkedLeaf(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function install(projectRootInput) {
  const projectRoot = validateProjectRoot(projectRootInput, pluginRoot);
  preflight(projectRoot);
  const metadataFile = path.join(projectRoot, '.agentex', 'copilot.json');
  const previous = fs.existsSync(metadataFile) ? JSON.parse(fs.readFileSync(metadataFile, 'utf8')) : { agents: {} };
  const agents = { ...previous.agents };
  const actions = [];
  for (const name of names) {
    assertManagedPath(projectRoot, agentParts(name), { preserveLeafLink: true });
    const source = path.join(pluginRoot, '.github', 'agents', name + '.agent.md');
    const destination = path.join(projectRoot, '.github', 'agents', name + '.agent.md');
    const content = fs.readFileSync(source);
    const digest = hash(content);
    if (linkedLeaf(destination) || (fs.existsSync(destination) &&
        ![agents[name], digest].includes(hash(fs.readFileSync(destination))))) {
      actions.push({ agent: name, status: 'preserved-user-edit' });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    assertManagedPath(projectRoot, agentParts(name), { preserveLeafLink: true });
    const current = fs.existsSync(destination) ? hash(fs.readFileSync(destination)) : null;
    if (current !== digest) fs.writeFileSync(destination, content, { flag: current ? 'w' : 'wx' });
    agents[name] = digest;
    actions.push({ agent: name, status: current === digest ? 'current' : 'installed' });
  }
  fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
  assertManagedPath(projectRoot, metadataParts);
  fs.writeFileSync(metadataFile, JSON.stringify({ schemaVersion: 1, pluginRoot, agents }, null, 2) + '\n');
  return { ok: true, projectRoot, pluginRoot, actions };
}
if (require.main === module) {
  try { console.log(JSON.stringify(install(process.argv[2]))); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; }
}
module.exports = { install, names };
