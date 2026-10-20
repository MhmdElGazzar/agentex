'use strict';
// Unit tests for the read-only git plumbing layer behind the consumer secret scan
// and the pre-commit hook installer. Run: node scripts/lib/git_plumbing.test.js
// Temp repos only; every git call under test must leave the index and config
// byte-identical.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gp = require('./git_plumbing.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// The tests own git's environment: no inherited hook variables, no user config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
const EMPTY_GLOBAL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gp-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gp-'))); }
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test',
    '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function repo(files = {}, { commit = true } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  for (const [rel, c] of Object.entries(files)) write(dir, rel, c);
  if (Object.keys(files).length) git(dir, 'add', '-A');
  if (commit) git(dir, 'commit', '-qm', 'fixture', '--allow-empty');
  return dir;
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function gitState(dir) {
  const idx = path.join(dir, '.git', 'index');
  return {
    index: fs.existsSync(idx) ? sha1(fs.readFileSync(idx)) : null,
    config: sha1(fs.readFileSync(path.join(dir, '.git', 'config'))),
  };
}

test('repoInfo: outside a repository → not-a-git-repository error code', () => {
  const dir = tmp();
  assert.throws(() => gp.repoInfo(dir), (e) => e.code === 'not-a-git-repository');
});

test('repoInfo: toplevel and prefix for a project in a subfolder', () => {
  const dir = repo({ 'qa/x.md': 'x\n' });
  const info = gp.repoInfo(path.join(dir, 'qa'));
  assert.strictEqual(info.toplevel, dir);
  assert.strictEqual(info.prefix, 'qa/');
  assert.strictEqual(gp.repoInfo(dir).prefix, '');
});

test('diffBase: HEAD when born, the computed empty tree when unborn', () => {
  const born = repo({ 'a.txt': 'a\n' });
  assert.match(gp.diffBase(born), /^[0-9a-f]{40,64}$/);
  assert.strictEqual(gp.diffBase(born), git(born, 'rev-parse', 'HEAD').trim());
  const unborn = repo({}, { commit: false });
  assert.strictEqual(gp.diffBase(unborn), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('stagedEntries: this commit\'s delta only (added, modified), never deletions or unstaged edits', () => {
  const dir = repo({ 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'mod.txt': 'm1\n' });
  write(dir, 'mod.txt', 'm2\n');
  write(dir, 'new.txt', 'n\n');
  git(dir, 'add', 'mod.txt', 'new.txt');
  git(dir, 'rm', '-q', 'gone.txt');
  write(dir, 'keep.txt', 'edited but not staged\n');
  const entries = gp.stagedEntries(dir, gp.diffBase(dir));
  assert.deepStrictEqual(entries.map(e => e.path).sort(), ['mod.txt', 'new.txt']);
  for (const e of entries) { assert.strictEqual(e.mode, '100644'); assert.match(e.sha, /^[0-9a-f]{40}$/); }
});

test('stagedEntries: before the first commit every index entry is in the delta; a rename is the new path', () => {
  const dir = repo({ 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }, { commit: false });
  assert.deepStrictEqual(gp.stagedEntries(dir, gp.diffBase(dir)).map(e => e.path).sort(), ['a.txt', 'sub/b.txt']);
  const r = repo({ 'old.txt': 'same content\n' });
  git(r, 'mv', 'old.txt', 'renamed.txt');
  assert.deepStrictEqual(gp.stagedEntries(r, gp.diffBase(r)).map(e => e.path), ['renamed.txt']);
});

test('stagedEntries: paths are repo-relative even when run from a subfolder; odd names survive -z', () => {
  const dir = repo({ 'qa/x.md': 'x\n' });
  write(dir, 'qa/sp ace\nnl.md', 'y\n');
  write(dir, 'root.md', 'r\n');
  git(dir, 'add', '-A');
  const paths = gp.stagedEntries(path.join(dir, 'qa'), gp.diffBase(dir)).map(e => e.path).sort();
  assert.deepStrictEqual(paths, ['qa/sp ace\nnl.md', 'root.md']);
});

test('trackedEntries: every stage-0 index path of the whole repo, with mode and sha', () => {
  const dir = repo({ 'a.txt': 'a\n', 'qa/b.txt': 'b\n' });
  const entries = gp.trackedEntries(path.join(dir, 'qa'));
  assert.deepStrictEqual(entries.map(e => e.path).sort(), ['a.txt', 'qa/b.txt']);
  assert.ok(entries.every(e => e.mode === '100644' && /^[0-9a-f]{40}$/.test(e.sha)));
});

test('readBlobs: sizes and contents by sha, binary-safe, in one batch', () => {
  const dir = repo({ 'a.txt': 'alpha\n', 'b.bin': Buffer.from([0, 1, 2, 255]) });
  const entries = gp.trackedEntries(dir);
  const shas = entries.map(e => e.sha);
  const sizes = gp.blobSizes(dir, shas);
  const byPath = Object.fromEntries(entries.map(e => [e.path, e.sha]));
  assert.strictEqual(sizes.get(byPath['a.txt']), 6);
  assert.strictEqual(sizes.get(byPath['b.bin']), 4);
  const blobs = gp.readBlobs(dir, shas);
  assert.strictEqual(blobs.get(byPath['a.txt']).toString('utf8'), 'alpha\n');
  assert.deepStrictEqual([...blobs.get(byPath['b.bin'])], [0, 1, 2, 255]);
  assert.strictEqual(gp.readBlobs(dir, []).size, 0);
});

test('remoteUrls: url and pushurl of every remote; none → empty list', () => {
  const dir = repo();
  assert.deepStrictEqual(gp.remoteUrls(dir), []);
  git(dir, 'remote', 'add', 'origin', 'https://example.test/team/repo.git');
  git(dir, 'config', 'remote.origin.pushurl', 'https://example.test/push.git');
  git(dir, 'remote', 'add', 'up', 'git@example.test:team/repo.git');
  const got = gp.remoteUrls(dir).map(r => `${r.remote}.${r.field}=${r.url}`).sort();
  assert.deepStrictEqual(got, [
    'origin.pushurl=https://example.test/push.git',
    'origin.url=https://example.test/team/repo.git',
    'up.url=git@example.test:team/repo.git',
  ]);
});

test('hooksPathConfig: unset → null; repo-local → scope local; global → scope global', () => {
  const dir = repo();
  assert.strictEqual(gp.hooksPathConfig(dir), null);
  git(dir, 'config', 'core.hooksPath', 'my-hooks');
  assert.deepStrictEqual(gp.hooksPathConfig(dir), { value: 'my-hooks', scope: 'local' });
  git(dir, 'config', '--unset', 'core.hooksPath');
  const g = path.join(tmp(), 'gc');
  fs.writeFileSync(g, '[core]\n\thooksPath = /tmp/shared-hooks\n');
  process.env.GIT_CONFIG_GLOBAL = g;
  try { assert.deepStrictEqual(gp.hooksPathConfig(dir), { value: '/tmp/shared-hooks', scope: 'global' }); }
  finally { process.env.GIT_CONFIG_GLOBAL = EMPTY_GLOBAL; }
});

test('defaultHooksDir: absolute; a linked worktree resolves to the common hooks directory', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  assert.strictEqual(gp.defaultHooksDir(dir), path.join(dir, '.git', 'hooks'));
  const wt = path.join(tmp(), 'wt');
  git(dir, 'worktree', 'add', '-q', wt);
  assert.strictEqual(fs.realpathSync(path.dirname(gp.defaultHooksDir(wt))), path.join(dir, '.git'));
});

test('read-only: every plumbing call leaves .git/index and .git/config byte-identical', () => {
  const dir = repo({ 'a.txt': 'a\n' });
  git(dir, 'remote', 'add', 'origin', 'https://example.test/r.git');
  write(dir, 'b.txt', 'b\n'); git(dir, 'add', 'b.txt');
  // Touch the working copy so a refreshing command would rewrite the index stat cache.
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'a.txt'), t, t);
  const before = gitState(dir);
  const base = gp.diffBase(dir);
  const shas = gp.stagedEntries(dir, base).map(e => e.sha).concat(gp.trackedEntries(dir).map(e => e.sha));
  gp.blobSizes(dir, shas); gp.readBlobs(dir, shas);
  gp.remoteUrls(dir); gp.hooksPathConfig(dir); gp.defaultHooksDir(dir); gp.repoInfo(dir);
  assert.deepStrictEqual(gitState(dir), before);
});

test('errors carry fixed vocabulary only — never raw git stderr', () => {
  const dir = tmp();
  try { gp.repoInfo(dir); assert.fail('should throw'); }
  catch (e) {
    assert.strictEqual(e.code, 'not-a-git-repository');
    assert.ok(!/fatal:/i.test(e.message), 'no git stderr in the message');
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
