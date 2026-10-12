'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { validateProjectRoot, assertManagedPath } = require('../lib/install_paths');
const pluginRoot = path.resolve(__dirname, '../..');
const names = ['agentex-init', 'agentex-test', 'agentex-update', 'agentex-parallel'];
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const metadataParts = ['.agentex', 'codex.json'];
const skillParts = name => ['.agents', 'skills', name, 'SKILL.md'];
function preflight(projectRoot) {
  assertManagedPath(projectRoot, metadataParts);
  for (const name of names) assertManagedPath(projectRoot, skillParts(name), { preserveLeafLink: true });
}
function linkedLeaf(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function syncSkills(projectRoot) {
  projectRoot = validateProjectRoot(projectRoot, pluginRoot);
  preflight(projectRoot);
  const metadata = path.join(projectRoot, '.agentex', 'codex.json');
  const previous = fs.existsSync(metadata) ? JSON.parse(fs.readFileSync(metadata, 'utf8')) : { skills: {} };
  const next = { schemaVersion: 1, pluginRoot, skills: { ...previous.skills } };
  const actions = [];
  for (const name of names) {
    assertManagedPath(projectRoot, skillParts(name), { preserveLeafLink: true });
    const source = path.join(pluginRoot, '.agents', 'skills', name, 'SKILL.md');
    const target = path.join(projectRoot, '.agents', 'skills', name, 'SKILL.md');
    const content = fs.readFileSync(source, 'utf8');
    if (linkedLeaf(target)) {
      actions.push({ skill: name, status: 'preserved-user-edit' });
      continue;
    }
    const old = fs.existsSync(target) ? hash(fs.readFileSync(target)) : null;
    if (old && old !== previous.skills?.[name] && old !== hash(content)) {
      actions.push({ skill: name, status: 'preserved-user-edit' });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertManagedPath(projectRoot, skillParts(name), { preserveLeafLink: true });
    if (old !== hash(content)) fs.writeFileSync(target, content, { flag: old ? 'w' : 'wx' });
    next.skills[name] = hash(content);
    actions.push({ skill: name, status: old === hash(content) ? 'current' : 'installed' });
  }
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  assertManagedPath(projectRoot, metadataParts);
  fs.writeFileSync(metadata, JSON.stringify(next, null, 2) + '\n');
  return actions;
}
function runScript(file, projectRoot) {
  const r = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', file), projectRoot],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function run(mode, projectRoot) {
  if (!['init', 'update'].includes(mode)) throw Error('init or update required');
  projectRoot = validateProjectRoot(projectRoot, pluginRoot);
  preflight(projectRoot);
  const existing = mode === 'update' && fs.existsSync(path.join(projectRoot, '.agentex', 'codex.json'));
  if (mode === 'update' && !existing) throw Error('Codex integration is not initialized');
  const base = runScript(mode === 'init' ? 'init.js' : 'migrate.js', projectRoot);
  if (base.code !== 0) return { ok: false, base, skills: [] };
  return { ok: true, base, skills: syncSkills(projectRoot) };
}
if (require.main === module) {
  try {
    const result = run(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : result.base.code || 1;
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 2; }
}
module.exports = { run, syncSkills };
