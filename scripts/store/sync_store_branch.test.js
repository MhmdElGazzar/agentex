'use strict';
// Tests for sync_store_branch.js — the store branch the Claude plugin directory follows.
// Run: node scripts/store/sync_store_branch.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildStoreCommit, FILE_LIMIT } = require('./sync_store_branch.js');

const SCRIPT = path.join(__dirname, 'sync_store_branch.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}
function write(dir, rel, content = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function treeFiles(cwd, ref) {
  return git(cwd, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort();
}

// A repo shaped like the plugin: runtime files plus every dev-only path the store drops.
function pluginRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, '.claude-plugin/plugin.json', '{"name":"agentex"}\n');
  write(dir, 'README.md');
  write(dir, '.gitattributes', '* text=auto eol=lf\n');
  write(dir, '.github/workflows/store-branch.yml');
  write(dir, 'evals/trigger-x/prompt.md');
  write(dir, 'evals/trigger-x/graders/fired.md');
  write(dir, 'skills/x/SKILL.md');
  write(dir, 'skills/x/scripts/run.js');
  write(dir, 'skills/x/scripts/run.test.js');
  write(dir, 'scripts/migrate.test.js');
  write(dir, 'scripts/store/sync_store_branch.js');
  write(dir, 'test/suite1/login.md');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function runCli(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
}

const KEPT = ['.claude-plugin/plugin.json', 'README.md', 'skills/x/SKILL.md', 'skills/x/scripts/run.js', 'test/suite1/login.md'];

test('store tree keeps runtime files and drops evals, tests, .github, .gitattributes and scripts/store', () => {
  const dir = pluginRepo();
  const res = buildStoreCommit({ cwd: dir, source: 'main' });
  assert.strictEqual(res.changed, true);
  assert.deepStrictEqual(treeFiles(dir, res.commit), KEPT);
  assert.strictEqual(res.files, KEPT.length);
});

test('working tree and index are untouched', () => {
  const dir = pluginRepo();
  buildStoreCommit({ cwd: dir, source: 'main' });
  assert.strictEqual(git(dir, 'status', '--porcelain'), '', 'clean status');
  assert.strictEqual(git(dir, 'ls-files').split('\n').length, 12, 'index still lists every main file');
});

test('no change on main → no new store commit; a change → one commit on top of the store head', () => {
  const dir = pluginRepo();
  const first = buildStoreCommit({ cwd: dir, source: 'main' });
  git(dir, 'branch', 'store', first.commit);
  const again = buildStoreCommit({ cwd: dir, source: 'main', parent: 'store' });
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.commit, first.commit);

  write(dir, 'evals/trigger-y/prompt.md');           // dev-only change: store unaffected
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'eval only');
  assert.strictEqual(buildStoreCommit({ cwd: dir, source: 'main', parent: 'store' }).changed, false);

  write(dir, 'skills/x/SKILL.md', 'updated\n');       // runtime change: store moves
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'skill change');
  const next = buildStoreCommit({ cwd: dir, source: 'main', parent: 'store' });
  assert.strictEqual(next.changed, true);
  assert.strictEqual(git(dir, 'rev-parse', `${next.commit}^`), first.commit, 'parent is the store head');
  assert.strictEqual(git(dir, 'show', `${next.commit}:skills/x/SKILL.md`), 'updated');
});

test('CLI --push creates the remote store branch, then only fast-forwards it', () => {
  const dir = pluginRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-remote-'));
  git(bare, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');

  const r1 = runCli(dir, ['--push', 'origin']);
  assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
  assert.strictEqual(r1.out.pushed, true);
  assert.deepStrictEqual(treeFiles(bare, 'store'), KEPT);

  git(dir, 'fetch', '-q', 'origin');
  const r2 = runCli(dir, ['--push', 'origin']);
  assert.strictEqual(r2.out.changed, false);
  assert.strictEqual(r2.out.pushed, false);

  write(dir, 'README.md', 'new\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'readme');
  const r3 = runCli(dir, ['--push', 'origin']);
  assert.strictEqual(r3.out.pushed, true);
  assert.strictEqual(git(bare, 'rev-parse', 'store^'), r1.out.commit, 'fast-forward on top of the first sync');
});

test('a store branch moved by hand makes the push fail instead of being overwritten', () => {
  const dir = pluginRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-remote-'));
  git(bare, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', bare);
  assert.strictEqual(runCli(dir, ['--push', 'origin']).code, 0);
  git(dir, 'fetch', '-q', 'origin');
  // Someone else advances store; our stale origin/store is now behind it.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-other-'));
  git(other, 'clone', '-q', '-b', 'store', bare, '.');
  write(other, 'hand-edit.md');
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'hand edit'); git(other, 'push', '-q');
  write(dir, 'README.md', 'new\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'readme');
  const r = runCli(dir, ['--push', 'origin']);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.out.ok, false);
  assert.ok(git(bare, 'ls-tree', '--name-only', 'store').includes('hand-edit.md'), 'hand edit survives');
});

test(`over ${FILE_LIMIT} files → exit 1 and nothing pushed`, () => {
  const dir = pluginRepo();
  for (let i = 0; i < FILE_LIMIT; i++) write(dir, `skills/x/refs/f${i}.md`);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'many');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-remote-'));
  git(bare, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', bare);
  const r = runCli(dir, ['--push', 'origin']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.pushed, false);
  assert.match(r.out.reason, /directory limit is 512/);
  assert.strictEqual(spawnSync('git', ['rev-parse', '-q', '--verify', 'store'], { cwd: bare }).status, 1, 'no store branch');
});

test('unknown refs and arguments → exit 2 with a reason', () => {
  const dir = pluginRepo();
  assert.strictEqual(runCli(dir, ['--source', 'nope']).code, 2);
  assert.strictEqual(runCli(dir, ['--bogus', 'x']).code, 2);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
