'use strict';
// Tests for scripts/lint_plugin.js — the plugin's structural lint, against throwaway fixture
// trees (one pass + one fail per check), plus one run on this repo whose findings must be
// exactly the known list below, so a new real finding shows up as a failure.
// Run: node scripts/lint_plugin.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { matcher } = require('./hosts/transforms.js');
const { COMMON_EXCLUDES } = require('./hosts/build_host.js');

const CLI = path.join(__dirname, 'lint_plugin.js');
const REPO = path.resolve(__dirname, '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Secret-shaped values are assembled here at runtime so this file never carries one.
const TOKENS = {
  aws: 'AK' + 'IA' + 'QWERTYUIOPASDFGH',
  github: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  atlassian: 'ATA' + 'TT3' + 'xFfGF0abcdefghijklmnopqrstuvwxyz0123456789',
  privateKey: '-----' + 'BEGIN RSA ' + 'PRIVATE KEY' + '-----',
};
const DENY_TERM = 'zorbquux';   // a made-up word: the denylist mechanism, not a real name

const BASE = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.2.3' }, null, 2) + '\n',
  'README.md': '# P\n\n[![Version](https://img.shields.io/badge/version-1.2.3-blue.svg)](./CHANGELOG.md)\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- next\n\n## [1.2.3] — 2026-01-01\n\n- first\n',
  '.env.example': '# secrets\nFOO_TOKEN=\n# Maintainer keys, names only: BAR_URL\n',
  'skills/s/SKILL.md': [
    '---',
    'name: s',
    'description: >',
    '  Does s. Triggers on steps like "s: go" — folded, so the colon is fine.',
    '---',
    '',
    'Run `node ${CLAUDE_PLUGIN_ROOT}/skills/s/scripts/run.js`; read `references/r.md` and',
    '`scripts/run.js`. Consumer files: `config/project.json`, `environments/<env>.json`,',
    '`executions/run/`, `test/suite1/`. Placeholders and globs: `references/<name>.md`,',
    '`references/*.md`. A [link](references/r.md#top), a [site](https://example.com/a/b).',
    '',
  ].join('\n'),
  'skills/s/scripts/run.js': "const t = process.env.FOO_TOKEN; const h = process.env.HOME;\nconst u = process.env['BAR_URL'];\n",
  'skills/s/scripts/run.test.js': "process.env.NOT_IN_EXAMPLE_BUT_A_TEST;\n",
  'skills/s/references/r.md': '# R\n\nBack to [the skill](../SKILL.md); see `../scripts/run.js`.\n',
  'commands/c.md': '---\ndescription: "Runs c. Usage: /c <arg>"\n---\n\nUse the `s` skill.\n',
  'agents/a.md': '---\nname: a\ndescription: Executes a thing and returns a report.\ntools: Bash, Read\n---\n\nAgent body.\n',
  'scripts/tool.js': 'module.exports = 1;\n',
  'scripts/tool.test.js': '\n',
  'scripts/dev/helper.js': 'module.exports = 2;\n',
};

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// A fixture tree: BASE with `changes` applied (null deletes a file). opts.git: a git repo with
// everything committed except opts.untracked.
function tree(changes = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-lint-'));
  made.push(dir);
  const files = { ...BASE, ...changes };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (opts.git) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    for (const rel of opts.untracked || []) git(dir, 'rm', '-q', '--cached', rel);
    git(dir, 'commit', '-q', '-m', 'base');
  }
  return dir;
}
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...(dir ? ['--root', dir] : []), ...args], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, out: r.stdout, err: r.stderr, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null };
}
const of = (list, check) => list.filter((f) => f.check === check);

// ── contract ──────────────────────────────────────────────────────────────────
test('a clean tree: exit 0, one JSON line, no findings, every check reported', () => {
  const r = run(tree());
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(r.json.errors, []);
  assert.deepStrictEqual(r.json.warnings, []);
  assert.deepStrictEqual(Object.keys(r.json.checks).sort(),
    ['changelog', 'denylist', 'env', 'frontmatter', 'paths', 'secrets', 'tests', 'version']);
  assert.match(r.err, /0 errors?, 0 warnings?/);
});

test('--json keeps stderr quiet; the stdout line is the same', () => {
  const dir = tree();
  const r = run(dir, '--json');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.deepStrictEqual(r.json, run(dir).json);
});

test('usage errors, a missing root and a non-plugin root exit 2 with ok:false', () => {
  for (const r of [run(null, '--bogus'), run(null, '--root'), run(path.join(os.tmpdir(), 'agentex-lint-nope-' + process.pid)),
    run(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-lint-empty-')))]) {
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error);
  }
});

test('the scanner is maintainer tooling: no host ships it', () => {
  assert.ok(matcher(COMMON_EXCLUDES)('scripts/lint_plugin.js'));
});

// ── 1. frontmatter ──────────────────────────────────────────────────────────
test('frontmatter: an unquoted ": " in a plain scalar is an error naming file, key and line', () => {
  const r = run(tree({ 'skills/s/SKILL.md': '---\nname: s\ndescription: Does s. Usage: /s <arg>\n---\nbody\n' }));
  assert.strictEqual(r.code, 1);
  const [f, ...rest] = of(r.json.errors, 'frontmatter');
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(f.file, 'skills/s/SKILL.md');
  assert.strictEqual(f.line, 3);
  assert.match(f.message, /description/);
});

test('frontmatter: a " #" in a plain scalar (silent truncation) is an error too', () => {
  const r = run(tree({ 'agents/a.md': '---\nname: a\ndescription: Runs step #1 then step #2\n---\n' }));
  assert.strictEqual(of(r.json.errors, 'frontmatter').length, 1);
});

test('frontmatter: missing block, missing required keys, a stray line, an unclosed quote', () => {
  const r = run(tree({
    'skills/s/SKILL.md': '# no frontmatter\n',
    'commands/c.md': '---\nargument-hint: x\n---\n',
    'agents/a.md': '---\nname: a\ndescription: "unclosed\n---\n',
    'skills/t/SKILL.md': '---\nname: t\ndescription: ok\nthis line is not yaml\n---\n',
  }));
  const files = of(r.json.errors, 'frontmatter').map((f) => f.file).sort();
  assert.deepStrictEqual(files, ['agents/a.md', 'commands/c.md', 'skills/s/SKILL.md', 'skills/t/SKILL.md']);
});

test('frontmatter: quoted values and block scalars with ": " pass', () => {
  const r = run(tree({ 'agents/a.md': "---\nname: a\ndescription: 'Usage: a'\ntools: Bash\n---\n" }));
  assert.deepStrictEqual(of(r.json.errors, 'frontmatter'), []);
});

// ── 2. referenced paths ─────────────────────────────────────────────────────
test('paths: a missing scripts/ path and a broken link are errors naming the path', () => {
  const r = run(tree({
    'skills/s/references/r.md': '# R\n\nSee `scripts/missing.js` and [x](./gone.md).\n',
  }));
  assert.strictEqual(r.code, 1);
  const found = of(r.json.errors, 'paths');
  assert.deepStrictEqual(found.map((f) => [f.file, f.line]), [['skills/s/references/r.md', 3], ['skills/s/references/r.md', 3]]);
  assert.match(found[0].message, /scripts\/missing\.js/);
  assert.match(found[1].message, /gone\.md/);
});

test('paths: a missing ${CLAUDE_PLUGIN_ROOT} path in a command is an error; the root references/ tree is scanned', () => {
  const r = run(tree({
    'commands/c.md': '---\ndescription: Runs c.\n---\n\nRun `${CLAUDE_PLUGIN_ROOT}/skills/s/scripts/nope.js`.\n',
    'references/shared/x.md': 'See `skills/s/scripts/missing.js`.\n',
  }));
  assert.deepStrictEqual(of(r.json.errors, 'paths').map((f) => f.file).sort(), ['commands/c.md', 'references/shared/x.md']);
});

test('paths: "the t skill\'s `references/t.md`" counts when some skill has it; a fenced bare path is not checked', () => {
  const r = run(tree({
    'skills/t/SKILL.md': '---\nname: t\ndescription: T.\n---\n',
    'skills/t/references/t.md': '# T\n',
    'agents/a.md': BASE['agents/a.md'] + "Read the t skill's `references/t.md`.\n\n```bash\nnode scripts/not-ours.js\n```\n",
  }));
  assert.deepStrictEqual(of(r.json.errors, 'paths'), []);
});

// ── 3. version──────────────────────────────────────────────────────────────
test('version: README badge drift is an error; agreement passes (clean tree above)', () => {
  const r = run(tree({ 'README.md': '[![Version](https://img.shields.io/badge/version-0.9.0-blue.svg)](x)\n' }));
  assert.strictEqual(r.code, 1);
  const [f] = of(r.json.errors, 'version');
  assert.strictEqual(f.file, 'README.md');
  assert.match(f.message, /0\.9\.0.*1\.2\.3|1\.2\.3.*0\.9\.0/);
});

test('version: a README without a badge is an error', () => {
  const r = run(tree({ 'README.md': '# P\n' }));
  assert.strictEqual(of(r.json.errors, 'version').length, 1);
});

test('version: a marketplace file is compared when present, skipped when absent', () => {
  const market = (v) => JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: './', version: v }] });
  assert.strictEqual(of(run(tree({ '.claude-plugin/marketplace.json': market('1.0.0') })).json.errors, 'version').length, 1);
  assert.deepStrictEqual(of(run(tree({ '.claude-plugin/marketplace.json': market('1.2.3') })).json.errors, 'version'), []);
});

// ── 4. .env.example ─────────────────────────────────────────────────────────
test('env: a process.env read with no .env.example key is an error naming the variable and line', () => {
  const r = run(tree({ 'scripts/tool.js': 'module.exports = 1;\nconst { SOME_NEW_VAR, PATH } = process.env;\n' }));
  assert.strictEqual(r.code, 1);
  const found = of(r.json.errors, 'env');
  assert.deepStrictEqual(found.map((f) => [f.file, f.line]), [['scripts/tool.js', 2]]);
  assert.match(found[0].message, /SOME_NEW_VAR/);
});

test('env: runtime-provided variables, comment-documented names and test files are not findings', () => {
  const r = run(tree({ 'skills/s/scripts/run.js': 'process.env.CI; process.env.PATH; process.env.CLAUDE_PLUGIN_ROOT; process.env.BAR_URL;\n' }));
  assert.deepStrictEqual(of(r.json.errors, 'env'), []);
});

// ── 5. secrets + denylist ───────────────────────────────────────────────────
test('secrets: each token shape in a tracked file is an error; values are never echoed', () => {
  const body = Object.values(TOKENS).map((t, i) => `line ${i}: ${t}`).join('\n') + '\n';
  const r = run(tree({ 'docs/leak.md': body, 'docs/untracked.md': body }, { git: true, untracked: ['docs/untracked.md'] }));
  assert.strictEqual(r.code, 1);
  const found = of(r.json.errors, 'secrets');
  assert.deepStrictEqual(found.map((f) => [f.file, f.line]), [['docs/leak.md', 1], ['docs/leak.md', 2], ['docs/leak.md', 3], ['docs/leak.md', 4]]);
  for (const t of Object.values(TOKENS)) assert.ok(!r.out.includes(t) && !r.err.includes(t), 'a token value was printed');
});

test('secrets: a fixture that builds the token at runtime is not a finding', () => {
  const r = run(tree({ 'scripts/tool.test.js': "const t = 'AK' + 'IA' + 'X'.repeat(16);\n" }));
  assert.deepStrictEqual(of(r.json.errors, 'secrets'), []);
});

test('denylist: absent → nothing; present → each hit is an error without echoing the term', () => {
  const changes = { 'docs/notes.md': `Built for ${DENY_TERM[0].toUpperCase() + DENY_TERM.slice(1)} Ltd.\n` };
  assert.deepStrictEqual(of(run(tree(changes)).json.errors, 'denylist'), []);
  const r = run(tree({ ...changes, '.agentex-lint-denylist': `# one term per line\n\n${DENY_TERM}\n` }));
  assert.strictEqual(r.code, 1);
  const found = of(r.json.errors, 'denylist');
  assert.deepStrictEqual(found.map((f) => [f.file, f.line]), [['docs/notes.md', 1]]);
  assert.ok(!r.out.toLowerCase().includes(DENY_TERM) && !r.err.toLowerCase().includes(DENY_TERM), 'the term was printed');
});

// ── 6. CHANGELOG (warning) ──────────────────────────────────────────────────
test('changelog: a top released version different from plugin.json is a warning, exit 0', () => {
  const r = run(tree({ 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [1.2.2] — 2026-01-01\n' }));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.json.errors, []);
  const [w] = of(r.json.warnings, 'changelog');
  assert.strictEqual(w.file, 'CHANGELOG.md');
  assert.strictEqual(w.line, 5);
  assert.strictEqual(r.json.ok, true);
});

// ── 7. sibling tests (warning) ──────────────────────────────────────────────
test('tests: a script with no sibling .test.js is a warning; scripts/dev and tests are exempt', () => {
  const r = run(tree({ 'skills/s/scripts/lonely.js': '\n', 'scripts/dev/also_lonely.js': '\n', 'scripts/x.estimation.test.js': '\n',
    'scripts/x.js': '\n', 'scripts/fixtures/f.js': '\n', 'scripts/conformance/a.fixture.js': '\n' }));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(of(r.json.warnings, 'tests').map((w) => w.file), ['skills/s/scripts/lonely.js']);
});

// ── this repo ───────────────────────────────────────────────────────────────
// Every finding the scanner reports on this repo today. A new finding (or a fixed one) fails
// this test on purpose: fix the finding, or update the list in the same change.
const KNOWN = {
  errors: [],
  // scripts with no test of their own name today (most are exercised through a caller's test)
  warnings: [
    'tests scripts/init.js',
    'tests scripts/lib/env_key_map.js',
    'tests scripts/lib/tracker/errors.js',
    'tests scripts/lib/tracker/ops/ado.js',
    'tests scripts/lib/tracker/ops/index.js',
    'tests scripts/lib/tracker/ops/jira.js',
    'tests scripts/migrations/01-rename-integrations-folder.js',
    'tests scripts/migrations/02-absorb-agentex-config.js',
    'tests scripts/migrations/03-env-split.js',
    'tests scripts/migrations/04-catalog-db-connection.js',
    'tests scripts/migrations/05-gitignore-secrets.js',
    'tests scripts/migrations/06-claude-md-bullet.js',
    'tests scripts/migrations/07-fill-gaps.js',
    'tests scripts/migrations/08-spec-drift-scan.js',
    'tests scripts/migrations/09-figma-config.js',
    'tests scripts/migrations/10-phantom-sample-env.js',
    'tests scripts/migrations/11-user-field-schema.js',
    'tests scripts/migrations/12-qa-records-and-workflow.js',
    'tests scripts/precommit_hook.js',
    'tests skills/task-estimation/scripts/estimation/defaults.js',
    'tests skills/task-estimation/scripts/strategies/ado.js',
    'tests skills/task-estimation/scripts/strategies/index.js',
    'tests skills/task-estimation/scripts/strategies/jira.js',
    'tests skills/test-execution/scripts/merge_run.js',
  ],
};
test('this repo: exactly the known findings', () => {
  const r = run(REPO, '--json');
  assert.ok(r.code === 0 || r.code === 1, `exit ${r.code}: ${r.out}`);
  const key = (f) => `${f.check} ${f.file}`;
  assert.deepStrictEqual({ errors: r.json.errors.map(key), warnings: r.json.warnings.map(key) }, KNOWN);
  assert.strictEqual(r.code, KNOWN.errors.length ? 1 : 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
