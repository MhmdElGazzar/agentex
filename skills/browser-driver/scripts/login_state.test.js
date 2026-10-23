'use strict';
// Tests for login_state.js: loads / saves a saved login (`test/.auth/<env>-<user>-state.json`)
// into / from the run's playwright-cli session via `state-load` / `state-save`.
//
// No live browser: AGENTEX_PWCLI_CMD (fixture-only seam, the one fill_secret.js uses) points at a
// fake playwright-cli that records its argv. Like the real CLI it never needs the state file's
// content, but it echoes sentinel cookie / localStorage values on stdout and stderr, so "never
// relay child output, never print a state value" is tested for real.
//
// Run: node skills/browser-driver/scripts/login_state.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'login_state.js');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const { statePathFor } = require('./login_state.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const COOKIE = 'SENTINEL_COOKIE_VALUE_c4f1';
const STORAGE = 'SENTINEL_LOCALSTORAGE_VALUE_77a2';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- the fake playwright-cli -----------------------------------------------------------
const FAKE = path.join(tmp('agentex-ls-fake-'), 'fake_pwcli.js');
fs.writeFileSync(FAKE, String.raw`'use strict';
const fs = require('fs'); const path = require('path');
const rec = process.env.FAKE_REC;
const argv = process.argv.slice(2);
const f = path.join(rec, 'calls.json');
const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
const fArg = argv.find((a) => a.startsWith('--filename='));
const code = fArg && fs.existsSync(fArg.slice(11)) ? fs.readFileSync(fArg.slice(11), 'utf8') : null;
all.push({ argv, code });
fs.writeFileSync(f, JSON.stringify(all));
const cmd = argv[1];
const leak = () => { process.stdout.write('cookie=' + process.env.FAKE_COOKIE + ' ls=' + process.env.FAKE_STORAGE + '\n'); process.stderr.write('cookie=' + process.env.FAKE_COOKIE + '\n'); };
const mode = (process.env.FAKE_MODES || '').split(',').reduce((m, kv) => { const [k, v] = kv.split('='); if (k) m[k] = v; return m; }, {});
const m = mode[cmd] || 'ok';
if (m === 'hang') { setTimeout(() => {}, 60000); return; }
if (m === 'gone') { process.stdout.write("The browser '" + argv[0].slice(3) + "' is not open, please run open first\n"); process.exit(1); }
if (m === 'unknown') { process.stderr.write("error: unknown command '" + cmd + "'\n"); process.exit(1); }
if (m === 'bad') { process.stderr.write('Error: ENOENT or invalid JSON in state file\n'); process.exit(1); }
if (cmd === 'state-save') {
  const target = argv[2];
  fs.writeFileSync(target, JSON.stringify({ cookies: [{ name: 's', value: process.env.FAKE_COOKIE }], origins: [{ localStorage: [{ name: 'k', value: process.env.FAKE_STORAGE }] }] }));
  leak(); process.stdout.write(target + '\n'); process.exit(0);
}
if (cmd === 'run-code') {
  leak();
  const held = process.env.FAKE_HELD !== 'false';
  const url = process.env.FAKE_URL || 'https://app.test/dashboard?code=OAUTH_SECRET#frag';
  const out = JSON.stringify({ held, url });
  process.stdout.write(argv.includes('--raw') ? out + '\n' : '### Result\n' + out + '\n');
  process.exit(0);
}
leak(); process.exit(0);
`);

// ---- a consumer project ----------------------------------------------------------------
function proj({ ignore = true, env = { users: { buyer: { phone: '1' }, 'weird user!': { phone: '2' } } }, project = { defaultEnvironment: 'qa' }, git = true } = {}) {
  const dir = tmp('agentex-ls-proj-');
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir });
  if (ignore) fs.writeFileSync(path.join(dir, '.gitignore'), 'test/.auth/\n');
  if (project) { fs.mkdirSync(path.join(dir, 'config')); fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(project)); }
  if (env) { fs.mkdirSync(path.join(dir, 'environments')); fs.writeFileSync(path.join(dir, 'environments', 'qa.json'), JSON.stringify(env)); }
  return dir;
}
const AUTH = (dir) => path.join(dir, 'test', '.auth');
const STATE = (dir, user = 'buyer') => path.join(dir, statePathFor('qa', user));
const SIDECAR = (dir, user = 'buyer') => STATE(dir, user).replace(/\.json$/, '.meta.json');
// A saved login as /execute-test would have left it: the state file (sentinel inside) + its sidecar.
function seed(dir, { sidecar = { schemaVersion: 1, url: 'https://app.test/dashboard', landmark: { present: '#account-menu' }, savedAt: '2026-10-23T00:00:00Z' }, user = 'buyer' } = {}) {
  fs.mkdirSync(AUTH(dir), { recursive: true });
  fs.writeFileSync(STATE(dir, user), JSON.stringify({ cookies: [{ name: 's', value: COOKIE }], origins: [{ localStorage: [{ name: 'k', value: STORAGE }] }] }), { mode: 0o600 });
  if (sidecar) fs.writeFileSync(SIDECAR(dir, user), JSON.stringify(sidecar));
}

function run(args, { cwd = proj(), modes = '', held = true, ci = false, seam = true, extraEnv = {} } = {}) {
  const rec = tmp('agentex-ls-rec-');
  const env = { ...process.env, FAKE_REC: rec, FAKE_MODES: modes, FAKE_HELD: String(held), FAKE_COOKIE: COOKIE, FAKE_STORAGE: STORAGE, ...extraEnv };
  delete env.AGENTEX_CI;
  if (ci) env.AGENTEX_CI = '1';
  if (seam) env.AGENTEX_PWCLI_CMD = FAKE;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let json = null; try { json = JSON.parse(lines[lines.length - 1]); } catch {}
  const f = path.join(rec, 'calls.json');
  const calls = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', lines, json, calls, cmds: calls.map((c) => c.argv[1]), cwd };
}
const LOAD = ['load', '--session', 'run-ab12', '--env', 'qa', '--user', 'buyer'];
const SAVE = ['save', '--session', 'run-ab12', '--env', 'qa', '--user', 'buyer', '--present', '#account-menu'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, out); } else out.push(p);
  }
  return out;
}
// No state value reaches our stdout/stderr; our output is one JSON line.
function assertNoLeak(r) {
  for (const v of [COOKIE, STORAGE, 'OAUTH_SECRET']) {
    assert.ok(!r.stdout.includes(v), `${v} in stdout`);
    assert.ok(!r.stderr.includes(v), `${v} in stderr`);
  }
  assert.strictEqual(r.lines.length, 1, 'exactly one stdout line');
}

// ---- AC1: load, no file / no environment ---------------------------------------------------
test('AC1 load: no state file -> RESUME_FAIL no-state, exit 1, no CLI call', () => {
  const r = run(LOAD);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(r.json.result, 'RESUME_FAIL');
  assert.strictEqual(r.json.reason, 'no-state');
  assert.strictEqual(r.calls.length, 0);
  assertNoLeak(r);
});

test('AC1 load: no environment (legacy project, or an unknown env) -> RESUME_FAIL no-environment, exit 1, no CLI call', () => {
  for (const cwd of [proj({ env: null, project: null }), proj({ env: null })]) {
    const r = run(LOAD, { cwd });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.strictEqual(r.json.reason, 'no-environment');
    assert.strictEqual(r.calls.length, 0);
  }
  const r = run(['load', '--session', 'run-ab12', '--env', 'nope', '--user', 'buyer']);
  assert.strictEqual(r.json.reason, 'no-environment');
  assert.strictEqual(r.calls.length, 0);
});

// ---- AC2: load, happy path -----------------------------------------------------------------
test('AC2 load: state-load <abs path>, goto <sidecar url>, one landmark run-code, in order; RESUME_PASS, file untouched', () => {
  const cwd = proj(); seed(cwd);
  const before = fs.readFileSync(STATE(cwd)); const mt = fs.statSync(STATE(cwd)).mtimeMs;
  const r = run(LOAD, { cwd });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.json.result, 'RESUME_PASS');
  assert.deepStrictEqual(r.cmds, ['state-load', 'goto', 'run-code']);
  assert.strictEqual(r.calls[0].argv[0], '-s=run-ab12');
  assert.strictEqual(fs.realpathSync(r.calls[0].argv[2]), fs.realpathSync(STATE(cwd)), 'absolute state path');
  assert.ok(path.isAbsolute(r.calls[0].argv[2]));
  assert.strictEqual(r.calls[1].argv[2], 'https://app.test/dashboard');
  assert.ok(r.calls[2].code.includes('#account-menu'), 'landmark in the run-code');
  assert.ok(Buffer.compare(before, fs.readFileSync(STATE(cwd))) === 0, 'bytes unchanged');
  assert.strictEqual(fs.statSync(STATE(cwd)).mtimeMs, mt, 'mtime unchanged');
  assertNoLeak(r);
});

test('AC2 load: --url + --present stand in for a missing sidecar', () => {
  const cwd = proj(); seed(cwd, { sidecar: null });
  const r = run([...LOAD, '--url', 'https://app.test/home', '--present', '#me'], { cwd });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.calls[1].argv[2], 'https://app.test/home');
  assert.ok(r.calls[2].code.includes('#me'));
});

// ---- AC3: load, dead session ---------------------------------------------------------------
test('AC3 load: landmark not held -> RESUME_FAIL landmark-failed, cookies + localStorage cleared, file kept', () => {
  const cwd = proj(); seed(cwd);
  const r = run(LOAD, { cwd, held: false });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(r.json.reason, 'landmark-failed');
  assert.ok(r.cmds.includes('cookie-clear') && r.cmds.includes('localstorage-clear'), r.cmds.join(','));
  assert.ok(fs.existsSync(STATE(cwd)), 'state file still there');
  assertNoLeak(r);
});

// ---- AC4: load, driver failures ------------------------------------------------------------
test('AC4 load: session not open -> BLOCKED session-not-open, infrastructure, exit 2', () => {
  const cwd = proj(); seed(cwd);
  const r = run(LOAD, { cwd, modes: 'state-load=gone' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.strictEqual(r.json.reason, 'session-not-open');
  assert.strictEqual(r.json.infrastructure, true);
  assertNoLeak(r);
});

test('AC4 load: the CLI hangs -> BLOCKED, infrastructure, exit 2', () => {
  const cwd = proj(); seed(cwd);
  const r = run([...LOAD, '--timeout-ms', '800'], { cwd, modes: 'state-load=hang' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.strictEqual(r.json.infrastructure, true);
});

test('AC4 load: pre-0.0.63 CLI ("unknown command") -> RESUME_FAIL cli-unsupported, exit 1', () => {
  const cwd = proj(); seed(cwd);
  const r = run(LOAD, { cwd, modes: 'state-load=unknown' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.result, 'RESUME_FAIL');
  assert.strictEqual(r.json.reason, 'cli-unsupported');
});

test('AC4 load: an unreadable file -> RESUME_FAIL state-unreadable, exit 1', () => {
  const cwd = proj(); seed(cwd);
  const r = run(LOAD, { cwd, modes: 'state-load=bad' });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.reason, 'state-unreadable');
  assert.ok(fs.existsSync(STATE(cwd)));
});

test('AC4 load: no sidecar and no --url/--present -> no-landmark, exit 1, no CLI call', () => {
  const cwd = proj(); seed(cwd, { sidecar: null });
  for (const extra of [[], ['--url', 'https://app.test/'], ['--present', '#me']]) {
    const r = run([...LOAD, ...extra], { cwd });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.strictEqual(r.json.reason, 'no-landmark');
    assert.strictEqual(r.calls.length, 0);
  }
});

test('load: unknown user -> exit 2; usage errors -> BLOCKED usage, exit 2', () => {
  const cwd = proj(); seed(cwd);
  let r = run(['load', '--session', 'run-ab12', '--env', 'qa', '--user', 'ghost'], { cwd });
  assert.strictEqual(r.status, 2); assert.strictEqual(r.json.result, 'BLOCKED'); assert.strictEqual(r.calls.length, 0);
  for (const bad of [[], ['load'], ['load', '--session', 'default', '--user', 'buyer'], ['load', '--session', 'run-ab12'], ['frobnicate'], [...LOAD, '--wat'], ['load', '--session', 'run-ab12', '--env', '../x', '--user', 'buyer']]) {
    r = run(bad, { cwd });
    assert.strictEqual(r.status, 2, JSON.stringify(bad) + r.stdout);
    assert.strictEqual(r.json.reason, 'usage', JSON.stringify(bad));
    assert.strictEqual(r.calls.length, 0);
  }
});

// ---- AC5: save writes safely ---------------------------------------------------------------
test('AC5 save: landmark held -> SAVED; 0600, temp + rename, sidecar without query/fragment; no sentinel in output', () => {
  const cwd = proj();
  const r = run(SAVE, { cwd });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.json.result, 'SAVED');
  assert.deepStrictEqual(r.cmds, ['run-code', 'state-save']);
  const target = r.calls[1].argv[2];
  assert.notStrictEqual(path.basename(target), path.basename(STATE(cwd)), 'state-save wrote a temp file, not the final name');
  assert.strictEqual(fs.realpathSync(path.dirname(target)), fs.realpathSync(AUTH(cwd)), 'temp file sits in test/.auth');
  assert.ok(!fs.existsSync(target), 'temp file renamed away');
  assert.deepStrictEqual(fs.readdirSync(AUTH(cwd)).sort(), [path.basename(SIDECAR(cwd)), path.basename(STATE(cwd))].sort(), 'no leftovers');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(STATE(cwd)).mode & 0o777, 0o600);
  const meta = JSON.parse(fs.readFileSync(SIDECAR(cwd), 'utf8'));
  assert.strictEqual(meta.schemaVersion, 1);
  assert.strictEqual(meta.url, 'https://app.test/dashboard');
  assert.deepStrictEqual(meta.landmark, { present: '#account-menu' });
  assert.ok(typeof meta.savedAt === 'string' && !Number.isNaN(Date.parse(meta.savedAt)));
  assert.ok(!JSON.stringify(meta).includes('OAUTH_SECRET'));
  assertNoLeak(r);
});

test('AC5 save: landmark not held -> NOT_AUTHENTICATED, exit 1, nothing written', () => {
  const cwd = proj();
  const r = run(SAVE, { cwd, held: false });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(r.json.result, 'NOT_AUTHENTICATED');
  assert.ok(!r.cmds.includes('state-save'));
  assert.ok(!fs.existsSync(AUTH(cwd)) || fs.readdirSync(AUTH(cwd)).length === 0);
  assertNoLeak(r);
});

test('AC5 save: a failed state-save leaves no temp file and no final file', () => {
  const cwd = proj();
  const r = run(SAVE, { cwd, modes: 'state-save=gone' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.infrastructure, true);
  assert.ok(!fs.existsSync(AUTH(cwd)) || fs.readdirSync(AUTH(cwd)).length === 0);
});

test('AC5 save: --present is required; an overwrite replaces the old file whole', () => {
  const cwd = proj();
  let r = run(SAVE.slice(0, -2), { cwd });
  assert.strictEqual(r.status, 2); assert.strictEqual(r.json.reason, 'usage'); assert.strictEqual(r.calls.length, 0);
  seed(cwd);
  r = run(SAVE, { cwd });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(STATE(cwd), 'utf8')).cookies[0].value, COOKIE);
});

// ---- AC6: save refuses or skips ------------------------------------------------------------
test('AC6 save: test/.auth/ not gitignored -> BLOCKED not-ignored, exit 2, nothing written, no browser call', () => {
  const cwd = proj({ ignore: false });
  const r = run(SAVE, { cwd });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.strictEqual(r.json.reason, 'not-ignored');
  assert.ok(!r.cmds.includes('state-save'));
  assert.ok(!fs.existsSync(AUTH(cwd)) || fs.readdirSync(AUTH(cwd)).length === 0);
});

test('AC6 save: AGENTEX_CI=1 -> SKIPPED ci-mode, exit 0, nothing written, no browser call', () => {
  const cwd = proj();
  const r = run(SAVE, { cwd, ci: true });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.json.result, 'SKIPPED');
  assert.strictEqual(r.json.reason, 'ci-mode');
  assert.strictEqual(r.calls.length, 0);
  assert.ok(!fs.existsSync(AUTH(cwd)));
});

test('AC6 save: no environment -> SKIPPED no-environment, exit 0; unknown user -> exit 2', () => {
  let r = run(SAVE, { cwd: proj({ env: null }) });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.json.result, 'SKIPPED'); assert.strictEqual(r.json.reason, 'no-environment'); assert.strictEqual(r.calls.length, 0);
  r = run(['save', '--session', 'run-ab12', '--env', 'qa', '--user', 'ghost', '--present', '#a']);
  assert.strictEqual(r.status, 2); assert.strictEqual(r.json.result, 'BLOCKED'); assert.strictEqual(r.calls.length, 0);
});

// ---- AC7: one name -------------------------------------------------------------------------
test('AC7 statePathFor: the F1 name; odd handles map to a stable u-<8 hex>', () => {
  assert.strictEqual(statePathFor('qa', 'buyer'), 'test/.auth/qa-buyer-state.json');
  assert.strictEqual(statePathFor('uat', 'admin_2.x-y'), 'test/.auth/uat-admin_2.x-y-state.json');
  const odd = statePathFor('qa', 'weird user!');
  assert.match(odd, /^test\/\.auth\/qa-u-[0-9a-f]{8}-state\.json$/);
  assert.strictEqual(statePathFor('qa', 'weird user!'), odd, 'stable');
  assert.notStrictEqual(statePathFor('qa', 'weird user?'), odd, 'distinct handles stay distinct');
  assert.match(statePathFor('qa', 'a'.repeat(65)), /qa-u-[0-9a-f]{8}-state\.json$/);
  assert.match(statePathFor('qa', '../../etc'), /^test\/\.auth\/qa-u-[0-9a-f]{8}-state\.json$/);
  assert.match(statePathFor('qa', 'ب'), /qa-u-[0-9a-f]{8}-state\.json$/);
});

test('AC7 load and save use only statePathFor: an odd handle round-trips through the hashed name', () => {
  const cwd = proj();
  const w = (['save', '--session', 'run-ab12', '--env', 'qa', '--user', 'weird user!', '--present', '#a']);
  let r = run(w, { cwd });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(fs.existsSync(STATE(cwd, 'weird user!')), 'saved under the hashed name');
  r = run(['load', '--session', 'run-ab12', '--env', 'qa', '--user', 'weird user!'], { cwd });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(fs.realpathSync(r.calls[0].argv[2]), fs.realpathSync(STATE(cwd, 'weird user!')));
});

// ---- the script never reads a state value --------------------------------------------------
test('the script never reads the state file: no readFileSync on it', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/readFileSync\([^)]*(state|STATE)/.test(src), 'no read of the state file');
});

// ---- AC8: no false claim left (in the files this package owns) -----------------------------
test('AC8 session.js and PLAYWRIGHT_MISSING_ERROR no longer say only the library can load a storageState', () => {
  const sess = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'optimize-login', 'scripts', 'session.js'), 'utf8');
  assert.ok(!/only the library can load/i.test(sess));
  const { PLAYWRIGHT_MISSING_ERROR: msg } = require(path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'scripts', 'preflight.js'));
  assert.ok(!/only the library|only .* can load/i.test(msg), msg);
  const pf = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'scripts', 'preflight.js'), 'utf8');
  assert.ok(!/only the library can load/i.test(pf));
});

test('AC8 no <app>-<env> state name left in the docs or scripts this package owns (SKILL.md / playwright-cli.md belong to P-1)', () => {
  const files = [
    path.join(PLUGIN_ROOT, 'docs', 'optimize-login.md'), path.join(PLUGIN_ROOT, 'docs', 'configuration.md'),
    path.join(PLUGIN_ROOT, 'skills', 'browser-driver', 'references', 'tools', 'login-state.md'),
    path.join(PLUGIN_ROOT, 'skills', 'optimize-login', 'scripts', 'session.js'),
    path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'scripts', 'preflight.js'),
  ];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/<app>-<env/.test(t), `${path.relative(PLUGIN_ROOT, f)} still has <app>-<env...>`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
