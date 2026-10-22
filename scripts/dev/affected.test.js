'use strict';
// Tests for scripts/dev/affected.js — impact analysis over a throwaway git repo, plus the
// real repo's evals/coverage.json staying in step with evals/. Run: node scripts/dev/affected.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { matcher } = require('../hosts/transforms.js');

const CLI = path.join(__dirname, 'affected.js');
const REPO = path.resolve(__dirname, '..', '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SKILL = (description, body) => `---\nname: s\ndescription: ${description}\n---\n\n${body}\n`;
const FIXTURE = {
  'scripts/lib/a.js': 'module.exports = 1;\n',
  'scripts/lib/a.test.js': "process.exit(require('./a.js') === 1 ? 0 : 3);\n",
  'scripts/b.js': "require('./lib/a.js');\n",
  'scripts/b.test.js': "const path = require('node:path');\nconst CLI = path.join(__dirname, 'b.js');\n",
  'scripts/c.test.js': "const path = require('node:path');\nconst ROOT = path.resolve(__dirname, '..');\nconst T = path.join(ROOT, 'templates', 'x.json');\n",
  'scripts/d.test.js': "const path = require('node:path');\nconst read = (name) => path.join(__dirname, 'fixtures', name);\n",
  'scripts/fixtures/one.txt': 'one\n',
  'scripts/data/table.json': '{}\n',
  'templates/x.json': '{}\n',
  'skills/s/SKILL.md': SKILL('Does s.', 'Body.'),
  'skills/s/references/r.md': 'ref\n',
  'skills/s/scripts/run.js': "require('../../../scripts/lib/a.js');\n",
  'skills/s/scripts/other.js': 'module.exports = 0;\n',
  'skills/s/scripts/other.test.js': '\n',
  'agents/lonely.md': 'agent\n',
  'docs/x.md': 'doc\n',
  'evals/trigger-s/prompt.md': 'p\n',
  'evals/disc-s/prompt.md': 'p\n',
  'evals/disc-t/prompt.md': 'p\n',
  'evals/disc-u/prompt.md': 'p\n',
  'evals/coverage.json': JSON.stringify({ cases: { 'trigger-s': [], 'disc-s': ['skills/s', 'skills/s/scripts/run.js'], 'disc-t': ['templates'], 'disc-u': ['skills/s/scripts'] } }),
};

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
// A fixture repo on `main`, checked out on a feature branch; removed when the run ends.
const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-affected-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(FIXTURE)) write(dir, rel, content);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  return dir;
}
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: args.includes('--json') && r.stdout ? JSON.parse(r.stdout) : null };
}
const tests = (j) => j.tests.selected.map((s) => s.test).sort();
const evals = (j) => j.evals.selected.map((s) => s.case).sort();

// ── script tests: the dependency graph ────────────────────────────────────────
test('a committed lib change selects its own test and the test that spawns its caller', () => {
  const dir = repo();
  write(dir, 'scripts/lib/a.js', 'module.exports = 1; // changed\n');
  git(dir, 'commit', '-qam', 'change a');
  const { code, json } = run(dir, '--json');
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(json.changed, ['scripts/lib/a.js']);
  assert.deepStrictEqual(tests(json), ['scripts/b.test.js', 'scripts/lib/a.test.js']);
  assert.deepStrictEqual(json.tests.fallback, []);
});

test('a change high in the graph does not select tests below it', () => {
  const dir = repo();
  write(dir, 'scripts/b.js', "require('./lib/a.js'); // changed\n");
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(tests(json), ['scripts/b.test.js']);
});

test('a folder constant is a base, not a dependency on everything under it', () => {
  const dir = repo();
  write(dir, 'templates/x.json', '{"changed":true}\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(tests(json), ['scripts/c.test.js']);
});

test('a path with a dynamic tail depends on the whole folder before it', () => {
  const dir = repo();
  write(dir, 'scripts/fixtures/two.txt', 'two\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(tests(json), ['scripts/d.test.js']);
});

test('an untracked new test is selected', () => {
  const dir = repo();
  write(dir, 'scripts/new.test.js', '\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(tests(json), ['scripts/new.test.js']);
});

test('a changed data file no test reaches selects every script test, and says why', () => {
  const dir = repo();
  write(dir, 'scripts/data/table.json', '{"changed":true}\n');
  const { json, out } = { ...run(dir, '--json'), out: run(dir).out };
  assert.deepStrictEqual(json.tests.fallback, ['scripts/data/table.json']);
  assert.strictEqual(json.tests.selected.length, json.tests.total);
  assert.match(out, /no test reaches these changed files/);
});

test('docs outside the impact roots select nothing', () => {
  const dir = repo();
  write(dir, 'docs/x.md', 'doc changed\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual([tests(json), evals(json)], [[], []]);
  assert.deepStrictEqual(json.noImpact, ['docs/x.md']);
});

// ── evals ─────────────────────────────────────────────────────────────────────
test('a .js change selects the evals covering any file that requires it', () => {
  const dir = repo();
  write(dir, 'scripts/lib/a.js', 'module.exports = 1; // changed\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(evals(json), ['disc-s']);
});

test('a folder pattern never matches a changed script', () => {
  const dir = repo();
  write(dir, 'skills/s/scripts/other.js', 'module.exports = 1;\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(evals(json), []);
});

test('a folder pattern never matches a script through a dependent either', () => {
  const dir = repo();
  write(dir, 'scripts/lib/a.js', 'module.exports = 1; // changed\n');
  const { json } = run(dir, '--json');
  // skills/s/scripts/run.js requires a.js and sits under disc-u's folder pattern: no match.
  assert.ok(!evals(json).includes('disc-u'));
  // disc-s names run.js itself, so that dependent still selects it.
  assert.deepStrictEqual(evals(json), ['disc-s']);
});

test('a pattern naming a file still matches that file when it changes', () => {
  const dir = repo();
  write(dir, 'skills/s/scripts/run.js', "require('../../../scripts/lib/a.js'); // changed\n");
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(evals(json), ['disc-s']);
});

test('a folder pattern still matches markdown and prompt files, and a changed *.test.js', () => {
  let dir = repo();
  write(dir, 'skills/s/references/r.md', 'ref changed\n');
  assert.deepStrictEqual(evals(run(dir, '--json').json), ['disc-s']);
  dir = repo();
  write(dir, 'skills/s/scripts/other.test.js', '// changed\n');
  assert.deepStrictEqual(evals(run(dir, '--json').json), ['disc-s', 'disc-u']);
});

test('a SKILL.md body change selects covering evals only', () => {
  const dir = repo();
  write(dir, 'skills/s/SKILL.md', SKILL('Does s.', 'Body, reworded.'));
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(evals(json), ['disc-s']);
  assert.deepStrictEqual(json.evals.descriptionChanged, []);
});

test('a SKILL.md description change also selects every trigger-*/negative-* case', () => {
  const dir = repo();
  write(dir, 'skills/s/SKILL.md', SKILL('Does s, and more.', 'Body.'));
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(evals(json), ['disc-s', 'trigger-s']);
  assert.deepStrictEqual(json.evals.descriptionChanged, ['skills/s/SKILL.md']);
});

test('--files compares descriptions against the base too', () => {
  const dir = repo();
  const { json } = run(dir, '--json', '--files', 'skills/s/SKILL.md');
  assert.deepStrictEqual(evals(json), ['disc-s']);
});

test('a change inside an eval case selects that case', () => {
  const dir = repo();
  write(dir, 'evals/disc-t/prompt.md', 'p changed\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual([tests(json), evals(json)], [[], ['disc-t']]);
});

test('a prompt file no eval covers is reported, not escalated', () => {
  const dir = repo();
  write(dir, 'agents/lonely.md', 'agent changed\n');
  const { json } = run(dir, '--json');
  assert.deepStrictEqual(json.uncoveredByEvals, ['agents/lonely.md']);
  assert.deepStrictEqual([json.tests.fallback, evals(json)], [[], []]);
});

// ── --all, --run, errors ──────────────────────────────────────────────────────
test('--all selects every test and every case', () => {
  const dir = repo();
  const { json } = run(dir, '--json', '--all');
  assert.strictEqual(json.tests.selected.length, 5);
  assert.deepStrictEqual(evals(json), ['disc-s', 'disc-t', 'disc-u', 'trigger-s']);
});

test('--run runs only the selected tests and exits 1 when one fails', () => {
  const dir = repo();
  write(dir, 'scripts/lib/a.js', 'module.exports = 2;\n');
  const { code, json } = run(dir, '--json', '--run');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(json.results, [{ test: 'scripts/b.test.js', exit: 0 }, { test: 'scripts/lib/a.test.js', exit: 3 }]);
});

test('--run exits 0 when every selected test passes', () => {
  const dir = repo();
  write(dir, 'scripts/b.js', '// changed\n');
  assert.strictEqual(run(dir, '--run').code, 0);
});

test('an unknown base ref exits 2 with the git error', () => {
  const { code, err } = run(repo(), '--base', 'no-such-branch');
  assert.strictEqual(code, 2);
  assert.match(err, /no-such-branch/);
});

test('an unknown argument exits 2', () => {
  assert.strictEqual(run(repo(), '--bogus').code, 2);
});

// ── the real repo ─────────────────────────────────────────────────────────────
test('evals/coverage.json has exactly one entry per eval case', () => {
  const caseDirs = fs.readdirSync(path.join(REPO, 'evals'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const cases = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'evals', 'coverage.json'), 'utf8')).cases).sort();
  assert.deepStrictEqual(cases, caseDirs);
});

test('every evals/coverage.json pattern matches a tracked file', () => {
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const { cases } = JSON.parse(fs.readFileSync(path.join(REPO, 'evals', 'coverage.json'), 'utf8'));
  const dead = Object.entries(cases).flatMap(([k, pats]) => pats.filter((p) => !tracked.some(matcher([p]))).map((p) => `${k}: ${p}`));
  assert.deepStrictEqual(dead, []);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
