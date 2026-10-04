'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveRuntime } = require('./resolve_runtime.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedEntries = [
  'agentex-init', 'agentex-ask-kb', 'agentex-test', 'agentex-define-flow',
  'agentex-estimate-story', 'agentex-design-test', 'agentex-bug-report-azure',
  'agentex-update',
];

function allFiles(root) {
  const result = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlink in installed package');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) result.push(path.relative(root, file).replace(/\\/g, '/'));
      else throw new Error('unsupported installed package entry');
    }
  };
  visit(root);
  return result.sort();
}

function validatePackage(packageRoot) {
  const root = fs.realpathSync(packageRoot);
  const runtime = resolveRuntime({ packageRoot: root });
  if (runtime.mode !== 'package') throw new Error('not an assembled Copilot package');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' ||
      manifest.name !== 'agentex' || manifest.version !== runtime.version) {
    throw new Error('invalid Copilot package identity or version');
  }
  const integrity = JSON.parse(fs.readFileSync(path.join(root, 'package-integrity.json'), 'utf8'));
  if (integrity.schemaVersion !== 1 || integrity.name !== 'agentex' || integrity.version !== manifest.version ||
      JSON.stringify(integrity.entrySkills) !== JSON.stringify(expectedEntries)) {
    throw new Error('invalid package integrity metadata');
  }
  const skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).map(e => {
    if (!e.isDirectory()) throw new Error('unexpected root skill entry');
    return e.name;
  }).sort();
  if (JSON.stringify(skills) !== JSON.stringify([...expectedEntries].sort())) {
    throw new Error('unexpected routable skill in Copilot package');
  }
  for (const name of skills) {
    const body = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    if (!body.startsWith(`---\nname: ${name}\n`) || !/^description:\s*\S/m.test(body)) {
      throw new Error(`invalid skill frontmatter: ${name}`);
    }
  }
  const actual = allFiles(root).filter(f => f !== 'package-integrity.json');
  const listed = Object.keys(integrity.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(listed)) throw new Error('package file inventory differs from fingerprint');
  for (const file of actual) {
    if (sha(fs.readFileSync(path.join(root, ...file.split('/')))) !== integrity.files[file]) {
      throw new Error(`package fingerprint mismatch: ${file}`);
    }
  }
  const required = [
    'core/scripts/init.js', 'core/scripts/lib/scaffold.js',
    'core/skills/ask-kb/SKILL.md', 'core/skills/ask-kb/references/kb-ask-api.md',
    'core/skills/ask-kb/scripts/ask_kb.js', 'core/skills/test-execution/SKILL.md',
    'core/skills/agentex-test/scripts/parallel.js',
    'scripts/host_worker.js',
    'core/skills/api-integration/templates/sample_api.json',
    'core/skills/db-integration/templates/sample_db.json',
    'core/templates/config/project.json', 'core/templates/environments/qc.json',
    'core/test/README.md', 'core/test/suite1/product-search.md',
  ];
  if (required.some(file => !actual.includes(file))) throw new Error('required shared resource missing');
  if (actual.some(file => (file !== 'core/skills/agentex-test/scripts/parallel.js' &&
      /^core\/skills\/agentex-[^/]+\//.test(file)) || file === 'core/scripts/codex_update.js')) {
    throw new Error('Codex entry or lifecycle code leaked into Copilot package');
  }
  return { ok: true, name: manifest.name, version: manifest.version, packageRoot: root,
    coreRoot: runtime.coreRoot, entrySkills: skills, sharedSkillCount: fs.readdirSync(path.join(root, 'core', 'skills')).length,
    fileCount: actual.length, fingerprint: sha(JSON.stringify(integrity.files)) };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--package') throw new Error('usage: validate_package.js --package <installed-root>');
    console.log(JSON.stringify(validatePackage(args[1])));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

module.exports = { validatePackage };
