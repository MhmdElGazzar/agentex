'use strict';
// Self-contained test: covers argument-parsing / BLOCKED paths without needing a live Appium
// server, a device, or webdriverio installed. Run: node appium_client.test.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, 'appium_client.js');
let passed = 0;

function run(args, cwd) {
  const r = spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', cwd: cwd || __dirname });
  return { code: r.status, json: JSON.parse(r.stdout.trim()) };
}

let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { failed++; process.exitCode = 1; console.error('  FAIL -', name + ':', e.message); }
}

// A cwd with no node_modules/webdriverio at all, so resolution always fails deterministically
// regardless of whether webdriverio happens to be installed somewhere above this repo.
const bareCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mobile-test-'));

test('no subcommand -> BLOCKED, exit 2', () => {
  const r = run([], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('unknown subcommand -> BLOCKED, exit 2', () => {
  const r = run(['not-a-command'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('webdriverio not installed -> BLOCKED, exit 2, with install hint', () => {
  const r = run(['create-session', '--caps-file', 'caps.json'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /webdriverio/);
});

// Fake a resolvable "webdriverio" so we can reach the flag-validation branches below it.
const fakeModulesDir = path.join(bareCwd, 'node_modules', 'webdriverio');
fs.mkdirSync(fakeModulesDir, { recursive: true });
fs.writeFileSync(path.join(fakeModulesDir, 'package.json'), JSON.stringify({ name: 'webdriverio', main: 'index.js' }));
fs.writeFileSync(path.join(fakeModulesDir, 'index.js'), 'module.exports = { remote: async () => { throw new Error("no server"); }, attach: async () => { throw new Error("no server"); } };');

test('create-session missing --caps-file -> BLOCKED, exit 2', () => {
  const r = run(['create-session'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('create-session with missing caps file path -> BLOCKED, exit 2', () => {
  const r = run(['create-session', '--caps-file', 'does-not-exist.json'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /not found/);
});

test('create-session with invalid JSON caps file -> BLOCKED, exit 2', () => {
  const badCaps = path.join(bareCwd, 'bad-caps.json');
  fs.writeFileSync(badCaps, '{ not valid json');
  const r = run(['create-session', '--caps-file', badCaps], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /invalid JSON/);
});

test('find missing --session -> BLOCKED, exit 2', () => {
  const r = run(['find', '--using', 'accessibility id', '--value', 'x'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

// ---- a behaving fake: emulates webdriverio's stdout chatter unless logLevel is 'silent',
// records the options remote()/attach() received, and can fail like a dead server/session.
// FAKE_WDIO_MODE: ok | econnrefused | invalid-session | no-such-element | echo-error
const optsLog = path.join(bareCwd, 'wdio-opts.jsonl');
fs.writeFileSync(path.join(fakeModulesDir, 'index.js'), `
const fs = require('fs');
const mode = () => process.env.FAKE_WDIO_MODE || 'ok';
function record(kind, o) { fs.appendFileSync(${JSON.stringify(optsLog)}, JSON.stringify({ kind, logLevel: o.logLevel, capabilities: o.capabilities }) + '\\n'); }
function chatter(o, line) { if (o.logLevel !== 'silent') console.log(line); }
function infra() {
  if (mode() === 'econnrefused') { const e = new Error('Request failed with error code ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
  if (mode() === 'invalid-session') { const e = new Error('A session is either terminated or not started'); e.name = 'invalid session id'; throw e; }
  if (mode() === 'unable-to-connect') { throw new Error('Unable to connect to "http://127.0.0.1:4798/", make sure browser driver is running on that address.'); }
}
function browser(o) {
  return {
    sessionId: 'sess-1',
    async elementSendKeys(el, text) {
      chatter(o, 'INFO webdriver: COMMAND elementSendKeys("' + el + '", "' + text + '")');
      chatter(o, 'INFO webdriver: DATA { text: \\'' + text + '\\' }');
      infra();
      if (mode() === 'echo-error') throw new Error('WebDriverError: boom when running "value" with method "POST" and args "{text:' + text + '}"');
    },
    async findElement() {
      infra();
      if (mode() === 'no-such-element') { const e = new Error('An element could not be located on the page'); e.name = 'no such element'; throw e; }
      return { 'element-6066-11e4-a52e-4f735466cecf': 'el-1' };
    },
  };
}
module.exports = {
  remote: async (o) => { record('remote', o); chatter(o, 'INFO webdriver: Initiate new session'); infra(); return browser(o); },
  attach: async (o) => { record('attach', o); chatter(o, 'INFO webdriver: attach'); return browser(o); },
};
`);

function runRaw(args, env) {
  const r = spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', cwd: bareCwd, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const SECRET = 'S3cr3t-Pa55';
const oneJsonLine = (stdout) => {
  const lines = stdout.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `stdout must be exactly one line, got:\n${stdout}`);
  return JSON.parse(lines[0]);
};
const caps = path.join(bareCwd, 'caps.json');
fs.writeFileSync(caps, JSON.stringify({ capabilities: { alwaysMatch: { platformName: 'Android' } } }));

test('every remote()/attach() call passes logLevel "silent"', () => {
  fs.rmSync(optsLog, { force: true });
  runRaw(['create-session', '--caps-file', caps], {});
  runRaw(['find', '--session', 's', '--using', 'id', '--value', 'x'], {});
  const calls = fs.readFileSync(optsLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(calls.map(c => c.kind).sort(), ['attach', 'remote']);
  for (const c of calls) assert.strictEqual(c.logLevel, 'silent', `${c.kind} must be silent`);
});

const remoteCaps = (capsObj, extra = []) => {
  fs.rmSync(optsLog, { force: true });
  const f = path.join(bareCwd, 'caps-reset.json');
  fs.writeFileSync(f, JSON.stringify({ capabilities: { alwaysMatch: capsObj } }));
  const r = runRaw(['create-session', '--caps-file', f, ...extra], {});
  const calls = fs.existsSync(optsLog) ? fs.readFileSync(optsLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { r, calls };
};

test('create-session adds appium:noReset true when the caps leave it out', () => {
  const { r, calls } = remoteCaps({ platformName: 'Android' });
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(calls[0].capabilities['appium:noReset'], true);
});

test('create-session refuses a reset (fullReset true / noReset false) without --allow-reset', () => {
  for (const c of [{ 'appium:fullReset': true }, { 'appium:noReset': false }]) {
    const { r, calls } = remoteCaps({ platformName: 'Android', ...c });
    assert.strictEqual(r.code, 2, JSON.stringify(c));
    assert.strictEqual(oneJsonLine(r.stdout).result, 'BLOCKED');
    assert.match(r.stdout, /--allow-reset/);
    assert.strictEqual(calls.length, 0, 'no session may be created');
  }
});

test('create-session --allow-reset passes an approved reset through unchanged', () => {
  const { r, calls } = remoteCaps({ platformName: 'Android', 'appium:noReset': false }, ['--allow-reset']);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.strictEqual(calls[0].capabilities['appium:noReset'], false);
});

test('send-keys --text: stdout is one JSON line and never contains the typed text', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text', SECRET], {});
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(oneJsonLine(r.stdout), { result: 'PASS' });
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'the typed text must not be echoed');
});

test('send-keys --text-env NAME: value comes from the environment and is never printed', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text-env', 'QA_PIN'], { QA_PIN: SECRET });
  assert.strictEqual(r.code, 0, r.stdout);
  assert.deepStrictEqual(oneJsonLine(r.stdout), { result: 'PASS' });
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
});

test('send-keys --text-env NAME: value comes from the project .env', () => {
  fs.writeFileSync(path.join(bareCwd, '.env'), `QA_ENV_FILE_PIN="${SECRET}"\n`);
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text-env', 'QA_ENV_FILE_PIN'], {});
  fs.rmSync(path.join(bareCwd, '.env'));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(!r.stdout.includes(SECRET));
});

test('send-keys --text-env with an unset variable -> BLOCKED naming the variable', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text-env', 'QA_NOT_SET_ANYWHERE'], {});
  assert.strictEqual(r.code, 2);
  const j = oneJsonLine(r.stdout);
  assert.strictEqual(j.result, 'BLOCKED');
  assert.match(j.reason, /QA_NOT_SET_ANYWHERE/);
});

test('send-keys --text-env with an invalid variable name -> BLOCKED', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text-env', 'A.*'], {});
  assert.strictEqual(r.code, 2);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'BLOCKED');
});

test('send-keys with both --text and --text-env -> BLOCKED', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text', 'a', '--text-env', 'QA_PIN'], { QA_PIN: 'b' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'BLOCKED');
});

test('an error message that echoes the typed text is redacted', () => {
  const r = runRaw(['send-keys', '--session', 's', '--element', 'e', '--text-env', 'QA_PIN'], { QA_PIN: SECRET, FAKE_WDIO_MODE: 'echo-error' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'FAIL');
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'secret leaked through the error reason');
});

// ---- infrastructure vs defect: the app never answered -> BLOCKED (exit 2), not FAIL ----
test('server unreachable (ECONNREFUSED) on create-session -> BLOCKED infrastructure, exit 2', () => {
  const r = runRaw(['create-session', '--caps-file', caps], { FAKE_WDIO_MODE: 'econnrefused' });
  assert.strictEqual(r.code, 2);
  const j = oneJsonLine(r.stdout);
  assert.strictEqual(j.result, 'BLOCKED');
  assert.strictEqual(j.infrastructure, true);
  assert.match(j.reason, /infrastructure/i);
});

test('server unreachable (ECONNREFUSED) on find -> BLOCKED infrastructure, exit 2', () => {
  const r = runRaw(['find', '--session', 's', '--using', 'id', '--value', 'x'], { FAKE_WDIO_MODE: 'econnrefused' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'BLOCKED');
});

test('server down as webdriverio reports it on session create ("Unable to connect") -> BLOCKED, exit 2', () => {
  const r = runRaw(['create-session', '--caps-file', caps], { FAKE_WDIO_MODE: 'unable-to-connect' });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'BLOCKED');
});

test('dead / invalid session -> BLOCKED infrastructure, exit 2', () => {
  const r = runRaw(['find', '--session', 'gone', '--using', 'id', '--value', 'x'], { FAKE_WDIO_MODE: 'invalid-session' });
  assert.strictEqual(r.code, 2);
  const j = oneJsonLine(r.stdout);
  assert.strictEqual(j.result, 'BLOCKED');
  assert.strictEqual(j.infrastructure, true);
});

test('element not found (the app answered) stays FAIL, exit 1', () => {
  const r = runRaw(['find', '--session', 's', '--using', 'id', '--value', 'x'], { FAKE_WDIO_MODE: 'no-such-element' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(oneJsonLine(r.stdout).result, 'FAIL');
});

test('find happy path -> PASS with the element id, one JSON line', () => {
  const r = runRaw(['find', '--session', 's', '--using', 'id', '--value', 'x'], {});
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(oneJsonLine(r.stdout), { result: 'PASS', element: 'el-1' });
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(bareCwd, { recursive: true, force: true });
