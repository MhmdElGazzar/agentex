'use strict';
// Tests for scripts/dev/changelog.js — fragment check and release assembly over a throwaway
// folder. Run: node scripts/dev/changelog.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'changelog.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const INTRO = '# Changelog\n\nAll notable changes are documented here.\n\n';
const OLD = '## [0.1.0] — 2026-01-01\n### Added\n- Old thing.\n';
const UNRELEASED = '## [Unreleased]\n### Added\n- From unreleased.\n### Fixed\n- Unreleased fix.\n\n';

function project({ changelog = `${INTRO}${UNRELEASED}${OLD}`, fragments = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-changelog-'));
  made.push(dir);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  fs.mkdirSync(path.join(dir, 'changelog.d'));
  fs.writeFileSync(path.join(dir, 'changelog.d', '.gitkeep'), '');
  for (const [name, body] of Object.entries(fragments)) fs.writeFileSync(path.join(dir, 'changelog.d', name), body);
  return dir;
}
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8' });
  const line = r.stdout.trim();
  return { code: r.status, out: r.stdout, err: r.stderr, json: line ? JSON.parse(line) : null };
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const fragmentFiles = (dir) => fs.readdirSync(path.join(dir, 'changelog.d')).filter((f) => f.endsWith('.md')).sort();

const GOOD_A = '### Added\n- **Alpha.** First line\n  continued here.\n  - nested\n\n### Fixed\n- Alpha fix.\n';
const GOOD_B = '### Changed\n- Beta change.\n\n### Added\n- Beta add.\n';

// ── --check ───────────────────────────────────────────────────────────────────
test('--check passes valid fragments and lists them', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A, 'b.md': GOOD_B } });
  const { code, json } = run(dir, '--check');
  assert.strictEqual(code, 0);
  assert.strictEqual(json.ok, true);
  assert.deepStrictEqual(json.files, ['changelog.d/a.md', 'changelog.d/b.md']);
});

test('--check with no fragments passes', () => {
  const { code, json } = run(project(), '--check');
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(json.files, []);
});

test('--check: a heading outside Added / Changed / Fixed exits 1 naming the file', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A, 'bad.md': '### Removed\n- gone\n' } });
  const { code, json, err } = run(dir, '--check');
  assert.strictEqual(code, 1);
  assert.strictEqual(json.ok, false);
  assert.ok(json.errors.some((e) => e.file === 'changelog.d/bad.md' && /Removed/.test(e.error)));
  assert.ok(!json.errors.some((e) => e.file === 'changelog.d/a.md'));
  assert.match(err, /changelog\.d\/bad\.md/);
});

test('--check: a heading with no bullets under it exits 1', () => {
  const dir = project({ fragments: { 'empty.md': '### Added\n\n### Fixed\n- ok\n' } });
  const { code, json } = run(dir, '--check');
  assert.strictEqual(code, 1);
  assert.ok(json.errors.some((e) => e.file === 'changelog.d/empty.md' && /Added/.test(e.error)));
});

test('--check: text before the first heading, or a column-0 line that is not a bullet, exits 1', () => {
  let dir = project({ fragments: { 'pre.md': 'Intro text\n### Added\n- x\n' } });
  assert.strictEqual(run(dir, '--check').code, 1);
  dir = project({ fragments: { 'loose.md': '### Added\n- x\nloose text\n' } });
  assert.strictEqual(run(dir, '--check').code, 1);
});

test('--check: a file with no heading at all exits 1', () => {
  const dir = project({ fragments: { 'blank.md': '\n' } });
  assert.strictEqual(run(dir, '--check').code, 1);
});

test('--check: a ## heading inside a fragment exits 1 (it would break the release section)', () => {
  const dir = project({ fragments: { 'h2.md': '### Added\n- x\n## [9.9.9]\n' } });
  assert.strictEqual(run(dir, '--check').code, 1);
});

test('no mode, two modes, or an unknown flag exits 2', () => {
  const dir = project();
  assert.strictEqual(run(dir).code, 2);
  assert.strictEqual(run(dir, '--check', '--assemble', '1.0.0').code, 2);
  assert.strictEqual(run(dir, '--bogus').code, 2);
});

// ── --assemble ────────────────────────────────────────────────────────────────
test('--assemble merges Unreleased and every fragment in Added, Changed, Fixed order, fragments by filename', () => {
  const dir = project({ fragments: { 'b-beta.md': GOOD_B, 'a-alpha.md': GOOD_A } });
  const { code, json } = run(dir, '--assemble', '1.2.3', '--date', '2026-11-01');
  assert.strictEqual(code, 0);
  assert.strictEqual(json.version, '1.2.3');
  const expected = `${INTRO}## [1.2.3] — 2026-11-01
### Added
- From unreleased.
- **Alpha.** First line
  continued here.
  - nested
- Beta add.
### Changed
- Beta change.
### Fixed
- Unreleased fix.
- Alpha fix.

${OLD}`;
  assert.strictEqual(read(dir, 'CHANGELOG.md'), expected);
  assert.ok(!read(dir, 'CHANGELOG.md').includes('[Unreleased]'));
});

test('--assemble deletes the fragment files and keeps .gitkeep', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A, 'b.md': GOOD_B } });
  run(dir, '--assemble', '1.2.3', '--date', '2026-11-01');
  assert.deepStrictEqual(fragmentFiles(dir), []);
  assert.ok(fs.existsSync(path.join(dir, 'changelog.d', '.gitkeep')));
});

test('--assemble works without an [Unreleased] section and inserts under the intro', () => {
  const dir = project({ changelog: `${INTRO}${OLD}`, fragments: { 'a.md': GOOD_A } });
  const { code } = run(dir, '--assemble', '2.0.0', '--date', '2026-11-02');
  assert.strictEqual(code, 0);
  const text = read(dir, 'CHANGELOG.md');
  assert.ok(text.startsWith(`${INTRO}## [2.0.0] — 2026-11-02\n### Added\n`));
  assert.ok(text.endsWith(OLD));
});

test('--assemble defaults the date to today and writes the em dash', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A } });
  const { json } = run(dir, '--assemble', '1.2.3');
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.strictEqual(json.date, ymd);
  assert.ok(read(dir, 'CHANGELOG.md').includes(`## [1.2.3] — ${ymd}\n`));
});

test('--assemble keeps an unknown Unreleased subsection after Fixed instead of dropping it', () => {
  const dir = project({
    changelog: `${INTRO}## [Unreleased]\n### Removed\n- Gone.\n### Added\n- A.\n\n${OLD}`,
    fragments: { 'a.md': '### Fixed\n- F.\n' },
  });
  run(dir, '--assemble', '1.2.3', '--date', '2026-11-01');
  const text = read(dir, 'CHANGELOG.md');
  assert.ok(text.indexOf('### Added') < text.indexOf('### Fixed') && text.indexOf('### Fixed') < text.indexOf('### Removed'));
  assert.ok(text.includes('- Gone.'));
});

test('--assemble --dry-run prints the section and writes nothing', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A } });
  const before = read(dir, 'CHANGELOG.md');
  const { code, json } = run(dir, '--assemble', '1.2.3', '--date', '2026-11-01', '--dry-run');
  assert.strictEqual(code, 0);
  assert.ok(json.section.startsWith('## [1.2.3] — 2026-11-01\n### Added\n- From unreleased.'));
  assert.strictEqual(read(dir, 'CHANGELOG.md'), before);
  assert.deepStrictEqual(fragmentFiles(dir), ['a.md']);
});

test('--assemble with an invalid fragment exits 1 naming it and writes nothing', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A, 'bad.md': '### Nope\n- x\n' } });
  const before = read(dir, 'CHANGELOG.md');
  const { code, json } = run(dir, '--assemble', '1.2.3');
  assert.strictEqual(code, 1);
  assert.ok(json.errors.some((e) => e.file === 'changelog.d/bad.md'));
  assert.strictEqual(read(dir, 'CHANGELOG.md'), before);
  assert.deepStrictEqual(fragmentFiles(dir), ['a.md', 'bad.md']);
});

// ── a version that already has a section ──────────────────────────────────────
test('a version that already has a section exits 2 and writes nothing', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A } });
  const before = read(dir, 'CHANGELOG.md');
  const { code, json } = run(dir, '--assemble', '0.1.0');
  assert.strictEqual(code, 2);
  assert.strictEqual(json.ok, false);
  assert.match(json.error, /0\.1\.0/);
  assert.strictEqual(read(dir, 'CHANGELOG.md'), before);
  assert.deepStrictEqual(fragmentFiles(dir), ['a.md']);
});

test('a version already present also refuses --dry-run', () => {
  assert.strictEqual(run(project({ fragments: { 'a.md': GOOD_A } }), '--assemble', '0.1.0', '--dry-run').code, 2);
});

test('a malformed version or date exits 2', () => {
  const dir = project({ fragments: { 'a.md': GOOD_A } });
  assert.strictEqual(run(dir, '--assemble', 'v1').code, 2);
  assert.strictEqual(run(dir, '--assemble', '1.2.3', '--date', '01/02/2026').code, 2);
  assert.strictEqual(run(dir, '--assemble').code, 2);
});

test('nothing to assemble (no fragments, no Unreleased content) exits 2', () => {
  const dir = project({ changelog: `${INTRO}${OLD}` });
  assert.strictEqual(run(dir, '--assemble', '1.2.3').code, 2);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
