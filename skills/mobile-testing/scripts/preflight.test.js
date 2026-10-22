'use strict';
// Tests for the mobile preflight.js — one JSON line, exit 0 (informational), and the
// appium probe must NEVER download appium: plain `npx appium --version` silently fetched
// appium from npm (~29 s) and reported ok for a project without it.
// Run: node skills/mobile-testing/scripts/preflight.test.js
// Hermetic: PATH holds only a fake `npx` (and node), so no real tool is probed or fetched.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'preflight.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mobile-preflight-'));
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(binDir);
const argsLog = path.join(tmp, 'npx-args.log');
// Fake npx: records its argv; "installed" only when FAKE_APPIUM_INSTALLED=1. Without
// --no-install it behaves like real npx would on a cache miss: "downloads" and succeeds.
fs.writeFileSync(path.join(binDir, 'npx'), `#!/bin/sh
echo "$@" >> "${argsLog}"
case " $* " in
  *" --no-install "*)
    if [ "$FAKE_APPIUM_INSTALLED" = "1" ]; then echo "3.8.0"; exit 0; fi
    echo "npm ERR! npx canceled due to missing packages and no YES option: [\\"appium\\"]" >&2; exit 1 ;;
  *) echo "3.8.0 (downloaded)"; exit 0 ;;
esac
`, { mode: 0o755 });

function runPreflight(env) {
  fs.rmSync(argsLog, { force: true });
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8', cwd: tmp,
    env: { PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`, ...env },
  });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null };
}

if (process.platform === 'win32') {
  console.log('  skip - fake npx is a POSIX shell script');
} else {
  test('appium is probed with `npx --no-install`, never a bare `npx appium`', () => {
    runPreflight({});
    const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n');
    const appiumCalls = calls.filter((c) => /\bappium\b/.test(c));
    assert.ok(appiumCalls.length >= 1, 'appium was probed');
    for (const c of appiumCalls) assert.match(c, /^--no-install appium --version$/, `unsafe probe: ${c}`);
  });

  test('appium not installed in the project -> appium.ok false (not a silent download), exit 0', () => {
    const r = runPreflight({});
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.lines.length, 1, 'exactly one JSON line');
    assert.strictEqual(r.json.appium.ok, false);
  });

  test('appium installed -> appium.ok true with its version', () => {
    const r = runPreflight({ FAKE_APPIUM_INSTALLED: '1' });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.appium.ok, true);
    assert.strictEqual(r.json.appium.version, '3.8.0');
  });

  test('every tool key is reported; missing tools are ok:false, never a crash', () => {
    const r = runPreflight({});
    for (const k of ['node', 'appium', 'adb', 'xcrun', 'curl']) assert.ok(r.json[k], `${k} reported`);
    assert.strictEqual(r.json.node.ok, true);
    assert.strictEqual(r.json.adb.ok, false);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
