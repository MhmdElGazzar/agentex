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

test('maintainer dev tooling (scripts/dev) is inert — never shipped, so it gates nothing', () => {
  const plan = gp.planLanes(['scripts/dev/affected.js']);
  assert.deepStrictEqual([plan.docsOnly, plan.full, runs(plan), plan.unmapped], [true, false, [], []]);
});

test('changelog fragments (changelog.d) are inert — never shipped, so they gate nothing', () => {
  const plan = gp.planLanes(['changelog.d/some-feature.md', 'changelog.d/.gitkeep']);
  assert.deepStrictEqual([plan.docsOnly, plan.full, runs(plan), plan.unmapped], [true, false, [], []]);
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


// ── Section impact: hunks of a sectioned file map to the lanes of their section ──
const QA = 'agents/qa-executor.md';
// A small stand-in for qa-executor.md: a parameter block, then all-caps headers at column 0.
function qaText(over = {}) {
  const body = {
    param: ['---', 'name: qa-executor', '---', 'SESSION: the run id', 'ENVIRONMENT: qc'],
    spec: ['TEST SPECIFICATION:', 'spec 1', 'spec 2'],
    browser: ['BROWSER STEPS (when the target is a URL):', 'b1', 'b2', 'b3'],
    evidence: ['WHERE TO SAVE EVIDENCE (every run):', 'e1', 'e2'],
    integration: ['INTEGRATION STEPS (api):', 'i1', 'i2'],
    ui: ['UI CHECKS (when asked):', 'u1', 'u2'],
    rules: ['EXECUTION RULES', 'r1', 'r2'],
    fail: ['WHEN A SCENARIO FAILS: DEFECT OR FLAKE', 'f1', 'f2'],
    ...over,
  };
  return Object.values(body).flat().join('\n') + '\n';
}
const sub = (text, from, to) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
// A repo with QA at `before`, then a head commit with QA = after(before) and extra files.
function sectionRepo(after, extra = {}, before = qaText()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-plan-sec-'));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'README.md': 'x\n', [QA]: before }, 'chore: bump to 1.0.0');
  const base = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { [QA]: typeof after === 'function' ? after(before) : after, ...extra }, 'feat: change');
  return { dir, base, r: cli(dir, ['--base', base]) };
}
const FULL_RUN = [...gp.LANES].sort();

test('section: a hunk only under BROWSER STEPS → ui (+ setup, wizard), named file#SECTION', () => {
  const { r } = sectionRepo((t) => sub(t, 'b2\n', 'b2\nb2 new\n'));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([r.out.full, runs(r.out)], [false, ['setup', 'ui', 'wizard']]);
  assert.deepStrictEqual(r.out.lanes.ui.because, [`${QA}#BROWSER STEPS`]);
  assert.deepStrictEqual(r.out.unmapped, []);
  assert.ok(r.stderr.includes(`${QA}#BROWSER STEPS`), r.stderr);
});

test('section: UI CHECKS + WHEN A SCENARIO FAILS (the 0.28.1 shape) → ui and reporting; api, tracker, git off', () => {
  const { r } = sectionRepo((t) => sub(sub(t, 'u2\n', 'u2 changed\n'), 'f2\n', 'f2\nf3\n'));
  assert.deepStrictEqual([r.out.full, runs(r.out)], [false, ['reporting', 'setup', 'ui', 'wizard']]);
  assert.deepStrictEqual(r.out.lanes.ui.because, [`${QA}#UI CHECKS`, `${QA}#WHEN A SCENARIO FAILS`]);
  assert.deepStrictEqual(r.out.lanes.reporting.because, [`${QA}#WHEN A SCENARIO FAILS`]);
  for (const l of ['api', 'tracker', 'git']) assert.strictEqual(r.out.lanes[l].run, false, l);
});

test('section: a hunk under INTEGRATION STEPS → api, ui off', () => {
  const { r } = sectionRepo((t) => sub(t, 'i1\n', 'i1 changed\n'));
  assert.deepStrictEqual([r.out.full, runs(r.out)], [false, ['api', 'setup', 'wizard']]);
  assert.deepStrictEqual(r.out.lanes.api.because, [`${QA}#INTEGRATION STEPS`]);
});

test('section: EXECUTION RULES, the parameter block, or a hunk spanning into an unmapped section → full, plain path', () => {
  const cases = {
    rules: (t) => sub(t, 'r1\n', 'r1 changed\n'),
    param: (t) => sub(t, 'ENVIRONMENT: qc', 'ENVIRONMENT: prod'),
    frontmatter: (t) => sub(t, 'name: qa-executor', 'name: qa'),
    span: (t) => sub(t, 'b3\nWHERE TO SAVE EVIDENCE (every run):\ne1\ne2\nINTEGRATION STEPS (api):\ni1\ni2\nUI CHECKS (when asked):\nu1\nu2\nEXECUTION RULES\nr1',
      'b3 x\nx\nx\nx\nx\nx\nx\nx\nx\nx\nr1 x'),
    one_of_two: (t) => sub(sub(t, 'b1\n', 'b1 c\n'), 'r2\n', 'r2 c\n'),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const { r } = sectionRepo(edit);
    assert.deepStrictEqual([name, r.out.full, runs(r.out)], [name, true, FULL_RUN]);
    assert.ok(r.out.lanes.api.because.includes(QA), name);
    assert.ok(!r.out.lanes.api.because.some((b) => b.includes('#')), name);
  }
});

test('section: a pure deletion is located with the base text; two hunks in two mapped sections take both', () => {
  // Delete the INTEGRATION STEPS body (not its header): at HEAD those lines' position sits under the
  // preceding section, so only the base text names the section the deleted lines were in.
  const del = sectionRepo((t) => sub(t, 'i1\ni2\n', ''));
  assert.deepStrictEqual([del.r.out.full, runs(del.r.out)], [false, ['api', 'setup', 'wizard']]);
  assert.deepStrictEqual(del.r.out.lanes.api.because, [`${QA}#INTEGRATION STEPS`]);
  const two = sectionRepo((t) => sub(sub(t, 'b2\n', 'b2 c\n'), 'e1\n', 'e1 c\n'));
  assert.deepStrictEqual([two.r.out.full, runs(two.r.out)], [false, ['reporting', 'setup', 'ui', 'wizard']]);
  assert.deepStrictEqual(two.r.out.lanes.ui.because, [`${QA}#BROWSER STEPS`, `${QA}#WHERE TO SAVE EVIDENCE`]);
  assert.deepStrictEqual(two.r.out.lanes.reporting.because, [`${QA}#WHERE TO SAVE EVIDENCE`], 'reporting is named only by the sections that map to it');
});

test('section: a CRLF file keeps the fail-safe (a bare header like EXECUTION RULES still ends the section)', () => {
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  const rules = sectionRepo((t) => sub(t, 'r1\r\n', 'r1 changed\r\n'), {}, crlf(qaText()));
  assert.deepStrictEqual([rules.r.out.full, runs(rules.r.out)], [true, FULL_RUN]);
  const ok = sectionRepo((t) => sub(t, 'b2\r\n', 'b2 c\r\n'), {}, crlf(qaText()));
  assert.deepStrictEqual([ok.r.out.full, runs(ok.r.out)], [false, ['setup', 'ui', 'wizard']]);
});

test('section: a hunk that adds, deletes or edits a header line → whole-file fallback (full, plain path)', () => {
  const cases = {
    delete_header: (t) => sub(t, 'INTEGRATION STEPS (api):\n', ''),
    add_header: (t) => sub(t, 'b2\n', 'b2\nSTRAY SECTION:\n'),
    edit_header: (t) => sub(t, 'UI CHECKS (when asked):', 'UI CHECKS (when needed):'),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const { r } = sectionRepo(edit);
    assert.deepStrictEqual([name, r.out.full, runs(r.out)], [name, true, FULL_RUN]);
    assert.ok(r.out.lanes.api.because.includes(QA) && !r.out.lanes.api.because.some((b) => b.includes('#')), name);
  }
});

test('section: an added file, a deleted file, or an unreadable file → whole-file fallback (full)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-plan-sec-'));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'README.md': 'x\n' }, 'chore: bump to 1.0.0');
  const base = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { [QA]: qaText() }, 'feat: add');
  const added = cli(dir, ['--base', base]);
  assert.deepStrictEqual([added.code, added.out.full, runs(added.out)], [0, true, FULL_RUN]);
  const mid = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { [QA]: null }, 'feat: delete');
  const deleted = cli(dir, ['--base', mid]);
  assert.deepStrictEqual([deleted.code, deleted.out.full, runs(deleted.out)], [0, true, FULL_RUN]);
  // a git read failure: the pure helper treats a missing text side as "cannot place the hunks"
  assert.strictEqual(gp.sectionImpact(QA, null, qaText(), '@@ -1,0 +2,1 @@\n'), null);
  assert.strictEqual(gp.sectionImpact(QA, qaText(), null, '@@ -1,1 +1,1 @@\n'), null);
  assert.strictEqual(gp.sectionImpact(QA, qaText(), qaText(), ''), null, 'no hunk to place → fallback');
});

test('section: other changed files map as before next to a section-mapped one', () => {
  const { r } = sectionRepo((t) => sub(t, 'b2\n', 'b2 c\n'), { 'skills/browser-driver/SKILL.md': 'x\n', 'scripts/secret_scan.js': 'y\n' });
  assert.deepStrictEqual([r.out.full, runs(r.out)], [false, ['git', 'setup', 'ui', 'wizard']]);
  assert.deepStrictEqual(r.out.lanes.ui.because, [`${QA}#BROWSER STEPS`, 'skills/browser-driver/SKILL.md']);
  assert.deepStrictEqual(r.out.lanes.git.because, ['scripts/secret_scan.js']);
});

test('planLanes(changed) with one argument is unchanged: the whole file is FULL', () => {
  const plan = gp.planLanes([QA]);
  assert.deepStrictEqual([plan.full, runs(plan)], [true, FULL_RUN]);
  assert.deepStrictEqual(plan.lanes.ui.because, [QA]);
  assert.deepStrictEqual(gp.planLanes([QA], {}), plan, 'an empty second argument is the same');
  const scoped = gp.planLanes([QA], { [QA]: { lanes: ['ui'], sections: ['BROWSER STEPS'] } });
  assert.deepStrictEqual([scoped.full, runs(scoped)], [false, ['setup', 'ui', 'wizard']]);
});

test('section: the real 0.28.1 delivery (3b70362..81fd375) no longer asks for the full gate on qa-executor', () => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const have = (rev) => spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: repoRoot }).status === 0;
  if (!have('3b70362') || !have('81fd375')) { console.log('    (skipped: shallow clone, delivery commits absent)'); return; }
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-plan-wt-'));
  fs.rmSync(wt, { recursive: true });
  git(repoRoot, 'worktree', 'add', '--detach', wt, '81fd375');
  try {
    const r = cli(wt, ['--base', '3b70362']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.out.full, false, JSON.stringify(r.out.lanes.ui));
    assert.ok(r.out.lanes.ui.because.includes(`${QA}#BROWSER STEPS`));
    assert.ok(r.out.lanes.ui.because.includes(`${QA}#UI CHECKS`));
    assert.ok(r.out.lanes.reporting.because.includes(`${QA}#WHEN A SCENARIO FAILS`));
    assert.ok(r.out.lanes.ui.because.some((b) => b.startsWith('skills/browser-driver/')));
    for (const l of ['api', 'tracker', 'git']) assert.strictEqual(r.out.lanes[l].run, false, l);
  } finally { git(repoRoot, 'worktree', 'remove', '--force', wt); }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
