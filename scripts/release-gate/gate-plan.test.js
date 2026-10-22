'use strict';
// Tests for gate-plan.js — which live release-gate lanes a diff needs (policy Q16).
// The planner is a pure function over a file list; the git side is tested against
// throwaway repos.
// Run: node scripts/release-gate/gate-plan.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const gp = require('./gate-plan.js');

const SCRIPT = path.join(__dirname, 'gate-plan.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const runs = (plan) => Object.keys(plan.lanes).filter((l) => plan.lanes[l].run).sort();

test('the lanes, and setup + wizard are always on', () => {
  assert.deepStrictEqual(gp.LANES, ['setup', 'wizard', 'ui', 'api', 'tracker', 'reporting', 'git']);
  const plan = gp.planLanes(['scripts/secret_scan.js']);
  assert.deepStrictEqual(Object.keys(plan.lanes), gp.LANES, 'every lane is reported, run or not');
  assert.deepStrictEqual(runs(plan), ['git', 'setup', 'wizard']);
  assert.deepStrictEqual([plan.full, plan.docsOnly, plan.unmapped], [false, false, []]);
  assert.deepStrictEqual(plan.lanes.git.because, ['scripts/secret_scan.js']);
  assert.deepStrictEqual(plan.lanes.ui, { run: false, because: [] });
});

test('each lane is reachable from a typical file', () => {
  const cases = {
    'skills/api-integration/scripts/run_api.js': ['api'],
    'skills/task-estimation/SKILL.md': ['tracker'],
    'skills/browser-driver/SKILL.md': ['ui'],
    'skills/extent-report/SKILL.md': ['reporting', 'ui'],          // reporting reads the UI run
    'scripts/wizard/ui.html': [],
    'scripts/lib/precommit_hook.js': ['git'],
  };
  for (const [file, extra] of Object.entries(cases)) {
    const plan = gp.planLanes([file]);
    assert.deepStrictEqual(runs(plan), ['setup', 'wizard', ...extra].sort(), file);
    assert.strictEqual(plan.full, false, file);
  }
});

test('the execution core and shared libraries force the full gate', () => {
  for (const file of [
    'skills/browser-testing/scripts/ci_gate.js',
    'agents/qa-executor.md',
    'skills/test-execution/scripts/merge_run.js',
    'skills/extent-report/scripts/make_html_report.js',
    'scripts/lib/tracker/adapters/ado.js',
    'scripts/lib/project_config.js',
  ]) {
    const plan = gp.planLanes(['docs/README.md', file]);
    assert.strictEqual(plan.full, true, file);
    assert.deepStrictEqual(runs(plan), [...gp.LANES].sort(), file);
    for (const lane of gp.LANES) assert.ok(plan.lanes[lane].because.includes(file), `${file} named under ${lane}`);
    assert.deepStrictEqual(plan.unmapped, []);
  }
});

test('docs, evals and tests only → docsOnly, every lane off (the gate is skipped)', () => {
  const plan = gp.planLanes(['docs/configuration.md', 'README.md', 'CHANGELOG.md', 'evals/x/prompt.md',
    'skills/api-integration/scripts/run_api.test.js', 'skills/browser-testing/scripts/ci_gate.test.js',
    'skills/task-estimation/scripts/golden/case1.json']);
  assert.deepStrictEqual([plan.docsOnly, plan.full, runs(plan), plan.unmapped], [true, false, [], []]);
});

test('every path no host ships (build_host COMMON_EXCLUDES) is inert — maintainer tooling never forces a lane', () => {
  const { COMMON_EXCLUDES } = require('../hosts/build_host.js');
  const sample = (p) => (p.includes('*') ? p.replace('**/*', 'x/y').replace(/\*\*?/g, 'x') : p) + (/\.(js|json|md)$/.test(p) ? '' : '/x.js');
  const files = COMMON_EXCLUDES.filter((p) => p !== '.gitattributes').map(sample);
  const out = gp.planLanes(files);
  assert.deepStrictEqual([out.unmapped, out.full], [[], false], JSON.stringify(files));
});

test('maintainer dev tooling (scripts/dev) is inert — never shipped, so it gates nothing', () => {
  const plan = gp.planLanes(['scripts/dev/affected.js']);
  assert.deepStrictEqual([plan.docsOnly, plan.full, runs(plan), plan.unmapped], [true, false, [], []]);
});

test('field-feedback: the consumer scripts, their libraries and the skill map to setup; the maintainer harvest is inert', () => {
  const plan = gp.planLanes(['scripts/field_feedback.js', 'scripts/lib/learnings.js', 'scripts/lib/plugin_inventory.js', 'scripts/lib/feedback_sanitize.js',
    'skills/field-feedback/SKILL.md', 'skills/field-feedback/references/capture.md']);
  assert.deepStrictEqual([plan.docsOnly, plan.full, plan.unmapped, runs(plan)], [false, false, [], ['setup', 'wizard']]);
  for (const f of ['scripts/field_feedback.js', 'scripts/lib/learnings.js', 'scripts/lib/plugin_inventory.js', 'scripts/lib/feedback_sanitize.js', 'skills/field-feedback/SKILL.md']) {
    assert.ok(plan.lanes.setup.because.includes(f), `${f} named under setup`);
  }
  const harvest = gp.planLanes(['scripts/harvest/harvest.js', 'scripts/harvest/README.md']);
  assert.deepStrictEqual([harvest.docsOnly, harvest.full, runs(harvest), harvest.unmapped], [true, false, [], []]);
});

test('an empty diff is docsOnly too — nothing to gate', () => {
  const plan = gp.planLanes([]);
  assert.deepStrictEqual([plan.docsOnly, plan.full, runs(plan)], [true, false, []]);
});

test('a skill prompt is never a doc: SKILL.md and references map to their lane', () => {
  const plan = gp.planLanes(['skills/test-design/references/test-case-mechanics.md']);
  assert.strictEqual(plan.docsOnly, false);
  assert.deepStrictEqual(runs(plan), ['setup', 'tracker', 'wizard']);
});

test('the plugin-root tracker CLI, its helpers and the suite check map to the tracker lane; its goldens are inert', () => {
  for (const file of ['scripts/tracker.js', 'scripts/qa-records.js', 'scripts/release-gate/suite-check.js',
    'references/question-format.md']) {
    const plan = gp.planLanes([file]);
    assert.deepStrictEqual(runs(plan), ['setup', 'tracker', 'wizard'], file);
    assert.deepStrictEqual([plan.full, plan.unmapped], [false, []], file);
  }
  const golden = gp.planLanes(['scripts/golden/tracker/ado/A01.json', 'scripts/golden/tracker/jira/J01.json']);
  assert.strictEqual(golden.docsOnly, true, 'test fixtures only → no lane');
});

test('an unmapped non-doc file forces full and is listed (fail safe)', () => {
  const plan = gp.planLanes(['docs/a.md', 'skills/brand-new/SKILL.md', 'scripts/secret_scan.js']);
  assert.strictEqual(plan.full, true);
  assert.strictEqual(plan.docsOnly, false);
  assert.deepStrictEqual(plan.unmapped, ['skills/brand-new/SKILL.md']);
  assert.deepStrictEqual(runs(plan), [...gp.LANES].sort());
  assert.deepStrictEqual(plan.lanes.git.because, ['scripts/secret_scan.js'], 'mapped files still name their lane');
});

test('one file can feed several lanes; each lane lists its files once, sorted', () => {
  const plan = gp.planLanes(['scripts/lib/scaffold.js', 'commands/init-test.md', 'scripts/lib/scaffold.js']);
  assert.deepStrictEqual(plan.lanes.setup.because, ['commands/init-test.md', 'scripts/lib/scaffold.js']);
  assert.deepStrictEqual(plan.lanes.git.because, ['commands/init-test.md', 'scripts/lib/scaffold.js']);
});

test('glob: ** crosses folders, * stays inside one, the rest is literal', () => {
  const m = (g, p) => gp.globToRegExp(g).test(p);
  assert.ok(m('skills/x/**', 'skills/x/a/b.js') && !m('skills/x/**', 'skills/xy/a.js'));
  assert.ok(m('**/*.test.js', 'a.test.js') && m('**/*.test.js', 'a/b/c.test.js') && !m('**/*.test.js', 'a/test.js'));
  assert.ok(m('skills/*/scripts/golden/**', 'skills/t/scripts/golden/c.json') && !m('skills/*/scripts/golden/**', 'skills/t/u/scripts/golden/c.json'));
  assert.ok(m('README.md', 'README.md') && !m('README.md', 'skills/x/README.md') && !m('a.b', 'axb'));
});

test('the table only names paths that exist in this repo (no stale or misspelt globs)', () => {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  const globs = [...gp.INERT, ...gp.FULL, ...gp.LANE_MAP.map(([g]) => g)];
  const dead = globs.filter((g) => !tracked.some((f) => gp.globToRegExp(g).test(f)));
  assert.deepStrictEqual(dead, []);
  for (const [g, lanes] of gp.LANE_MAP) for (const l of lanes) assert.ok(gp.LANES.includes(l), `${g}: unknown lane ${l}`);
});

// ── CLI against a throwaway repo ────────────────────────────────────────────
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
function commit(dir, files, msg) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (body === null) { fs.rmSync(p); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-plan-'));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'README.md': 'x\n', 'scripts/secret_scan.js': '1\n', 'skills/api-integration/SKILL.md': '1\n' }, 'feat: start');
  return dir;
}
function cli(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, lines, out: lines.length ? JSON.parse(lines[0]) : null, stderr: r.stderr };
}

test('CLI: default base is the latest "chore: bump to" commit (subject only), head is HEAD', () => {
  const dir = repo();
  commit(dir, { 'docs/a.md': '1\n' }, 'chore: bump to 1.0.0');
  const bump = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { 'scripts/secret_scan.js': '2\n' }, 'fix: x\n\nchore: bump to 9.9.9 in the body is not a bump');
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = cli(dir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.lines.length, 1, 'exactly one stdout line');
  assert.strictEqual(r.out.base, bump.slice(0, r.out.base.length));
  assert.strictEqual(r.out.head, head.slice(0, r.out.head.length));
  assert.deepStrictEqual([r.out.full, r.out.docsOnly, runs(r.out)], [false, false, ['git', 'setup', 'wizard']]);
});

test('CLI: --base <ref>; a rename names both the old and the new path', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'mv', 'skills/api-integration/SKILL.md', 'skills/elsewhere.md');
  git(dir, 'commit', '-q', '-m', 'refactor: move');
  const r = cli(dir, ['--base', base]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.out.lanes.api.because, ['skills/api-integration/SKILL.md']);
  assert.deepStrictEqual(r.out.unmapped, ['skills/elsewhere.md']);
  assert.strictEqual(r.out.full, true);
});

test('CLI: docs-only diff → docsOnly:true', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { 'docs/guide.md': 'g\n', 'README.md': 'y\n' }, 'docs: guide');
  const r = cli(dir, ['--base', base]);
  assert.deepStrictEqual([r.code, r.out.docsOnly, r.out.full], [0, true, false]);
});

test('CLI: no bump commit, unknown ref, bad flag, not a repo → exit 2 with {error}', () => {
  const dir = repo();
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-plan-nogit-'));
  for (const [cwd, args] of [[dir, []], [dir, ['--base', 'no-such-ref']], [dir, ['--base']], [dir, ['--nope']], [notRepo, ['--base', 'HEAD']]]) {
    const r = cli(cwd, args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.code} ${r.stderr}`);
    assert.strictEqual(r.lines.length, 1);
    assert.ok(r.out.error, args.join(' '));
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
