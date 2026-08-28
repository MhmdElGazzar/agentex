'use strict';
// Unit tests for the plugin self-update script (scripts/self_update.js) — the
// mechanics behind /update-agentex step 0: identity derivation from the install
// path, marketplace cache refresh + version check, and the consent-gated pull with
// deterministic post-pull verification. Run: node scripts/self_update.test.js
//
// The `claude` CLI is injected as a stub (runCli) — no test touches the network or
// the real CLI (lib/tracker adapter/test precedent). Fixture names are obviously
// fake (test-marketplace/test-plugin): the real names are derived at runtime.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const su = require('./self_update.js');

const SELF = path.join(__dirname, 'self_update.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── fixture helpers ───────────────────────────────────────────────────────────
// A fake installed-plugin layout: <tmp>/plugins/cache/<m>/<p>/<v>/ with its
// plugin.json, plus (optionally) <tmp>/plugins/marketplaces/<m>/.claude-plugin/
// marketplace.json — the refreshed-cache comparison source.
function makeInstall(opts = {}) {
  const {
    marketplace = 'test-marketplace', plugin = 'test-plugin',
    installed = '1.2.3', manifestName = plugin,
    latest, entry, marketplaceJson,
  } = opts;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-su-'));
  const pluginsHome = path.join(home, 'plugins');
  const pluginRoot = path.join(pluginsHome, 'cache', marketplace, plugin, installed);
  writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    { name: manifestName, version: installed });
  if (latest !== undefined || entry !== undefined || marketplaceJson !== undefined) {
    const mp = marketplaceJson !== undefined ? marketplaceJson
      : { name: marketplace, plugins: [entry !== undefined ? entry : { name: plugin, version: latest }] };
    writeJson(path.join(pluginsHome, 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json'), mp);
  }
  return { home, pluginsHome, pluginRoot, marketplace, plugin };
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Recording CLI stub. `responses` is either { marketplace: {...}, update: {...} }
// keyed on args[1], or a function (args, opts) => response for side effects.
function stubCli(responses = {}) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, opts });
    const r = typeof responses === 'function'
      ? responses(args, opts) : (responses[args[1]] || {});
    return { ok: true, timedOut: false, status: 0, stdout: '', stderr: '', ...r };
  };
  fn.calls = calls;
  return fn;
}

// Every branch goes through main() so the one-JSON-line discipline is asserted
// on the exact line the CLI entry would print.
const ALL_LINES = [];
function run(argv, deps) {
  const { line, exitCode } = su.main(argv, deps);
  ALL_LINES.push(line);
  return { json: JSON.parse(line), line, exitCode };
}

// ── identity derivation: parseInstallPath ─────────────────────────────────────
test('parseInstallPath: win32 backslash cache path', () => {
  assert.deepStrictEqual(
    su.parseInstallPath('C:\\Users\\x\\.claude\\plugins\\cache\\test-marketplace\\test-plugin\\1.2.3'),
    { pluginsHome: 'C:\\Users\\x\\.claude\\plugins', marketplace: 'test-marketplace', plugin: 'test-plugin', version: '1.2.3' });
});

test('parseInstallPath: POSIX cache path', () => {
  assert.deepStrictEqual(
    su.parseInstallPath('/home/x/.claude/plugins/cache/test-marketplace/test-plugin/1.2.3'),
    { pluginsHome: '/home/x/.claude/plugins', marketplace: 'test-marketplace', plugin: 'test-plugin', version: '1.2.3' });
});

test('parseInstallPath: dev clone and non-cache layouts are null', () => {
  assert.strictEqual(su.parseInstallPath('D:\\dev\\some-clone'), null);
  assert.strictEqual(su.parseInstallPath('/home/x/projects/some-clone'), null);
  assert.strictEqual(su.parseInstallPath('C:\\Users\\x\\.claude\\plugins\\repos\\m\\p\\1.0.0'), null);
  assert.strictEqual(su.parseInstallPath('/home/x/.claude/plugins/cache/only-two'), null);
  assert.strictEqual(su.parseInstallPath('/home/x/plugins/cache/extra/m/p/1.2.3'), null);
});

// ── composed CLI invocation: both platforms ───────────────────────────────────
test('buildCliCall: win32 goes through the shell as ONE composed command string, args EMPTY (DEP0190 pin), non-interactive stdio, timeout', () => {
  const call = su.buildCliCall(['plugin', 'marketplace', 'update', 'test-marketplace'],
    { platform: 'win32', timeoutMs: 60000 });
  assert.strictEqual(call.command, 'claude plugin marketplace update test-marketplace');
  assert.deepStrictEqual(call.args, [],
    "shell:true with a populated args array is Node's deprecated DEP0190 form (stderr DeprecationWarning) — the whole call must live in the command string");
  assert.strictEqual(call.options.shell, true);
  assert.strictEqual(call.options.timeout, 60000);
  assert.strictEqual(call.options.stdio[0], 'ignore', 'stdin closed — an interactive prompt must hang into the timeout, never stall');
});

test('buildCliCall: win32 quotes command-string tokens that need it (spaces, cmd metacharacters)', () => {
  const call = su.buildCliCall(['plugin', 'update', 'has space@test-marketplace'],
    { platform: 'win32', timeoutMs: 300000 });
  assert.strictEqual(call.command, 'claude plugin update "has space@test-marketplace"');
  assert.deepStrictEqual(call.args, []);
});

test('buildCliCall: POSIX platforms run the binary directly (shell:false, plain args array)', () => {
  const call = su.buildCliCall(['plugin', 'update', 'test-plugin@test-marketplace'],
    { platform: 'linux', timeoutMs: 300000 });
  assert.strictEqual(call.command, 'claude');
  assert.deepStrictEqual(call.args, ['plugin', 'update', 'test-plugin@test-marketplace']);
  assert.strictEqual(call.options.shell, false);
  assert.strictEqual(call.options.timeout, 300000);
});

// ── check: determinate branches ───────────────────────────────────────────────
test('check: newer version → update-available, exit 0, exact shape', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const cli = stubCli();
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: cli });
  assert.deepStrictEqual(r.json, {
    status: 'update-available', installed: '1.2.3', latest: '2.0.0',
    marketplace: 'test-marketplace', plugin: 'test-plugin',
  });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(cli.calls.length, 1, 'exactly one CLI call — the cache refresh');
  assert.deepStrictEqual(cli.calls[0].args, ['plugin', 'marketplace', 'update', 'test-marketplace']);
  assert.strictEqual(cli.calls[0].opts.timeoutMs, 60000);
});

test('check: equal versions → up-to-date, exit 0', () => {
  const fx = makeInstall({ latest: '1.2.3' });
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });
  assert.deepStrictEqual(r.json, {
    status: 'up-to-date', installed: '1.2.3', latest: '1.2.3',
    marketplace: 'test-marketplace', plugin: 'test-plugin',
  });
  assert.strictEqual(r.exitCode, 0);
});

test('check: installed ahead of marketplace → up-to-date + note, never a downgrade offer', () => {
  const fx = makeInstall({ installed: '1.2.3', latest: '1.0.0' });
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });
  assert.deepStrictEqual(r.json, {
    status: 'up-to-date', installed: '1.2.3', latest: '1.0.0',
    marketplace: 'test-marketplace', plugin: 'test-plugin', note: 'installed-ahead',
  });
  assert.strictEqual(r.exitCode, 0);
});

// ── check: unavailable branches (exit 2, exact status + reason) ───────────────
test('check: not a marketplace install (dev clone layout) → not-marketplace-install, no CLI call', () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-clone-'));
  writeJson(path.join(clone, '.claude-plugin', 'plugin.json'), { name: 'test-plugin', version: '1.2.3' });
  const cli = stubCli();
  const r = run(['check'], { pluginRoot: clone, runCli: cli });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'not-marketplace-install');
  assert.strictEqual(r.json.installed, '1.2.3');
  assert.strictEqual(r.exitCode, 2);
  assert.strictEqual(cli.calls.length, 0, 'no CLI call without a derived marketplace');
});

test('check: plugin.json name vs path segment mismatch → not-marketplace-install, no CLI call', () => {
  const fx = makeInstall({ manifestName: 'renamed-plugin', latest: '2.0.0' });
  const cli = stubCli();
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: cli });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'not-marketplace-install');
  assert.match(r.json.detail, /renamed-plugin/);
  assert.match(r.json.detail, /test-plugin/);
  assert.strictEqual(r.exitCode, 2);
  assert.strictEqual(cli.calls.length, 0);
});

test('check: cache refresh failure (offline) → cache-refresh-failed with command + stderr', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const r = run(['check'], {
    pluginRoot: fx.pluginRoot,
    runCli: stubCli({ marketplace: { ok: false, status: 1, stderr: 'network unreachable' } }),
  });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'cache-refresh-failed');
  assert.match(r.json.detail, /claude plugin marketplace update test-marketplace/);
  assert.match(r.json.detail, /network unreachable/);
  assert.strictEqual(r.json.installed, '1.2.3');
  assert.strictEqual(r.exitCode, 2);
});

test('check: cache refresh timeout (interactive hang) → cache-refresh-failed, named as a timeout', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const r = run(['check'], {
    pluginRoot: fx.pluginRoot,
    runCli: stubCli({ marketplace: { ok: false, timedOut: true } }),
  });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'cache-refresh-failed');
  assert.match(r.json.detail, /timed out/);
  assert.strictEqual(r.exitCode, 2);
});

test('check: marketplace.json missing after refresh → cache-missing', () => {
  const fx = makeInstall();   // no marketplace.json written
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'cache-missing');
  assert.match(r.json.detail, /marketplace\.json/);
  assert.strictEqual(r.exitCode, 2);
});

test('check: plugins[] entry missing → marketplace-entry-missing', () => {
  const fx = makeInstall({ marketplaceJson: { name: 'test-marketplace', plugins: [{ name: 'other-plugin', version: '9.9.9' }] } });
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'marketplace-entry-missing');
  assert.strictEqual(r.exitCode, 2);
});

test('check: entry without a version → marketplace-entry-missing', () => {
  const fx = makeInstall({ entry: { name: 'test-plugin' } });
  const r = run(['check'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });
  assert.strictEqual(r.json.status, 'check-unavailable');
  assert.strictEqual(r.json.reason, 'marketplace-entry-missing');
  assert.match(r.json.detail, /version/);
  assert.strictEqual(r.exitCode, 2);
});

test('check: unreadable own plugin.json → unexpected error, exit 1', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-empty-'));
  const r = run(['check'], { pluginRoot: empty, runCli: stubCli() });
  assert.strictEqual(r.json.status, 'error');
  assert.strictEqual(r.exitCode, 1);
});

// ── pull ──────────────────────────────────────────────────────────────────────
test('pull: success — composed update command, post-condition verified, from→to', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const cli = stubCli((args) => {
    if (args[1] === 'update') {
      // Simulate the CLI landing the new version in its own cache dir.
      writeJson(path.join(fx.pluginsHome, 'cache', 'test-marketplace', 'test-plugin', '2.0.0', '.claude-plugin', 'plugin.json'),
        { name: 'test-plugin', version: '2.0.0' });
      return { stdout: '✔ Plugin "test-plugin" updated from 1.2.3 to 2.0.0 for scope user. Restart to apply changes.\n' };
    }
    return {};
  });
  const r = run(['pull'], { pluginRoot: fx.pluginRoot, runCli: cli });
  assert.deepStrictEqual(r.json, { status: 'pulled', from: '1.2.3', to: '2.0.0' });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(cli.calls.length, 1);
  assert.deepStrictEqual(cli.calls[0].args, ['plugin', 'update', 'test-plugin@test-marketplace']);
  assert.strictEqual(cli.calls[0].opts.timeoutMs, 300000);
});

test('pull: CLI failure → pull-failed with command + captured stderr, exit 1', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const r = run(['pull'], {
    pluginRoot: fx.pluginRoot,
    runCli: stubCli({ update: { ok: false, status: 1, stderr: 'HTTP 403 forbidden' } }),
  });
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.match(r.json.detail, /claude plugin update test-plugin@test-marketplace/);
  assert.match(r.json.detail, /HTTP 403 forbidden/);
  assert.strictEqual(r.json.installed, '1.2.3');
  assert.strictEqual(r.exitCode, 1);
});

test('pull: CLI exit 0 but new versioned dir absent → pull-failed (fail closed)', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const r = run(['pull'], { pluginRoot: fx.pluginRoot, runCli: stubCli() });   // no side effect
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.match(r.json.detail, /2\.0\.0/);
  assert.strictEqual(r.json.installed, '1.2.3');
  assert.strictEqual(r.exitCode, 1);
});

test('pull: CLI exit 0 but landed version mismatches latest → pull-failed (fail closed)', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const cli = stubCli((args) => {
    if (args[1] === 'update') {
      writeJson(path.join(fx.pluginsHome, 'cache', 'test-marketplace', 'test-plugin', '2.0.0', '.claude-plugin', 'plugin.json'),
        { name: 'test-plugin', version: '1.9.9' });   // wrong content in the right dir
    }
    return {};
  });
  const r = run(['pull'], { pluginRoot: fx.pluginRoot, runCli: cli });
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.strictEqual(r.exitCode, 1);
});

test('pull: timeout → pull-failed, named as a timeout', () => {
  const fx = makeInstall({ latest: '2.0.0' });
  const r = run(['pull'], {
    pluginRoot: fx.pluginRoot,
    runCli: stubCli({ update: { ok: false, timedOut: true } }),
  });
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.match(r.json.detail, /timed out/);
  assert.strictEqual(r.exitCode, 1);
});

test('pull: re-derives identity itself — dev clone layout → pull-failed, no CLI call', () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-clone-'));
  writeJson(path.join(clone, '.claude-plugin', 'plugin.json'), { name: 'test-plugin', version: '1.2.3' });
  const cli = stubCli();
  const r = run(['pull'], { pluginRoot: clone, runCli: cli });
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(cli.calls.length, 0, 'no update without a derived identity');
});

test('pull: marketplace cache unreadable → pull-failed BEFORE any install (no blind pull)', () => {
  const fx = makeInstall();   // no marketplace.json — no known latest to verify against
  const cli = stubCli();
  const r = run(['pull'], { pluginRoot: fx.pluginRoot, runCli: cli });
  assert.strictEqual(r.json.status, 'pull-failed');
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(cli.calls.length, 0);
});

// ── CLI surface ───────────────────────────────────────────────────────────────
test('unknown or missing subcommand → error, exit 1', () => {
  assert.strictEqual(run(['bogus'], {}).exitCode, 1);
  assert.strictEqual(run([], {}).exitCode, 1);
  assert.strictEqual(run(['bogus'], {}).json.status, 'error');
});

test('end-to-end child process: this repo is a dev clone → one JSON line, exit 2', () => {
  let out, code = 0;
  try { out = execFileSync(process.execPath, [SELF, 'check'], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout; code = e.status; }
  assert.strictEqual(code, 2);
  const lines = out.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 1, 'exactly one stdout line');
  const json = JSON.parse(lines[0]);
  assert.strictEqual(json.status, 'check-unavailable');
  assert.strictEqual(json.reason, 'not-marketplace-install');
});

// ── one-JSON-line discipline + structural pins ────────────────────────────────
test('every branch printed a single-line JSON object', () => {
  assert.ok(ALL_LINES.length >= 20, 'branches were collected');
  for (const line of ALL_LINES) {
    assert.ok(!line.includes('\n'), `multi-line output: ${line}`);
    const parsed = JSON.parse(line);
    assert.strictEqual(typeof parsed, 'object');
    assert.ok(parsed.status, 'every line carries a status');
  }
});

test('structural: the script never calls process.exit() (exitCode + drain doctrine)', () => {
  const src = fs.readFileSync(SELF, 'utf8');
  assert.ok(!src.includes('process.exit('), 'use process.exitCode, never process.exit()');
});

test('generic: no real marketplace or plugin name hardcoded in the script', () => {
  const src = fs.readFileSync(SELF, 'utf8');
  assert.ok(!/agentex/i.test(src.replace(/^\/\/.*$/gm, '')), 'identity is derived, never hardcoded');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
