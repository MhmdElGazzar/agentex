'use strict';
// Tests for the opt-in pre-commit hook: template, hooks-dir resolution, the
// status/install/print matrix, and real `git commit` runs through the installed
// hook (refuse on a leak, proceed on warnings, fail open loudly, survive updates).
// Run: node scripts/lib/precommit_hook.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// The tests own the environment: a throwaway HOME (the resolver's default plugins
// root), no Claude plugin variables, no inherited git hook variables or user config.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-hook-home-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_') || k.startsWith('CLAUDE_') || /^(AZURE_|API_|DEFAULT_)/.test(k)) delete process.env[k];
}
fs.writeFileSync(path.join(HOME, '.gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';

const hook = require('./precommit_hook.js');
const REAL_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REAL_ROOT, 'scripts', 'precommit_hook.js');
const SECRET = 'EVAL_SENTINEL_SCAN_hook_6d2r';
const ALL_OUTPUT = [];

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function tmp(p = 'agentex-hook-') { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); }
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test',
    '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function repo({ commit = true, env = `API_TOKEN=${SECRET}\n` } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  write(dir, '.gitignore', '.env\n');
  write(dir, 'README.md', 'project\n');
  git(dir, 'add', '-A');
  if (commit) git(dir, 'commit', '-qm', 'fixture');
  if (env !== null) write(dir, '.env', env);
  return dir;
}
function listing(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      out.push(path.relative(dir, full));
      if (e.isDirectory()) walk(full);
    }
  })(dir);
  return out;
}

// A fake installed plugin version under <HOME>/.claude/plugins/cache/<marketplace>/agentex/<version>.
const CACHE_PARENT = path.join(HOME, '.claude', 'plugins', 'cache', 'example-marketplace', 'agentex');
function fakeVersion(version, { brokenScanner = false } = {}) {
  const root = path.join(CACHE_PARENT, version);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(REAL_ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REAL_ROOT, 'skills', 'test-execution', 'scripts'), path.join(root, 'skills', 'test-execution', 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.env.example'), path.join(root, '.env.example'));
  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agentex', version }));
  if (brokenScanner) fs.writeFileSync(path.join(root, 'scripts', 'secret_scan.js'), 'process.exit(3);\n');
  return root;
}
function resetCache() { fs.rmSync(path.join(HOME, '.claude'), { recursive: true, force: true }); }

function commit(dir, msg = 'x', { env = {} } = {}) {
  const r = spawnSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test', 'commit', '-m', msg],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  ALL_OUTPUT.push(r.stdout, r.stderr);
  return r;
}
const headCount = (dir) => { try { return Number(git(dir, 'rev-list', '--count', 'HEAD').trim()); } catch { return 0; } };

// ── Template ─────────────────────────────────────────────────────────────────
test('template: ASCII, LF-only, sh -n clean (dash and bash --posix too, where present)', () => {
  const body = hook.renderHook({ projectPrefix: 'qa/it\'s', cacheParent: '', installRoot: 'C:\\Users\\qa\\plugin', nodePath: '/usr/bin/node' });
  assert.ok(/^[\x00-\x7F]*$/.test(body), 'ASCII only');
  assert.ok(!body.includes('\r'), 'LF only');
  assert.ok(body.startsWith('#!/bin/sh\n'));
  const f = path.join(tmp(), 'pre-commit'); fs.writeFileSync(f, body);
  for (const [shell, args] of [['sh', ['-n']], ['dash', ['-n']], ['bash', ['--posix', '-n']]]) {
    const r = spawnSync(shell, [...args, f], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') continue;
    assert.strictEqual(r.status, 0, `${shell}: ${r.stderr}`);
  }
  assert.ok(body.includes("AGENTEX_PROJECT_PREFIX='qa/it'\\''s'"), 'single quotes escaped');
  assert.ok(body.includes("AGENTEX_INSTALL_ROOT='C:/Users/qa/plugin'"), 'Windows paths with forward slashes');
});

test('template pins the stable contract: scripts/secret_scan.js, --staged, --project, --hook, the LEAK marker', () => {
  const body = hook.renderHook({ projectPrefix: '', cacheParent: '', installRoot: '/x', nodePath: '/n' });
  for (const s of ['"scripts","secret_scan.js"', '--staged', '--project', '--hook', '"result":"LEAK"', '# agentex-pre-commit-hook v1']) {
    assert.ok(body.includes(s), s);
  }
  const m = body.match(/# agentex-hook-checksum: ([0-9a-f]{64})\n$/);
  assert.ok(m, 'checksum line last');
  assert.strictEqual(crypto.createHash('sha256').update(body.slice(0, m.index)).digest('hex'), m[1]);
});

// ── Status / install matrix ──────────────────────────────────────────────────
test('not a repo → status not-a-repo; install exit 2 and nothing written', () => {
  const dir = tmp();
  write(dir, 'a.txt', 'a');
  const before = listing(dir);
  assert.strictEqual(hook.status(dir).status, 'not-a-repo');
  const r = hook.install(dir, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r.status, r.exit], ['not-a-repo', 2]);
  assert.match(r.message, /not a git repository/);
  assert.deepStrictEqual(listing(dir), before);
});

test('fresh repo before its first commit → absent, then installs (exec bit set)', () => {
  const dir = repo({ commit: false });
  assert.strictEqual(hook.status(dir).status, 'absent');
  const r = hook.install(dir, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r.status, r.exit], ['installed', 0]);
  const p = path.join(dir, '.git', 'hooks', 'pre-commit');
  assert.strictEqual(r.hookPath, p);
  if (process.platform !== 'win32') assert.ok(fs.statSync(p).mode & 0o111, 'executable');
  assert.strictEqual(hook.status(dir).status, 'installed');
});

test('already installed → "already-installed", zero writes (bytes and mtime unchanged)', () => {
  const dir = repo();
  hook.install(dir, { pluginRoot: REAL_ROOT });
  const p = path.join(dir, '.git', 'hooks', 'pre-commit');
  const past = new Date(Date.now() - 60000); fs.utimesSync(p, past, past);
  const before = { bytes: fs.readFileSync(p), mtime: fs.statSync(p).mtimeMs };
  const r = hook.install(dir, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r.status, r.exit], ['already-installed', 0]);
  assert.ok(fs.readFileSync(p).equals(before.bytes));
  assert.strictEqual(fs.statSync(p).mtimeMs, before.mtime);
});

test('a foreign hook → refused, byte-identical, with the existing path and the docs pointer', () => {
  const dir = repo();
  const p = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(p, '#!/bin/sh\necho mine\n');
  assert.strictEqual(hook.status(dir).status, 'foreign');
  const r = hook.install(dir, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r.status, r.reason, r.exit, r.snippetAvailable], ['refused', 'foreign', 1, true]);
  assert.strictEqual(r.hookPath, p);
  assert.match(r.docs, /putting-your-project-in-git\.md#calling-the-scan-from-an-existing-hook$/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('a user-edited own hook (checksum mismatch) counts as foreign and is never touched', () => {
  const dir = repo();
  hook.install(dir, { pluginRoot: REAL_ROOT });
  const p = path.join(dir, '.git', 'hooks', 'pre-commit');
  const edited = fs.readFileSync(p, 'utf8').replace('mode=--staged', 'mode=--staged; echo extra');
  fs.writeFileSync(p, edited);
  assert.strictEqual(hook.status(dir).status, 'foreign');
  assert.strictEqual(hook.install(dir, { pluginRoot: REAL_ROOT }).status, 'refused');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), edited);
});

test('a stale own hook (older template version) → status stale, install refreshes it', () => {
  const dir = repo();
  const p = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(p, hook.renderHook({ projectPrefix: '', cacheParent: '', installRoot: REAL_ROOT, nodePath: process.execPath, version: 0 }));
  assert.strictEqual(hook.status(dir).status, 'stale');
  const r = hook.install(dir, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r.status, r.exit], ['refreshed', 0]);
  assert.strictEqual(hook.status(dir).status, 'installed');
});

test('an own hook whose baked locations no longer resolve → stale', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo();
  hook.install(dir, { pluginRoot: root });
  assert.strictEqual(hook.status(dir).status, 'installed');
  resetCache();
  assert.strictEqual(hook.status(dir).status, 'stale');
});

test('core.hooksPath relative and absolute (repo-local) → installed there; .git/hooks/pre-commit stays absent', () => {
  const rel = repo();
  git(rel, 'config', 'core.hooksPath', '.githooks');
  const r1 = hook.install(rel, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r1.status, r1.hookPath], ['installed', path.join(rel, '.githooks', 'pre-commit')]);
  assert.ok(!fs.existsSync(path.join(rel, '.git', 'hooks', 'pre-commit')));
  const abs = repo();
  const target = path.join(tmp(), 'my hooks');
  git(abs, 'config', 'core.hooksPath', target);
  const r2 = hook.install(abs, { pluginRoot: REAL_ROOT });
  assert.deepStrictEqual([r2.status, r2.hookPath], ['installed', path.join(target, 'pre-commit')]);
  assert.ok(!fs.existsSync(path.join(abs, '.git', 'hooks', 'pre-commit')));
});

test('a machine-wide core.hooksPath (global config) → shared-hooks-path, refused, nothing written (NU-5)', () => {
  const dir = repo();
  const shared = path.join(tmp(), 'shared-hooks');
  fs.writeFileSync(path.join(HOME, '.gitconfig'), `[core]\n\thooksPath = ${shared}\n`);
  try {
    assert.strictEqual(hook.status(dir).status, 'shared-hooks-path');
    const r = hook.install(dir, { pluginRoot: REAL_ROOT });
    assert.deepStrictEqual([r.status, r.reason, r.exit], ['refused', 'shared-hooks-path', 1]);
    assert.ok(!fs.existsSync(shared));
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
  } finally { fs.writeFileSync(path.join(HOME, '.gitconfig'), ''); }
});

test('install from a linked worktree → the common hooks directory', () => {
  const dir = repo();
  const wt = path.join(tmp(), 'wt');
  git(dir, 'worktree', 'add', '-q', wt);
  const r = hook.install(wt, { pluginRoot: REAL_ROOT });
  assert.strictEqual(r.status, 'installed');
  assert.strictEqual(fs.realpathSync(r.hookPath), path.join(dir, '.git', 'hooks', 'pre-commit'));
});

test('print → the standalone script, writes nothing, carries no own-hook marker', () => {
  const dir = repo();
  const before = listing(dir);
  const r = hook.printScript(dir, { pluginRoot: REAL_ROOT });
  assert.strictEqual(r.action, 'print');
  assert.ok(r.script.startsWith('#!/bin/sh\n'));
  assert.ok(!r.script.includes('agentex-pre-commit-hook v'), 'not mistaken for an installed hook');
  assert.ok(r.script.includes('--staged') && r.script.includes('"result":"LEAK"'));
  assert.deepStrictEqual(listing(dir), before);
});

test('engineLine: exactly one [hook] line per state', () => {
  const lines = [
    hook.engineLine({ action: 'status', status: 'absent', hookPath: '/r/.git/hooks/pre-commit' }),
    hook.engineLine({ action: 'status', status: 'installed', hookPath: '/p' }),
    hook.engineLine({ action: 'install', status: 'installed', hookPath: '/p' }),
    hook.engineLine({ action: 'install', status: 'already-installed', hookPath: '/p' }),
    hook.engineLine({ action: 'install', status: 'refreshed', hookPath: '/p' }),
    hook.engineLine({ action: 'install', status: 'refused', reason: 'foreign', hookPath: '/p' }),
    hook.engineLine({ action: 'status', status: 'shared-hooks-path' }),
  ];
  for (const l of lines) { assert.ok(l.startsWith('[hook] ')); assert.ok(!l.includes('\n')); }
  assert.match(lines[0], /^\[hook\] offer/);
  assert.match(lines[0], /--install-pre-commit-hook/);
  assert.match(lines[3], /already installed/);
  assert.match(lines[5], /existing hook left untouched/);
  assert.match(lines[6], /shared hooks folder, not installed/);
});

// ── Real commits through the installed hook ──────────────────────────────────
test('real commit: a staged secret is refused — file, line, key and docs shown, never the value', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo();
  hook.install(dir, { pluginRoot: root });
  write(dir, 'test/login.md', `# login\ntoken ${SECRET}\n`);
  git(dir, 'add', 'test/login.md');
  const before = headCount(dir);
  const r = commit(dir);
  assert.notStrictEqual(r.status, 0, 'refused');
  assert.strictEqual(headCount(dir), before, 'nothing committed');
  assert.match(r.stderr, /test\/login\.md:2/);
  assert.match(r.stderr, /API_TOKEN/);
  assert.match(r.stderr, /commit REFUSED/);
  assert.match(r.stderr, /putting-your-project-in-git\.md#fixing-findings/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

test('real commit: warnings only (and a skipped value check) → succeeds and shows them', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo({ env: null });
  hook.install(dir, { pluginRoot: root });
  write(dir, 'environments/qc.json', '{ "api": { "token": "plain-text-token" } }\n');
  git(dir, 'add', 'environments/qc.json');
  const r = commit(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN environments\/qc\.json:1/);
  assert.match(r.stderr, /value check SKIPPED/);
});

test('real commit: the plugin removed → the commit succeeds with the loud "did NOT run" line', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo();
  hook.install(dir, { pluginRoot: root });
  resetCache();
  write(dir, 'a.md', `${SECRET}\n`); git(dir, 'add', 'a.md');
  const r = commit(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /AgenTeX secret scan did NOT run: the AgenTeX plugin was not found.*UNSCANNED/);
});

test('real commit: Node unresolvable (PATH without node, bad baked path) → succeeds with "did NOT run"', () => {
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const pathDirs = [path.dirname(gitBin), '/bin', '/usr/bin'];
  if (pathDirs.some(d => fs.existsSync(path.join(d, 'node')))) { console.log('    (skipped: node sits beside git on this machine)'); return; }
  const dir = repo();
  hook.install(dir, { pluginRoot: REAL_ROOT, nodePath: '/nonexistent/node' });
  write(dir, 'a.md', 'x\n'); git(dir, 'add', 'a.md');
  const r = commit(dir, 'x', { env: { PATH: pathDirs.join(':') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /did NOT run: Node\.js was not found/);
});

test('real commit: a scan error → succeeds with "did NOT run" (fail open, Q5)', () => {
  resetCache();
  const root = fakeVersion('0.24.0', { brokenScanner: true });
  const dir = repo();
  hook.install(dir, { pluginRoot: root });
  write(dir, 'a.md', 'x\n'); git(dir, 'add', 'a.md');
  const r = commit(dir);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /did NOT run: the scan stopped with an error \(exit 3\)/);
});

test('real commit: after a simulated update (new version + .orphaned_at in the old) the hook keeps scanning on the new one', () => {
  resetCache();
  const old = fakeVersion('0.24.0');
  const dir = repo();
  hook.install(dir, { pluginRoot: old });
  fakeVersion('0.24.0', { brokenScanner: true });            // were the old one used, the scan would "error"
  fs.writeFileSync(path.join(old, '.orphaned_at'), String(Date.now()));
  fakeVersion('0.25.0');
  write(dir, 'a.md', `${SECRET}\n`); git(dir, 'add', 'a.md');
  const r = commit(dir);
  assert.notStrictEqual(r.status, 0, 'refused by the new version\'s scan');
  assert.match(r.stderr, /a\.md:1/);
  assert.strictEqual(hook.status(dir).status, 'installed', 'still resolves');
});

test('real commit: every version orphaned → loud "did NOT run"', () => {
  resetCache();
  const v = fakeVersion('0.24.0');
  const dir = repo();
  hook.install(dir, { pluginRoot: v });
  fs.writeFileSync(path.join(v, '.orphaned_at'), '1');
  write(dir, 'a.md', 'x\n'); git(dir, 'add', 'a.md');
  const r = commit(dir);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /did NOT run: the AgenTeX plugin was not found/);
});

test('real commit: a hook copied without the baked cache parent still finds AgenTeX under the plugins root', () => {
  resetCache();
  fakeVersion('0.24.0');
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
    hook.renderHook({ projectPrefix: '', cacheParent: '', installRoot: '/nonexistent', nodePath: process.execPath }), { mode: 0o755 });
  write(dir, 'a.md', `${SECRET}\n`); git(dir, 'add', 'a.md');
  assert.notStrictEqual(commit(dir).status, 0);
});

test('a CRLF-converted hook (autocrlf on a committed hooks folder) still runs under sh and is still recognised', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo();
  git(dir, 'config', 'core.hooksPath', '.githooks');
  const r = hook.install(dir, { pluginRoot: root });
  const crlf = fs.readFileSync(r.hookPath, 'utf8').replace(/\n/g, '\r\n');
  fs.writeFileSync(r.hookPath, crlf);
  assert.strictEqual(hook.status(dir).status, 'installed', 'line endings do not make it foreign');
  write(dir, 'a.md', `${SECRET}\n`); git(dir, 'add', 'a.md');
  const leak = spawnSync('sh', [r.hookPath], { cwd: dir, encoding: 'utf8' });
  ALL_OUTPUT.push(leak.stdout, leak.stderr);
  assert.strictEqual(leak.status, 1, leak.stderr);
  assert.ok(!/did NOT run/.test(leak.stderr), leak.stderr);
  git(dir, 'reset', '-q', 'a.md'); write(dir, 'b.md', 'clean\n'); git(dir, 'add', 'b.md');
  const clean = spawnSync('sh', [r.hookPath], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(clean.status, 0, clean.stderr);
});

test('manual tracked run: sh <hook> --tracked scans every tracked file', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo();
  write(dir, 'old.md', `${SECRET}\n`); git(dir, 'add', 'old.md'); git(dir, 'commit', '-qm', 'old', '--no-verify');
  const r = hook.install(dir, { pluginRoot: root });
  const s = spawnSync('sh', [r.hookPath, '--tracked'], { cwd: path.join(dir), encoding: 'utf8' });
  ALL_OUTPUT.push(s.stdout, s.stderr);
  assert.strictEqual(s.status, 1);
  assert.match(s.stderr, /\(tracked\)/);
});

test('a project in a subfolder: the baked prefix points the scan at its .env', () => {
  resetCache();
  const root = fakeVersion('0.24.0');
  const dir = repo({ env: null });
  write(dir, 'qa/.env', `API_TOKEN=${SECRET}\n`);
  write(dir, '.gitignore', '.env\nqa/.env\n'); git(dir, 'add', '.gitignore'); git(dir, 'commit', '-qm', 'ignore');
  hook.install(path.join(dir, 'qa'), { pluginRoot: root });
  write(dir, 'qa/test/a.md', `${SECRET}\n`); git(dir, 'add', 'qa/test/a.md');
  const r = commit(dir);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /qa\/test\/a\.md:1/);
});

// ── CLI ──────────────────────────────────────────────────────────────────────
function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  ALL_OUTPUT.push(r.stdout, r.stderr);
  return { status: r.status, lines: r.stdout.split('\n').filter(Boolean), json: JSON.parse(r.stdout) };
}

test('CLI status | install | print: one JSON line each, exit codes 0 / 1 refused / 2 not a repo or usage', () => {
  const dir = repo();
  let r = cli(dir, 'status');
  assert.deepStrictEqual([r.status, r.lines.length, r.json.action, r.json.status], [0, 1, 'status', 'absent']);
  r = cli(dir, 'install');
  assert.deepStrictEqual([r.status, r.json.status], [0, 'installed']);
  r = cli(dir, 'install');
  assert.deepStrictEqual([r.status, r.json.status], [0, 'already-installed']);
  r = cli(dir, 'print');
  assert.deepStrictEqual([r.status, r.json.action], [0, 'print']);
  const foreign = repo();
  fs.writeFileSync(path.join(foreign, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  r = cli(foreign, 'install');
  assert.deepStrictEqual([r.status, r.json.status], [1, 'refused']);
  r = cli(tmp(), 'install');
  assert.deepStrictEqual([r.status, r.json.status], [2, 'not-a-repo']);
  r = cli(dir, 'frobnicate');
  assert.deepStrictEqual([r.status, r.json.error], [2, 'usage']);
});

test('sentinel: the secret value never reached any output', () => {
  assert.ok(!ALL_OUTPUT.join('\n').includes(SECRET));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
