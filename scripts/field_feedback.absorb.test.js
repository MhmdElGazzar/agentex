'use strict';
// Tests for the absorption verbs of scripts/field_feedback.js (field-feedback-loop S-3):
// absorb-candidates, absorb-preview, absorb-apply.
// Run: node scripts/field_feedback.absorb.test.js
// Offline. Plugin trees are fakes (a manifest, two skills, a command, a CHANGELOG in the
// real header format); projects are temp git repos. The CLI is spawned for the contract
// tests, run() is called in-process for seams (the clock, a cross-device rename).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./field_feedback.js');
const L = require('./lib/learnings.js');

const SCRIPT = path.join(__dirname, 'field_feedback.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-abs-'));
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof text === 'string' || Buffer.isBuffer(text) ? text : JSON.stringify(text, null, 2));
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel));
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
const commitAll = (dir, msg = 'c') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
const baseEnv = () => { const e = { ...process.env }; delete e.AGENTEX_CI; return e; };
function cli(dir, args, env, pluginHome) {
  const r = spawnSync(process.execPath, [pluginHome || SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: env || baseEnv() });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, lines: r.stdout.trim() === '' ? 0 : r.stdout.trim().split(/\r?\n/).length };
}
// A byte snapshot of every file under dir (minus .git), for "nothing changed" checks.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

// ---- the fake plugin: version 0.26.0, the real CHANGELOG header format -------------------------
const CHANGELOG = [
  '# Changelog',                                // 1
  '',                                           // 2
  '## [Unreleased]',                            // 3
  '- pending change to task-estimation',        // 4
  '',                                           // 5
  '## [0.26.0] — 2026-10-20',                   // 6
  '### Added',                                  // 7
  '- test-design now attaches steps.',          // 8
  '',                                           // 9
  '## [0.25.0] — 2026-10-01',                   // 10
  '- something about browser stuff',            // 11
  '',                                           // 12
  '## [0.24.0] — 2026-09-01',                   // 13
  '- task-estimation weights table.',           // 14
  '',                                           // 15
].join('\n');
function fakePlugin(version = '0.26.0') {
  const root = tmp();
  write(root, '.claude-plugin/plugin.json', { name: 'agentex', version });
  write(root, 'skills/test-design/SKILL.md', '---\nname: test-design\ndescription: d\n---\n');
  write(root, 'skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: d\n---\n');
  write(root, 'commands/update-agentex.md', 'x\n');
  write(root, 'CHANGELOG.md', CHANGELOG);
  return root;
}
const entry = (id, version, affected, extra = '') => `- [ ] ${id} · 2026-10-0${1 + (id.length % 7)} · workaround · ${affected} · v${version}\n  problem: problem of ${id}\n  workaround: workaround of ${id}\n${extra}`;
const ID = { old: 'PL-20260901T000000Z-aaaa', old2: 'PL-20260902T000000Z-bbbb', cur: 'PL-20261020T000000Z-cccc', newer: 'PL-20261021T000000Z-dddd', done: 'PL-20260801T000000Z-eeee' };
const HEAD = '<!-- agentex:plugin-learnings schemaVersion=1 -->\n# t\n\n';
// A committed git project: three open entries (0.24.0, 0.25.0 and the installed 0.26.0), one newer, one absorbed,
// forks task-estimation (name) and our-design (self-described), an unrelated skill.
function project({ commit = true } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  write(dir, L.FILE_REL, HEAD + entry(ID.old, '0.24.0', 'task-estimation') + entry(ID.old2, '0.25.0', 'test-design') + entry(ID.cur, '0.26.0', 'test-design') + entry(ID.newer, '9.0.0', 'test-design') +
    `- [x] ${ID.done} · 2026-08-01 · workaround · unknown · v0.20.0 · absorbed in v0.24.0\n  problem: done\n  workaround: done\n`);
  write(dir, '.gitignore', '.agentex/scratch/\n');
  write(dir, '.claude/skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: our weights\n---\n# ours\n');
  write(dir, '.claude/skills/task-estimation/refs/table.md', 'weights\n');
  write(dir, '.claude/skills/task-estimation/bin.dat', Buffer.from([0, 1, 2, 255, 254]));
  write(dir, '.claude/skills/our-design/SKILL.md', '---\nname: our-design\ndescription: Overrides test-design for us\n---\n');
  write(dir, '.claude/skills/unrelated/SKILL.md', '---\nname: unrelated\ndescription: Replaces manual steps\n---\n');
  write(dir, 'CLAUDE.md', '# project rules\n');
  if (commit) commitAll(dir);
  return dir;
}
const opts = (plugin, extra = {}) => ({ pluginRoot: plugin, env: {}, now: () => new Date('2026-10-22T10:15:00Z'), ...extra });
async function candidates(dir, plugin) { const r = await run(['absorb-candidates'], opts(plugin, { cwd: dir })); assert.strictEqual(r.code, 0, JSON.stringify(r.out)); return r.out; }
function planFile(dir, plan) { write(dir, '.agentex/scratch/field-feedback/absorb-plan.json', plan); return '.agentex/scratch/field-feedback/absorb-plan.json'; }
async function preview(dir, plugin, plan) { const f = planFile(dir, plan); return run(['absorb-preview', '--plan', f], opts(plugin, { cwd: dir })); }
async function apply(dir, plugin, plan, extra = {}, shaOverride) {
  const f = planFile(dir, plan);
  const sha = shaOverride || require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  return run(['absorb-apply', '--plan', f, '--expect-sha', sha], opts(plugin, { cwd: dir, ...extra }));
}
async function goodPlan(dir, plugin) {
  const c = await candidates(dir, plugin);
  const e = (id) => c.entries.find((x) => x.id === id);
  return { schemaVersion: 1, installed: '0.26.0', mark: [{ id: ID.old, lineSha: e(ID.old).lineSha }, { id: ID.old2, lineSha: e(ID.old2).lineSha }], retire: [{ path: '.claude/skills/task-estimation/', plugin: 'task-estimation' }], review: [{ path: '.claude/skills/our-design/', plugin: 'test-design', why: 'partly covered' }] };
}

(async () => {
  // ---- first test: apply is all-or-nothing on a sha mismatch -----------------------------------
  await test('apply is all-or-nothing on a sha mismatch: exit 2, the learnings file and every fork byte-identical', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = await goodPlan(dir, plugin);
    const before = snapshot(dir);
    const r = await apply(dir, plugin, plan, {}, 'f'.repeat(64));
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.deepStrictEqual([r.out.result, r.out.reason], ['BLOCKED', 'plan-changed']);
    const after = snapshot(dir);
    for (const k of Object.keys(before)) if (!k.includes('absorb-plan')) assert.strictEqual(after[k], before[k], `${k} unchanged`);
    assert.deepStrictEqual(Object.keys(after).filter((k) => !(k in before) && !k.includes('absorb-plan')), [], 'nothing new');
    assert.ok(exists(dir, '.claude/skills/task-estimation/SKILL.md'));
  });

  await test('candidates: open entries OLDER than the installed version only; a current, a newer and an absorbed entry are not listed', async () => {
    const plugin = fakePlugin(); const dir = project();
    const c = await candidates(dir, plugin);
    assert.strictEqual(c.installed, '0.26.0');
    assert.deepStrictEqual(c.entries.map((e) => e.id).sort(), [ID.old, ID.old2].sort());
    const e = c.entries.find((x) => x.id === ID.old);
    assert.deepStrictEqual([e.affected, e.version, e.trigger], ['task-estimation', '0.24.0', 'workaround']);
    assert.strictEqual(e.problem, `problem of ${ID.old}`);
    assert.match(e.lineSha, /^[0-9a-f]{16}$/);
    assert.strictEqual(e.evidence.skillFile, path.join(plugin, 'skills', 'task-estimation', 'SKILL.md'));
    assert.strictEqual(c.entries.find((x) => x.id === ID.old2).evidence.skillFile, path.join(plugin, 'skills', 'test-design', 'SKILL.md'));
  });

  await test('candidates: CHANGELOG ranges (entryVersion, installed] with line numbers; [Unreleased] skipped; names flagged', async () => {
    const plugin = fakePlugin(); const dir = project();
    const c = await candidates(dir, plugin);
    const old = c.entries.find((x) => x.id === ID.old);      // 0.24.0, affects task-estimation
    assert.deepStrictEqual(old.evidence.changelog.map((s) => [s.version, s.fromLine, s.toLine, s.namesAffected]), [
      ['0.26.0', 6, 8, false],
      ['0.25.0', 10, 11, false],
    ]);
    assert.strictEqual(old.evidence.changelog[0].file, path.join(plugin, 'CHANGELOG.md'));
    const mid = c.entries.find((x) => x.id === ID.old2);     // 0.25.0, affects test-design
    assert.deepStrictEqual(mid.evidence.changelog.map((s) => [s.version, s.fromLine, s.toLine, s.namesAffected]), [['0.26.0', 6, 8, true]]);
    const fork = c.forks.find((f) => f.plugin === 'task-estimation');
    assert.deepStrictEqual(fork.evidence.changelog.map((s) => [s.version, s.namesAffected]), [['0.26.0', false], ['0.25.0', false], ['0.24.0', true]], 'a fork covers the whole file');
  });

  await test('candidates: the real CHANGELOG header format parses (em dash, [Unreleased] skipped, top release = the manifest version)', async () => {
    const root = path.join(__dirname, '..');
    const dir = tmp();
    write(dir, L.FILE_REL, HEAD + entry(ID.old, '0.1.0', 'test-design'));
    const r = await run(['absorb-candidates'], { cwd: dir, pluginRoot: root, env: {} });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const sections = r.out.entries[0].evidence.changelog;
    assert.ok(sections.length > 5, `${sections.length} sections`);
    assert.strictEqual(sections[0].version, r.out.installed, 'the newest section is the installed version');
    assert.ok(sections.every((s) => /^\d+\.\d+\.\d+$/.test(s.version)) && sections.every((s) => s.toLine >= s.fromLine));
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
    assert.match(text[sections[0].fromLine - 1], /^## \[\d+\.\d+\.\d+\] — /);
  });

  await test('candidates: forks by name and by self-description; a non-fork is not reported', async () => {
    const plugin = fakePlugin(); const dir = project();
    const c = await candidates(dir, plugin);
    assert.deepStrictEqual(c.forks.map((f) => [f.plugin, f.rule, f.path]).sort(), [
      ['task-estimation', 'name', '.claude/skills/task-estimation/'],
      ['test-design', 'self-described', '.claude/skills/our-design/'],
    ]);
  });

  await test('candidates: every absorb verb is refused under AGENTEX_CI=1 (ci-mode, exit 2); the CLI prints one JSON line', async () => {
    const dir = project();
    for (const verb of ['absorb-candidates', 'absorb-preview', 'absorb-apply']) {
      const r = cli(dir, [verb, '--plan', 'x', '--expect-sha', 'y'], { ...baseEnv(), AGENTEX_CI: '1' });
      assert.strictEqual(r.status, 2, verb);
      assert.strictEqual(r.json.reason, 'ci-mode');
      assert.strictEqual(r.lines, 1);
    }
    const ok = cli(dir, ['absorb-candidates']);
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.strictEqual(ok.lines, 1);
  });

  await test('candidates: blockedBy names a dirty learnings file (modified or untracked) and a tracked fork with edits; clean and non-git are empty; an untracked fork is not blocked', async () => {
    const plugin = fakePlugin();
    const clean = project();
    assert.deepStrictEqual((await candidates(clean, plugin)).blockedBy, []);
    const dirty = project();
    fs.appendFileSync(path.join(dirty, L.FILE_REL), '\nuser note\n');
    assert.deepStrictEqual((await candidates(dirty, plugin)).blockedBy, ['.agentex/plugin-learnings.md']);
    const fresh = project({ commit: false });
    assert.ok((await candidates(fresh, plugin)).blockedBy.includes('.agentex/plugin-learnings.md'), 'uncommitted new file blocks');
    const edited = project();
    fs.appendFileSync(path.join(edited, '.claude/skills/task-estimation/SKILL.md'), 'edit\n');
    assert.deepStrictEqual((await candidates(edited, plugin)).blockedBy, ['.claude/skills/task-estimation/']);
    const untrackedFork = project();
    write(untrackedFork, '.claude/skills/test-design/SKILL.md', '---\nname: test-design\n---\n');
    assert.deepStrictEqual((await candidates(untrackedFork, plugin)).blockedBy, []);
    const plain = project(); fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true });
    fs.appendFileSync(path.join(plain, L.FILE_REL), '\nx\n');
    assert.deepStrictEqual((await candidates(plain, plugin)).blockedBy, []);
  });

  await test('candidates writes nothing and never opens CLAUDE.md for writing', async () => {
    const plugin = fakePlugin(); const dir = project();
    const before = snapshot(dir);
    await candidates(dir, plugin);
    assert.deepStrictEqual(snapshot(dir), before);
  });

  await test('preview: a valid plan renders ONE message with the three groups in fixed order and one question; returns planSha', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = await goodPlan(dir, plugin);
    const r = await preview(dir, plugin, plan);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const m = r.out.message;
    const i1 = m.indexOf('Mark absorbed in v0.26.0'); const i2 = m.indexOf('Retire (moved to `.agentex/scratch/field-feedback/retired-skills/`)'); const i3 = m.indexOf('Review by hand (not changed)');
    assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, m);
    assert.ok(m.includes(ID.old) && m.includes(ID.old2) && m.includes('task-estimation (.claude/skills/task-estimation/)') && m.includes('partly covered'));
    assert.strictEqual((m.match(/yes or no/gi) || []).length, 1);
    assert.strictEqual(r.out.asks, true);
    assert.match(r.out.planSha, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual([r.out.mark, r.out.retire, r.out.review], [2, 1, 1]);
  });

  await test('preview: a plan with review items only is told, not asked (asks false, no yes/no)', async () => {
    const plugin = fakePlugin(); const dir = project();
    const r = await preview(dir, plugin, { schemaVersion: 1, installed: '0.26.0', mark: [], retire: [], review: [{ path: '.claude/skills/our-design/', plugin: 'test-design', why: 'forks only' }] });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.asks, false);
    assert.ok(!/yes or no/i.test(r.out.message));
    assert.ok(r.out.message.includes('Review by hand (not changed)') && !r.out.message.includes('Mark absorbed') && !r.out.message.includes('Retire ('));
  });

  await test('preview rejects, exit 2 and nothing written: an unknown id, an absorbed id, a changed line, a non-fork path, an overlap, a wrong version, a duplicate', async () => {
    const plugin = fakePlugin(); const dir = project();
    const good = await goodPlan(dir, plugin);
    const sha = good.mark[0].lineSha;
    const variants = {
      'unknown id': { ...good, mark: [{ id: 'PL-20200101T000000Z-0000', lineSha: sha }] },
      'absorbed id': { ...good, mark: [{ id: ID.done, lineSha: sha }] },
      'changed line': { ...good, mark: [{ id: ID.old, lineSha: '0'.repeat(16) }] },
      'non-fork path': { ...good, retire: [{ path: '.claude/skills/unrelated/', plugin: 'test-design' }] },
      'path outside': { ...good, retire: [{ path: '../elsewhere/', plugin: 'test-design' }] },
      'wrong plugin': { ...good, retire: [{ path: '.claude/skills/task-estimation/', plugin: 'test-design' }] },
      overlap: { ...good, retire: [{ path: '.claude/skills/task-estimation/', plugin: 'task-estimation' }], review: [{ path: '.claude/skills/task-estimation/', plugin: 'task-estimation', why: 'x' }] },
      'duplicate retire': { ...good, retire: [{ path: '.claude/skills/task-estimation/', plugin: 'task-estimation' }, { path: '.claude/skills/task-estimation', plugin: 'task-estimation' }] },
      'wrong installed': { ...good, installed: '0.99.0' },
      'duplicate mark': { ...good, mark: [good.mark[0], good.mark[0]] },
    };
    const before = snapshot(dir);
    for (const [name, plan] of Object.entries(variants)) {
      const r = await preview(dir, plugin, plan);
      assert.strictEqual(r.code, 2, `${name}: ${JSON.stringify(r.out)}`);
      assert.strictEqual(r.out.reason, 'plan-invalid', name);
      assert.ok(Array.isArray(r.out.errors) && r.out.errors.length >= 1, name);
    }
    for (const bad of ['{ nope', '[]', '{"schemaVersion":2}', '{"schemaVersion":1,"installed":"0.26.0","mark":[{"id":1}]}']) {
      write(dir, '.agentex/scratch/field-feedback/absorb-plan.json', bad);
      const r = await run(['absorb-preview', '--plan', '.agentex/scratch/field-feedback/absorb-plan.json'], opts(plugin, { cwd: dir }));
      assert.deepStrictEqual([r.code, r.out.reason], [2, 'plan-invalid']);
    }
    const after = snapshot(dir);
    for (const k of Object.keys(before)) if (!k.includes('absorb-plan')) assert.strictEqual(after[k], before[k], `${k} unchanged`);
    const missing = await run(['absorb-preview', '--plan', 'no-such-file.json'], opts(plugin, { cwd: dir }));
    assert.strictEqual(missing.code, 2);
  });

  await test('apply: a mark changes exactly the entry line; only listed forks move, losslessly into retired-skills/; CLAUDE.md byte-identical', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = await goodPlan(dir, plugin);
    const beforeFile = read(dir, L.FILE_REL).toString('utf8').split('\n');
    const beforeClaude = read(dir, 'CLAUDE.md');
    const forkBefore = {}; for (const rel of ['SKILL.md', 'refs/table.md', 'bin.dat']) forkBefore[rel] = read(dir, `.claude/skills/task-estimation/${rel}`);
    const reviewBefore = read(dir, '.claude/skills/our-design/SKILL.md');
    const r = await apply(dir, plugin, plan);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual([r.out.result, r.out.marked, r.out.retired], ['OK', 2, 1]);
    // marks
    const afterFile = read(dir, L.FILE_REL).toString('utf8').split('\n');
    assert.strictEqual(afterFile.length, beforeFile.length);
    const diff = beforeFile.map((l, i) => (l === afterFile[i] ? -1 : i)).filter((i) => i >= 0);
    assert.strictEqual(diff.length, 2, 'exactly the two entry lines changed');
    for (const i of diff) {
      assert.ok(beforeFile[i].startsWith('- [ ] ') && afterFile[i] === `${beforeFile[i].replace('- [ ] ', '- [x] ')} · absorbed in v0.26.0`, afterFile[i]);
    }
    const parsed = L.parse(read(dir, L.FILE_REL));
    assert.deepStrictEqual(parsed.entries.map((e) => e.status), ['absorbed', 'absorbed', 'open', 'open', 'absorbed']);
    // forks
    const retired = r.out.results.find((x) => x.kind === 'retire');
    assert.strictEqual(retired.to, '.agentex/scratch/field-feedback/retired-skills/task-estimation-20261022T101500Z');
    assert.ok(!exists(dir, '.claude/skills/task-estimation'), 'the source is gone');
    for (const rel of Object.keys(forkBefore)) assert.ok(read(dir, `${retired.to}/${rel}`).equals(forkBefore[rel]), `${rel} moved intact`);
    assert.ok(read(dir, '.claude/skills/our-design/SKILL.md').equals(reviewBefore), 'a review fork never moves');
    assert.ok(exists(dir, '.claude/skills/unrelated/SKILL.md'));
    assert.ok(read(dir, 'CLAUDE.md').equals(beforeClaude), 'CLAUDE.md byte-identical');
    assert.ok(!exists(dir, '.agentex/plugin-learnings.md.tmp'), 'no temp file left');
  });

  await test('apply: a fork destination is never overwritten (a taken name gets a suffix); the cross-device path is copy-verify-remove', async () => {
    const plugin = fakePlugin(); const dir = project();
    write(dir, '.agentex/scratch/field-feedback/retired-skills/task-estimation-20261022T101500Z/keep.txt', 'previous');
    commitAll(dir);
    const plan = { ...(await goodPlan(dir, plugin)), mark: [] };
    let renames = 0;
    const exdev = (a, b) => { renames++; const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
    const r = await apply(dir, plugin, plan, { rename: exdev });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(renames >= 1);
    const to = r.out.results.find((x) => x.kind === 'retire').to;
    assert.strictEqual(to, '.agentex/scratch/field-feedback/retired-skills/task-estimation-20261022T101500Z-2');
    assert.strictEqual(read(dir, '.agentex/scratch/field-feedback/retired-skills/task-estimation-20261022T101500Z/keep.txt').toString(), 'previous');
    assert.ok(read(dir, `${to}/bin.dat`).equals(Buffer.from([0, 1, 2, 255, 254])));
    assert.ok(!exists(dir, '.claude/skills/task-estimation'));
  });

  await test('apply: all checks run before the first write — one bad item means nothing is applied (a mark is not applied when a retire path is wrong)', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = { ...(await goodPlan(dir, plugin)), retire: [{ path: '.claude/skills/unrelated/', plugin: 'task-estimation' }] };
    const before = snapshot(dir);
    const r = await apply(dir, plugin, plan);
    assert.deepStrictEqual([r.code, r.out.reason], [2, 'plan-invalid']);
    const after = snapshot(dir);
    for (const k of Object.keys(before)) if (!k.includes('absorb-plan')) assert.strictEqual(after[k], before[k]);
  });

  await test('apply: a plan edited after the preview is refused (sha bound)', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = await goodPlan(dir, plugin);
    const f = planFile(dir, plan);
    const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    write(dir, f, { ...plan, retire: [] });
    const before = snapshot(dir);
    const r = await run(['absorb-apply', '--plan', f, '--expect-sha', sha], opts(plugin, { cwd: dir }));
    assert.deepStrictEqual([r.code, r.out.reason], [2, 'plan-changed']);
    assert.deepStrictEqual(snapshot(dir), before);
  });

  await test('apply: blockedBy is enforced — a dirty learnings file or a tracked edited fork stops it (exit 2 blocked), nothing changed', async () => {
    const plugin = fakePlugin();
    const dir = project();
    const plan = await goodPlan(dir, plugin);
    fs.appendFileSync(path.join(dir, L.FILE_REL), '\nuncommitted note\n');
    let before = snapshot(dir);
    let r = await apply(dir, plugin, plan);
    assert.deepStrictEqual([r.code, r.out.reason], [2, 'blocked']);
    assert.deepStrictEqual(r.out.blockedBy, ['.agentex/plugin-learnings.md']);
    for (const [k, v] of Object.entries(before)) if (!k.includes('absorb-plan')) assert.strictEqual(snapshot(dir)[k], v);
    const dir2 = project();
    const plan2 = await goodPlan(dir2, plugin);
    fs.appendFileSync(path.join(dir2, '.claude/skills/task-estimation/SKILL.md'), 'edit\n');
    before = snapshot(dir2);
    r = await apply(dir2, plugin, plan2);
    assert.deepStrictEqual([r.code, r.out.reason, r.out.blockedBy], [2, 'blocked', ['.claude/skills/task-estimation/']]);
    assert.ok(exists(dir2, '.claude/skills/task-estimation/SKILL.md'));
    assert.strictEqual(L.parse(read(dir2, L.FILE_REL)).entries.filter((e) => e.status === 'absorbed').length, 1, 'no mark applied');
  });

  await test('apply: a held lock past the wait is exit 1 lock-busy and nothing changes', async () => {
    const plugin = fakePlugin(); const dir = project();
    const plan = await goodPlan(dir, plugin);
    write(dir, L.LOCK_REL, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'x' }));
    const before = snapshot(dir);
    const r = await apply(dir, plugin, plan, { now: () => new Date(), lockWaitMs: 60, lockRetryMs: 10 });
    assert.deepStrictEqual([r.code, r.out.reason], [1, 'lock-busy']);
    const after = snapshot(dir);
    for (const k of Object.keys(before)) if (!k.includes('absorb-plan') && !k.includes('.locks')) assert.strictEqual(after[k], before[k]);
    assert.ok(exists(dir, '.claude/skills/task-estimation/SKILL.md'));
  });

  await test('apply: CRLF learnings keep their line endings; the CLI contract (one line, exit 0) holds end to end', async () => {
    const plugin = fakePlugin(); const dir = project();
    const crlf = read(dir, L.FILE_REL).toString('utf8').replace(/\n/g, '\r\n');
    write(dir, L.FILE_REL, crlf); commitAll(dir, 'crlf');
    const plan = { ...(await goodPlan(dir, plugin)), retire: [], review: [] };
    const f = planFile(dir, plan);
    // the spawned CLI uses the repo's own manifest (a real version), so the plan's installed must match it
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    write(dir, f, { ...plan, installed: real });
    const sha2 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    const r = cli(dir, ['absorb-apply', '--plan', f, '--expect-sha', sha2]);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines, 1);
    assert.strictEqual(r.json.marked, 2);
    const out = read(dir, L.FILE_REL).toString('utf8');
    assert.ok(!/(^|[^\r])\n/.test(out), 'no bare LF');
    assert.ok(out.includes(`absorbed in v${real}\r\n`));
  });

  await test('structural: the absorb verbs never open CLAUDE.md; no network module', async () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|tls|dgram)['"]\)/.test(src));
    const body = src.slice(src.indexOf('// ---- absorption'));
    assert.ok(!/CLAUDE\.md/.test(body.replace(/\/\/.*$/gm, '')), 'the absorption code never names CLAUDE.md');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
