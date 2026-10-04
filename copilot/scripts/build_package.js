'use strict';

// Assemble one official Agent Plugins 1.0 package. Only root skills/ is
// discoverable; shared code is present under core/ without a second QA logic path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sourceRoot = path.resolve(__dirname, '..', '..');
const adapterRoot = path.resolve(__dirname, '..');
const entries = [
  'agentex-init', 'agentex-ask-kb', 'agentex-test', 'agentex-define-flow',
  'agentex-estimate-story', 'agentex-design-test', 'agentex-bug-report-azure',
  'agentex-update',
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function filesIn(dir) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`symlink in package source: ${file}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push(file);
      else throw new Error(`unsupported package source entry: ${file}`);
    }
  };
  visit(dir);
  return files;
}

function sourceFiles() {
  const mapped = new Map();
  const add = (source, output) => {
    if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) {
      throw new Error(`invalid source file: ${source}`);
    }
    if (mapped.has(output)) throw new Error(`duplicate package path: ${output}`);
    mapped.set(output, source);
  };
  add(path.join(sourceRoot, 'plugin.json'), 'plugin.json');
  for (const name of ['resolve_runtime.js', 'init_plan.js', 'validate_package.js', 'copilot_update.js', 'host_worker.js']) {
    add(path.join(adapterRoot, 'scripts', name), `scripts/${name}`);
  }
  for (const name of entries) {
    add(path.join(adapterRoot, 'skills', name, 'SKILL.md'), `skills/${name}/SKILL.md`);
  }
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json', '.env.example']) {
    add(path.join(sourceRoot, rel), `core/${rel}`);
  }
  for (const dir of ['scripts', 'skills', 'references', 'templates', 'test']) {
    const base = path.join(sourceRoot, dir);
    for (const file of filesIn(base)) {
      const rel = path.relative(sourceRoot, file).replace(/\\/g, '/');
      // The canonical coordinator is shared by Codex and Copilot. Keep only
      // this exact internal resource; no Codex entry SKILL.md is discoverable.
      if (/\.test\.js$/i.test(rel) || rel === 'scripts/codex_update.js' ||
          (/^skills\/agentex-[^/]+\//.test(rel) &&
            rel !== 'skills/agentex-test/scripts/parallel.js')) continue;
      add(file, `core/${rel}`);
    }
  }
  return mapped;
}

function buildPackage(outputRoot) {
  if (!outputRoot || typeof outputRoot !== 'string') throw new Error('output directory required');
  const out = path.resolve(outputRoot);
  if (fs.existsSync(out)) throw new Error('output already exists; refusing overwrite');
  if (out === sourceRoot || out === adapterRoot || inside(out, sourceRoot) || inside(out, adapterRoot)) {
    throw new Error('output may not contain source');
  }
  const parent = fs.realpathSync(path.dirname(out));
  if (!fs.statSync(parent).isDirectory()) throw new Error('output parent must be a directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'agentex' || manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
    throw new Error('source is not an Agent Plugins 1.0 AgenTeX package');
  }
  const files = sourceFiles();
  const fingerprints = {};
  fs.mkdirSync(out);
  for (const [relative, source] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = path.join(out, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fingerprints[relative] = sha(fs.readFileSync(destination));
  }
  fs.writeFileSync(path.join(out, 'package-integrity.json'), JSON.stringify({
    schemaVersion: 1, name: 'agentex', version: manifest.version,
    entrySkills: entries, files: fingerprints,
  }, null, 2) + '\n', { flag: 'wx' });
  return require('./validate_package.js').validatePackage(out);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--out') throw new Error('usage: build_package.js --out <new-directory>');
    const out = path.resolve(args[1]);
    const allowed = path.join(sourceRoot, 'executions');
    if (!inside(allowed, out) || !fs.existsSync(allowed)) throw new Error('CLI output must be a new directory under executions/');
    const parent = fs.realpathSync(path.dirname(out));
    if (!inside(fs.realpathSync(allowed), parent) && parent !== fs.realpathSync(allowed)) {
      throw new Error('CLI output parent resolves outside executions/');
    }
    console.log(JSON.stringify(buildPackage(out)));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

module.exports = { buildPackage, sourceFiles, entries };
