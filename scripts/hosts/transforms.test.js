'use strict';
// Tests for transforms.js — the host-build transforms over an in-memory plugin tree.
// Run: node scripts/hosts/transforms.test.js
const assert = require('node:assert');
const T = require('./transforms.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function tree(obj) {
  return new Map(Object.entries(obj).map(([p, c]) => [p, T.makeFile(c)]));
}
function read(files, p) {
  assert.ok(files.has(p), `missing ${p}`);
  return T.text(files.get(p));
}
const CTX = { host: 'copilot', label: 'GitHub Copilot', version: '1.2.3' };
const MANIFEST = JSON.stringify({
  $schema: 'https://json.schemastore.org/claude-code-plugin.json',
  name: 'agentex', version: '1.2.3', description: 'Agentic QA', author: { name: 'M' },
  license: 'MIT', keywords: ['qa'],
});

test('patterns: a bare path matches itself and everything below it, nothing else', () => {
  const m = T.matcher(['evals', '.gitattributes']);
  assert.ok(m('evals/a/prompt.md'));
  assert.ok(m('.gitattributes'));
  assert.ok(!m('evals-extra/x.md'));
  assert.ok(!m('docs/evals.md'));
});

test('patterns: * stays in one segment, **/ spans any depth', () => {
  const m = T.matcher(['**/*.test.js', 'skills/*/SKILL.md']);
  assert.ok(m('a.test.js'));
  assert.ok(m('skills/x/scripts/run.test.js'));
  assert.ok(!m('skills/x/scripts/run.js'));
  assert.ok(m('skills/x/SKILL.md'));
  assert.ok(!m('skills/x/refs/SKILL.md'));
  assert.ok(T.matcher(['skills/*/scripts/golden'])('skills/x/scripts/golden/ado/a.json'), 'a star pattern covers what is below it');
});

test('frontmatter: plain, quoted and folded values; body kept intact', () => {
  const src = '---\nname: x\ndescription: >\n  first line\n  second line\nhint: "a \\"q\\""\nsq: \'it\'\'s\'\n---\nBody\n';
  const { data, body } = T.parseFrontmatter(src);
  assert.deepStrictEqual(data, { name: 'x', description: 'first line second line', hint: 'a "q"', sq: "it's" });
  assert.strictEqual(body, 'Body\n');
  assert.deepStrictEqual(T.parseFrontmatter('no header').data, null);
});

test('frontmatter: rendered header parses back to the same values', () => {
  const data = { name: 'x', description: 'Say "hi": now', 'disable-model-invocation': true };
  assert.deepStrictEqual(T.parseFrontmatter(T.renderFrontmatter(data) + 'b').data,
    { ...data, 'disable-model-invocation': 'true' });
});

test('manifest: picks fields, adds host fields, drops $schema, can remove the Claude manifest', () => {
  const files = tree({ '.claude-plugin/plugin.json': MANIFEST });
  T.TRANSFORMS.manifest(files, {
    target: '.codex-plugin/plugin.json', pick: ['name', 'version', 'description', 'author'],
    fields: { interface: { displayName: 'AgenTeX' } }, removeSource: true,
  });
  assert.ok(!files.has('.claude-plugin/plugin.json'));
  assert.deepStrictEqual(JSON.parse(read(files, '.codex-plugin/plugin.json')), {
    name: 'agentex', version: '1.2.3', description: 'Agentic QA', author: { name: 'M' },
    interface: { displayName: 'AgenTeX' },
  });
});

test('manifest: patching in place keeps every field and adds the new ones', () => {
  const files = tree({ '.claude-plugin/plugin.json': MANIFEST });
  T.TRANSFORMS.manifest(files, { target: '.claude-plugin/plugin.json', fields: { commands: './commands' } });
  const out = JSON.parse(read(files, '.claude-plugin/plugin.json'));
  assert.strictEqual(out.commands, './commands');
  assert.strictEqual(out.license, 'MIT');
  assert.ok(!('$schema' in out));
});

test('pluginRoot: placeholder replaces every occurrence in text files; keep is a no-op', () => {
  const files = tree({ 'skills/a/SKILL.md': 'run `node ${CLAUDE_PLUGIN_ROOT}/x.js` then ${CLAUDE_PLUGIN_ROOT}/y' });
  files.set('img.png', T.makeFile(Buffer.from([0x89, 0, 0x24, 0x7b])));
  T.TRANSFORMS.pluginRoot(files, { mode: 'keep' });
  assert.ok(read(files, 'skills/a/SKILL.md').includes('${CLAUDE_PLUGIN_ROOT}'));
  T.TRANSFORMS.pluginRoot(files, {});
  assert.strictEqual(read(files, 'skills/a/SKILL.md'), 'run `node <agentex-root>/x.js` then <agentex-root>/y');
  assert.strictEqual(files.get('img.png').sha, null, 'binary file untouched (still a fresh file)');
  assert.deepStrictEqual([...files.get('img.png').buf], [0x89, 0, 0x24, 0x7b]);
});

test('pluginRoot: only instruction text (.md by default) is rewritten, never code', () => {
  const files = tree({ 'a.md': '${CLAUDE_PLUGIN_ROOT}/x', 'run.js': 'process.env.X || `${CLAUDE_PLUGIN_ROOT}`' });
  T.TRANSFORMS.pluginRoot(files, {});
  assert.strictEqual(read(files, 'a.md'), '<agentex-root>/x');
  assert.strictEqual(read(files, 'run.js'), 'process.env.X || `${CLAUDE_PLUGIN_ROOT}`');
  T.TRANSFORMS.pluginRoot(files, { paths: ['**/*.js'] });
  assert.ok(read(files, 'run.js').includes('<agentex-root>'));
});

test('pluginRoot: an untouched file keeps its source blob id', () => {
  const files = new Map([['a.md', { mode: '100644', sha: 'abc', buf: Buffer.from('plain') }]]);
  T.TRANSFORMS.pluginRoot(files, {});
  assert.strictEqual(files.get('a.md').sha, 'abc');
});

test('commandsToSkills: a command becomes a user-only skill; a name clash gets -command', () => {
  const files = tree({
    'commands/run-it.md': '---\ndescription: Run it. Usage: /run-it <x>\nargument-hint: "<x>"\n---\nScope: $ARGUMENTS\nIf `$ARGUMENTS` is empty, ask.\n',
    'commands/ask-kb.md': '---\ndescription: "Ask the KB"\n---\nQ: $ARGUMENTS\n',
    'skills/ask-kb/SKILL.md': '---\nname: ask-kb\ndescription: d\n---\n',
  });
  T.TRANSFORMS.commandsToSkills(files);
  assert.ok(![...files.keys()].some((k) => k.startsWith('commands/')), 'commands/ emptied');
  const run = T.parseFrontmatter(read(files, 'skills/run-it/SKILL.md'));
  assert.deepStrictEqual(run.data, { name: 'run-it', description: 'Run it. Usage: /run-it <x>', 'argument-hint': '<x>', 'disable-model-invocation': 'true' });
  assert.strictEqual(run.body, "Scope: (the argument text the user typed after the command's name)\nIf the argument text is empty, ask.\n");
  assert.strictEqual(T.parseFrontmatter(read(files, 'skills/ask-kb-command/SKILL.md')).data.name, 'ask-kb-command');
  assert.ok(files.has('skills/ask-kb/SKILL.md'), 'the original skill is untouched');
});

test('commandsToSkills: policyFile adds the Codex policy; ctx records old→new names', () => {
  const files = tree({ 'commands/go.md': '---\ndescription: Go\n---\nx\n', 'skills/go/SKILL.md': '---\nname: go\ndescription: d\n---\n' });
  const ctx = {};
  T.TRANSFORMS.commandsToSkills(files, { policyFile: true }, ctx);
  assert.strictEqual(read(files, 'skills/go-command/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.ok(!files.has('skills/go/agents/openai.yaml'), 'the real skill gets no policy file');
  assert.deepStrictEqual(ctx.commands, { go: 'go-command' });
});

test('invocations: /<command> mentions become the host syntax; paths, URLs, longer names and CHANGELOG untouched', () => {
  const files = tree({
    'skills/a/SKILL.md': 'Run /init-test, (/ask-kb) or `/ask-kb x`.\n/init-test first.\nNot commands/init-test.md, https://h/init-test or /init-tests.',
    'CHANGELOG.md': 'added /init-test',
    'run.js': '"/init-test"',
  });
  const ctx = { commands: { 'init-test': 'init-test', 'ask-kb': 'ask-kb-command' } };
  T.TRANSFORMS.invocations(files, { prefix: '$agentex:' }, ctx);
  assert.strictEqual(read(files, 'skills/a/SKILL.md'),
    'Run $agentex:init-test, ($agentex:ask-kb-command) or `$agentex:ask-kb-command x`.\n$agentex:init-test first.\n'
    + 'Not commands/init-test.md, https://h/init-test or /init-tests.');
  assert.strictEqual(read(files, 'CHANGELOG.md'), 'added /init-test');
  assert.strictEqual(read(files, 'run.js'), '"/init-test"');
  assert.throws(() => T.TRANSFORMS.invocations(files, {}, ctx), /prefix is required/);
});

test('commandsToSkills: a command with no description fails the build', () => {
  const files = tree({ 'commands/x.md': 'no frontmatter' });
  assert.throws(() => T.TRANSFORMS.commandsToSkills(files), /commands\/x\.md has no description/);
});

test('moveAgents: agent files move under the target folder unchanged', () => {
  const files = tree({ 'agents/qa-executor.md': 'A', 'agents/README': 'not an agent' });
  T.TRANSFORMS.moveAgents(files, { to: 'references/agents' });
  assert.strictEqual(read(files, 'references/agents/qa-executor.md'), 'A');
  assert.ok(!files.has('agents/qa-executor.md'));
  assert.ok(files.has('agents/README'), 'non-.md files are left alone');
});

test('askUser: replaces the tool name with and without backticks; requires a replacement', () => {
  const files = tree({ 'skills/a/SKILL.md': 'one `AskUserQuestion` and one AskUserQuestion.' });
  T.TRANSFORMS.askUser(files, { replacement: 'the `ask_user` tool' });
  assert.strictEqual(read(files, 'skills/a/SKILL.md'), 'one the `ask_user` tool and one the `ask_user` tool.');
  assert.throws(() => T.TRANSFORMS.askUser(files, {}), /replacement is required/);
});

test('preamble: inserted after the frontmatter of targets only, with {root} per depth', () => {
  const files = tree({
    'skills/a/SKILL.md': '---\nname: a\n---\nBody',
    'agents/x.md': '---\nname: x\n---\n\nAgent body',
    'skills/a/references/r.md': 'ref',
  });
  T.TRANSFORMS.preamble(files, { targets: ['skills/*/SKILL.md', 'agents/*.md'], text: '> On {host}: root is `{root}`.' }, CTX);
  assert.strictEqual(read(files, 'skills/a/SKILL.md'), '---\nname: a\n---\n\n> On GitHub Copilot: root is `../..`.\n\nBody');
  assert.strictEqual(read(files, 'agents/x.md'), '---\nname: x\n---\n\n> On GitHub Copilot: root is `..`.\n\nAgent body');
  assert.strictEqual(read(files, 'skills/a/references/r.md'), 'ref');
});

test('applyTransforms runs in order and rejects an unknown transform', () => {
  const files = tree({ 'skills/a/SKILL.md': '---\nname: a\n---\n${CLAUDE_PLUGIN_ROOT}/x' });
  T.applyTransforms(files, [['pluginRoot', {}], ['preamble', { text: 'root {root}' }]], CTX);
  assert.strictEqual(read(files, 'skills/a/SKILL.md'), '---\nname: a\n---\n\nroot ../..\n\n<agentex-root>/x');
  assert.throws(() => T.applyTransforms(files, ['nope'], CTX), /unknown transform: nope/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
