'use strict';
// Tests for guards.js — the checks a host tree must pass before it is published.
// Run: node scripts/hosts/guards.test.js
const assert = require('node:assert');
const T = require('./transforms.js');
const { runGuards } = require('./guards.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function tree(obj) {
  return new Map(Object.entries(obj).map(([p, c]) => [p, T.makeFile(c)]));
}
const skill = (name, desc = 'Does a thing.') => `---\nname: ${name}\ndescription: ${desc}\n---\nBody\n`;
const messages = (findings) => findings.map((f) => `${f.guard}:${f.path || ''}:${f.message}`);

test('a clean tree passes every guard', () => {
  const files = tree({
    '.codex-plugin/plugin.json': '{"name":"agentex","version":"1.0.0"}',
    'skills/run-it/SKILL.md': skill('run-it'),
    'skills/run-it/scripts/x.js': 'x',
  });
  assert.deepStrictEqual(runGuards(files, {
    skills: { nameMatchesFolder: true, nameMax: 64, descriptionMax: 1024 },
    forbiddenText: [{ pattern: '\\$\\{CLAUDE_PLUGIN_ROOT\\}' }],
    forbiddenPaths: ['.gitattributes'],
    maxFiles: 10,
    manifest: { path: '.codex-plugin/plugin.json', required: ['name', 'version'] },
  }), []);
});

test('skills: missing SKILL.md, missing fields, bad and mismatched names, long description', () => {
  const files = tree({
    'skills/no-manifest/scripts/x.js': 'x',
    'skills/bare/SKILL.md': 'no frontmatter',
    'skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n',
    'skills/folder/SKILL.md': skill('other-name'),
    'skills/Caps/SKILL.md': skill('Caps'),
    'skills/long/SKILL.md': skill('long', 'x'.repeat(1025)),
  });
  assert.deepStrictEqual(messages(runGuards(files, { skills: { nameMatchesFolder: true, descriptionMax: 1024 } })), [
    'skills:skills/Caps/SKILL.md:name "Caps" is not lowercase-hyphenated',
    'skills:skills/bare/SKILL.md:no frontmatter',
    'skills:skills/folder/SKILL.md:name "other-name" does not match its folder "folder"',
    'skills:skills/long/SKILL.md:description is 1025 chars (max 1024)',
    'skills:skills/no-manifest/:skill folder has no SKILL.md',
    'skills:skills/nodesc/SKILL.md:frontmatter has no description',
  ]);
});

test('skills: name/folder mismatch only counts when the host requires it', () => {
  const files = tree({ 'skills/folder/SKILL.md': skill('other-name') });
  assert.deepStrictEqual(runGuards(files, { skills: {} }), []);
});

test('forbiddenText names every file that still carries the pattern', () => {
  const files = tree({ 'a.md': 'run ${CLAUDE_PLUGIN_ROOT}/x', 'b.md': 'clean', 'c.md': 'AskUserQuestion' });
  assert.deepStrictEqual(messages(runGuards(files, { forbiddenText: [
    { pattern: '\\$\\{CLAUDE_PLUGIN_ROOT\\}', why: 'not expanded here' }, { pattern: 'AskUserQuestion' },
  ] })), [
    'forbiddenText:a.md:contains \\$\\{CLAUDE_PLUGIN_ROOT\\} (not expanded here)',
    'forbiddenText:c.md:contains AskUserQuestion',
  ]);
});

test('forbiddenText: `paths` limits the check to matching files', () => {
  const files = tree({ 'skills/a/SKILL.md': 'use $ARGUMENTS', 'docs/how.md': 'Claude substitutes $ARGUMENTS' });
  assert.deepStrictEqual(messages(runGuards(files, { forbiddenText: [{ pattern: '\\$ARGUMENTS', paths: ['skills'] }] })),
    ['forbiddenText:skills/a/SKILL.md:contains \\$ARGUMENTS']);
});

test('forbiddenPaths, maxFiles and manifest report what is wrong', () => {
  const files = tree({ '.gitattributes': '*', 'x/.DS_Store': '', 'p.json': '{"name":""}' });
  assert.deepStrictEqual(messages(runGuards(files, {
    forbiddenPaths: ['.gitattributes', '**/.DS_Store'],
    maxFiles: 2,
    manifest: { path: 'p.json', required: ['name', 'version'] },
  })), [
    'forbiddenPaths:.gitattributes:path not allowed on this host',
    'forbiddenPaths:x/.DS_Store:path not allowed on this host',
    'maxFiles::tree has 3 files; the limit is 2',
    'manifest:p.json:manifest has no "name"',
    'manifest:p.json:manifest has no "version"',
  ]);
  assert.match(messages(runGuards(tree({ 'p.json': '{oops' }), { manifest: { path: 'p.json' } }))[0],
    /^manifest:p\.json:manifest is not JSON: /);
  assert.deepStrictEqual(messages(runGuards(new Map(), { manifest: { path: 'p.json' } })), ['manifest:p.json:manifest missing']);
});

test('an unknown guard is a configuration error, not a pass', () => {
  assert.throws(() => runGuards(new Map(), { nope: true }), /unknown guard: nope/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
