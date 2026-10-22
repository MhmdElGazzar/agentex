'use strict';
// Unit tests for the stray-files check (scripts/lib/strays.js): the lister and classifier,
// the report-only engine lines, the plan digest — and (below the report tests) the
// consented mover. Every fixture is a throwaway git repository.
// Run: node scripts/lib/strays.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const strays = require('./strays.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack}`); }
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
}
function addFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
}
// A git repo: `tracked` files committed, then `untracked` files added on disk.
function repo({ tracked = {}, untracked = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-strays-'));
  git(dir, 'init', '-q');
  addFiles(dir, { '.gitignore': '.env\n.agentex/scratch/\n.agentex/cache/\n.playwright-cli/\n', ...tracked });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture', '--allow-empty');
  addFiles(dir, untracked);
  return dir;
}
const list = (dir) => strays.listStrays(dir, { pluginRoot: PLUGIN_ROOT });
const paths = (r, cls) => r.candidates.filter((c) => !cls || c.class === cls).map((c) => c.path).sort();
const report = (dir, flags = []) => strays.engineLines(dir, { pluginRoot: PLUGIN_ROOT, flagArgs: flags, stampCurrent: true });

// Full-tree snapshot (path → sha256), .git included as raw bytes of its index.
function snapshot(dir) {
  const map = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) map[rel] = `link:${fs.readlinkSync(full)}`;
      else if (e.isDirectory()) { if (rel !== '.git/objects') walk(full); }
      else map[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  })(dir);
  return map;
}

// The acceptance fixture: agent litter at the root and in temp folders under .agentex/.
const AC_TRACKED = {
  'probe-login.mjs': 'console.log(1)\n',
  'explore-grid.mjs': 'x\n',
  'ado_items.json': '{"value":[]}\n',
  '.tmp-abc': 'x\n',
  'README.md': '# readme\n',
};
const AC_UNTRACKED = {
  'probe-otp.mjs': 'x\n',
  'grid-out.txt': 'out\n',
  '.scratch_1': 'x\n',
  '.agentex/.tmp/a.json': '{}\n',
  '.agentex/tmp/b.txt': 'b\n',
};

// ── the lister ─────────────────────────────────────────────────────────────
test('AC fixture: root probes, explores, *-out.txt, a root JSON dump, .tmp-*, .scratch_*, .agentex temp folders — all litter, tracked or not', () => {
  const dir = repo({ tracked: AC_TRACKED, untracked: AC_UNTRACKED });
  const r = list(dir);
  assert.deepStrictEqual(paths(r, 'litter'), ['.agentex/.tmp/a.json', '.agentex/tmp/b.txt', '.scratch_1', '.tmp-abc',
    'ado_items.json', 'explore-grid.mjs', 'grid-out.txt', 'probe-login.mjs', 'probe-otp.mjs']);
  assert.deepStrictEqual(paths(r, 'unplaced'), []);
  const tracked = r.candidates.filter((c) => c.tracked).map((c) => c.path).sort();
  assert.deepStrictEqual(tracked, ['.tmp-abc', 'ado_items.json', 'explore-grid.mjs', 'probe-login.mjs']);
});

test('protected subtrees and files are never listed, even with litter-named files in them', () => {
  const files = {
    'test/probe-x.mjs': 'x', 'test/suite1/tmp-a.json': 'x', 'config/probe.json': '{}', 'environments/tmp-qc.json': '{}',
    'integration/probe_api.json': '{}', '.claude/probe-x.mjs': 'x', '.claude/tmp/x.json': '{}', 'executions/probe-out.txt': 'x',
    'knowledge/probe-notes.md': 'x', 'node_modules/probe-x/index.js': 'x', '.env.local': 'K=v', '.env.qc': 'K=v',
  };
  const dir = repo({ tracked: files, untracked: { '.env': 'SECRET=x\n', '.playwright-cli/page-1.yml': 'x' } });
  fs.writeFileSync(path.join(dir, '.git', 'probe-x.mjs'), 'x');
  assert.deepStrictEqual(list(dir).candidates, []);
});

test('plugin-defined paths are never listed; a non-configured file in a qaRecords folder is unplaced', () => {
  const dir = repo({
    tracked: {
      'config/project.json': { qaRecords: { envIssues: 'notes/env.md' } },
      'notes/env.md': '# env\n', 'notes/decisions.md': '# settled\n',
      'qa-watchlist/awaiting-answers.md': '# q\n', 'qa-watchlist/decisions.md': '# settled\n',
      '.agentex/version.json': '{}', '.agentex/test-template.md': '#', 'CLAUDE.md': '# me\n',
      'agentex.config.json': '{}', 'integrations/x_api.json': '{}',
    },
    untracked: {
      '.agentex/cache/tracker-fields-ado.json': '{}', '.agentex/scratch/probe-x.mjs': 'x',
      'notes/env.md.lock': '1', 'qa-watchlist/awaiting-answers.md.tmp': 'x', 'config/estimation.json': '{}',
    },
  });
  const r = list(dir);
  assert.deepStrictEqual(paths(r, 'litter'), []);
  assert.deepStrictEqual(paths(r, 'unplaced'), ['notes/decisions.md', 'qa-watchlist/decisions.md']);
});

test('paths the project ignores are never listed (untracked and tracked-but-ignored)', () => {
  const dir = repo({ tracked: { 'archive/probe-old.mjs': 'x', 'probe-kept.mjs': 'x' } });
  fs.appendFileSync(path.join(dir, '.gitignore'), 'archive/\nprobe-kept.mjs\nmy-dumps/\n');
  addFiles(dir, { 'my-dumps/x-out.txt': 'x' });
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  assert.deepStrictEqual(list(dir).candidates, []);
});

test('the user-owned root allowlist and the user\'s own folders are not reported; litter in a user folder is', () => {
  const dir = repo({
    tracked: { 'README.md': '#', 'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}', 'tsconfig.base.json': '{}',
      'playwright.config.ts': 'x', 'LICENSE': 'x', '.editorconfig': 'x', 'azure-pipelines.yml': 'x', 'docs/notes.md': '# notes',
      'scripts/helper.js': 'x' },
    untracked: { 'docs/probe-x.mjs': 'x', 'docs/scratch/a.txt': 'x' },
  });
  const r = list(dir);
  assert.deepStrictEqual(paths(r, 'litter'), ['docs/probe-x.mjs', 'docs/scratch/a.txt']);
  assert.deepStrictEqual(paths(r, 'unplaced'), []);
});

test('root files with no clear destination, and undefined .agentex/ files, are listed with no proposal', () => {
  const dir = repo({ tracked: { 'notes.md': '# n', 'notes.pdf': 'x', '.agentex/notes.md': '# n' }, untracked: { 'run.sh': 'x' } });
  const r = list(dir);
  assert.deepStrictEqual(paths(r, 'unplaced'), ['.agentex/notes.md', 'notes.md', 'notes.pdf']);
  assert.deepStrictEqual(paths(r, 'litter'), ['run.sh'], 'a root agent script is litter');
});

test('OS metadata is never listed; symlinks are listed as never moved and never followed; legacy agentex.config.json is not listed', () => {
  const dir = repo({ tracked: { 'agentex.config.json': '{}' }, untracked: { '.DS_Store': 'x', 'docs/Thumbs.db': 'x', 'real/probe-target.mjs': 'x' } });
  fs.symlinkSync('real', path.join(dir, 'linked-dir'));
  fs.symlinkSync('real/probe-target.mjs', path.join(dir, 'probe-link.mjs'));
  const r = list(dir);
  assert.deepStrictEqual(paths(r, 'litter'), ['real/probe-target.mjs'], 'the target is listed once, by its own path');
  assert.deepStrictEqual(paths(r, 'symlink'), ['linked-dir', 'probe-link.mjs']);
});

// ── the report (no flag): paths only, zero writes ───────────────────────────
test('report: none → one line', () => {
  const dir = repo({ tracked: { 'README.md': '#', 'CLAUDE.md': '#' } });
  assert.deepStrictEqual(report(dir), ['[stray] none — every file is where the layout puts it']);
});

test('report: grouped counts, every path, (tracked) marks, the unplaced list, one plan line with the digest', () => {
  const dir = repo({ tracked: { ...AC_TRACKED, 'notes.md': '# n' }, untracked: AC_UNTRACKED });
  const lines = report(dir);
  const r = list(dir);
  const d = strays.planDigest(paths(r, 'litter'));
  assert.match(lines[0], /^\[stray\] 10 files outside the project layout \(paths only; nothing was moved\)$/);
  assert.ok(lines.includes('[stray] litter → .agentex/scratch/strays/<this run>/ (same relative paths):'));
  const counts = lines.find((l) => /^\[stray\]   \S/.test(l));
  assert.match(counts, /probe-\* ×2/);
  assert.match(counts, /temp folders ×2 \(2 files\)/);
  assert.match(counts, /root data dumps ×1/);
  for (const p of paths(r, 'litter')) assert.ok(lines.some((l) => l.startsWith(`[stray]     ${p}`)), p);
  assert.ok(lines.includes('[stray]     probe-login.mjs (tracked)'));
  assert.ok(lines.includes('[stray] no destination proposed (listed only):'));
  assert.ok(lines.includes('[stray]     notes.md (tracked)'));
  assert.strictEqual(lines[lines.length - 1],
    `[stray] plan ${d} — ask the user once; only on an explicit yes, re-run with --move-strays=${d}`);
  assert.ok(lines.some((l) => /4 tracked/.test(l)), 'the relay is told tracked moves leave a removal to commit');
});

test('report-only: the working tree, .git/index and every file are byte-identical afterwards', () => {
  const dir = repo({ tracked: AC_TRACKED, untracked: AC_UNTRACKED });
  const before = snapshot(dir);
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
  report(dir);
  assert.deepStrictEqual(snapshot(dir), before);
  assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=all'), status);
});

test('report: paths only — no file content ever reaches the output', () => {
  const SENTINEL = 'SENTINEL_STRAY_CONTENT_4k2q';
  const dir = repo({ untracked: { 'ado_dump.json': `{"token":"${SENTINEL}"}`, 'notes.md': SENTINEL, 'probe-x.mjs': SENTINEL } });
  assert.ok(!report(dir).join('\n').includes(SENTINEL));
});

test('report: a custom qaRecords block that does not validate falls back to the defaults with one note', () => {
  const dir = repo({ tracked: { 'config/project.json': { qaRecords: { envIssues: '/abs/x.md' } }, 'qa-watchlist/decisions.md': '#' } });
  const lines = report(dir);
  assert.strictEqual(lines.filter((l) => l.startsWith('[stray] note ')).length, 1);
  assert.ok(lines.includes('[stray]     qa-watchlist/decisions.md (tracked)'));
});

test('report: MAX_LISTED caps the printed paths, never the counts or the digest', () => {
  const many = {};
  for (let i = 0; i < 7; i++) many[`probe-${i}.mjs`] = 'x';
  const dir = repo({ untracked: many });
  const lines = strays.engineLines(dir, { pluginRoot: PLUGIN_ROOT, flagArgs: [], stampCurrent: true, maxListed: 3 });
  assert.match(lines[0], /7 files/);
  assert.strictEqual(lines.filter((l) => /^\[stray\]     probe-/.test(l)).length, 3);
  assert.ok(lines.some((l) => /… and 4 more/.test(l)));
  assert.match(lines[lines.length - 1], new RegExp(strays.planDigest(Object.keys(many))));
});

test('planDigest: stable under listing order; changes when a litter file is added', () => {
  const a = strays.planDigest(['b.mjs', 'a.mjs', 'c/d.txt']);
  assert.strictEqual(strays.planDigest(['c/d.txt', 'a.mjs', 'b.mjs']), a);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notStrictEqual(strays.planDigest(['b.mjs', 'a.mjs', 'c/d.txt', 'e.mjs']), a);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
