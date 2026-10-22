'use strict';
// Unit tests for scripts/lib/plugin_inventory.js — the installed plugin's skill and
// command names, its manifest, and fork detection (field-feedback-loop S-1, appendix A6).
// Run: node scripts/lib/plugin_inventory.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inv = require('./plugin_inventory.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-inv-'));
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
// A fake plugin tree: two skills (one with a folded description), two commands.
function fakePlugin() {
  const root = tmp();
  write(root, '.claude-plugin/plugin.json', JSON.stringify({ name: 'agentex', version: '1.2.3', repository: 'https://example.test/agentex' }));
  write(root, 'skills/test-design/SKILL.md', '---\nname: test-design\ndescription: >\n  Designs test cases\n  for stories.\n---\n# T\n');
  write(root, 'skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: "Estimates QA effort"\n---\n');
  write(root, 'skills/browser-testing/SKILL.md', '---\nname: browser-testing\ndescription: Drives a browser\n---\n');
  write(root, 'commands/design-test.md', '---\ndescription: x\n---\n');
  write(root, 'commands/update-agentex.md', 'no frontmatter\n');
  return root;
}
function skill(project, folder, text) { write(project, `.claude/skills/${folder}/SKILL.md`, text); }

test('readManifest: name, version and the optional repository', () => {
  const m = inv.readManifest(fakePlugin());
  assert.deepStrictEqual([m.name, m.version, m.repository], ['agentex', '1.2.3', 'https://example.test/agentex']);
  const root = tmp();
  write(root, '.claude-plugin/plugin.json', JSON.stringify({ name: 'agentex', version: '0.1.0' }));
  assert.strictEqual(inv.readManifest(root).repository, undefined);
  assert.throws(() => inv.readManifest(tmp()), /plugin\.json/);
});

test('loadInventory: skills from SKILL.md frontmatter name, commands from basenames', () => {
  const i = inv.loadInventory(fakePlugin());
  assert.deepStrictEqual(i.skills, ['browser-testing', 'task-estimation', 'test-design']);
  assert.deepStrictEqual(i.commands, ['design-test', 'update-agentex']);
  assert.ok(i.names.has('design-test') && i.names.has('test-design'));
});

test('the real plugin inventory holds the shipped skills and commands', () => {
  const i = inv.loadInventory(path.resolve(__dirname, '..', '..'));
  assert.ok(i.skills.includes('test-design') && i.skills.includes('browser-driver'));
  assert.ok(i.commands.includes('update-agentex'));
});

test('parseFrontmatter: plain, quoted and folded values', () => {
  const fm = inv.parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\nuser-invocable: false\n---\nbody');
  assert.deepStrictEqual(fm, { name: 'a', description: 'one two', 'user-invocable': 'false' });
  assert.deepStrictEqual(inv.parseFrontmatter('no frontmatter'), {});
});

test('detectForks: by folder name (case-insensitive), by frontmatter name, exposed as the plugin name', () => {
  const plugin = fakePlugin(); const project = tmp();
  skill(project, 'Test-Design', '---\nname: whatever\ndescription: our copy\n---\n');
  skill(project, 'my-copy', '---\nname: task-estimation\ndescription: x\n---\n');
  const forks = inv.detectForks(project, inv.loadInventory(plugin));
  assert.deepStrictEqual(forks.map((f) => [f.plugin, f.rule]).sort(), [['task-estimation', 'name'], ['test-design', 'name']]);
  assert.deepStrictEqual(forks.map((f) => f.path).sort(), ['.claude/skills/Test-Design/', '.claude/skills/my-copy/']);
});

test('detectForks: self-described by description or the first 60 lines', () => {
  const plugin = fakePlugin(); const project = tmp();
  skill(project, 'team-estimates', '---\nname: team-estimates\ndescription: Overrides task-estimation with our weights\n---\n');
  skill(project, 'our-browser', `---\nname: our-browser\ndescription: ours\n---\n${'\n'.repeat(10)}This is a fork of agentex:browser-testing for our app.\n`);
  const forks = inv.detectForks(project, inv.loadInventory(plugin));
  assert.deepStrictEqual(forks.map((f) => [f.plugin, f.rule]).sort(), [['browser-testing', 'self-described'], ['task-estimation', 'self-described']]);
});

test('detectForks: a non-fork is not reported (keyword without a plugin name, name without a keyword, longer name, line 61)', () => {
  const plugin = fakePlugin(); const project = tmp();
  skill(project, 'login-helper', '---\nname: login-helper\ndescription: Replaces manual login steps\n---\n');
  skill(project, 'uses-design', '---\nname: uses-design\ndescription: Reads the output of test-design\n---\n');
  skill(project, 'longer', '---\nname: longer\ndescription: overrides test-design-extra\n---\n');
  skill(project, 'late', `---\nname: late\ndescription: ours\n---\n${'x\n'.repeat(60)}overrides task-estimation\n`);
  assert.deepStrictEqual(inv.detectForks(project, inv.loadInventory(plugin)), []);
});

test('detectForks: symlinked skill folders and SKILL.md files are never followed', () => {
  if (process.platform === 'win32') return;
  const plugin = fakePlugin(); const project = tmp(); const elsewhere = tmp();
  write(elsewhere, 'test-design/SKILL.md', '---\nname: test-design\ndescription: x\n---\n');
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'test-design'), path.join(project, '.claude', 'skills', 'test-design'));
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'task-estimation'), { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'test-design', 'SKILL.md'), path.join(project, '.claude', 'skills', 'task-estimation', 'SKILL.md'));
  assert.deepStrictEqual(inv.detectForks(project, inv.loadInventory(plugin)), []);
});

test('detectForks: no .claude/skills folder -> []; a folder without SKILL.md is skipped', () => {
  const plugin = fakePlugin(); const project = tmp();
  assert.deepStrictEqual(inv.detectForks(project, inv.loadInventory(plugin)), []);
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'test-design'), { recursive: true });
  assert.deepStrictEqual(inv.detectForks(project, inv.loadInventory(plugin)), []);
});

test('detectForks reads, never writes: the project tree is unchanged', () => {
  const plugin = fakePlugin(); const project = tmp();
  skill(project, 'test-design', '---\nname: test-design\n---\n');
  const snap = () => fs.readdirSync(project, { recursive: true }).sort().join('|');
  const before = snap();
  inv.detectForks(project, inv.loadInventory(plugin));
  assert.strictEqual(snap(), before);
});

test('structural: no network or process-spawning module in plugin_inventory.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'plugin_inventory.js'), 'utf8');
  assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|child_process)['"]\)/.test(src));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
