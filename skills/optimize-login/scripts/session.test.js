'use strict';
// Tests for session.js — how it finds playwright, which browser it launches, and whether it
// ever leaves one running. The browser itself is faked: this repo has no node_modules and a
// test must never depend on a Chromium install.
// Run: node skills/optimize-login/scripts/session.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SESSION = path.join(__dirname, 'session.js');
let passed = 0; const failures = [];
// Queued, then run in order at the bottom: some cases are async (assert.rejects).
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// A stand-in for the playwright package, installed into the FAKE PROJECT's node_modules —
// which is the point of the test: the real package never sits next to the plugin.
const FAKE_PW = `
const fs = require('fs');
const mode = () => process.env.FAKE_PW_MODE || 'ok';
const log = ev => {
  const p = process.env.FAKE_PW_LOG;
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  a.push(ev);
  fs.writeFileSync(p, JSON.stringify(a));
};
const chromium = {
  async launch(opts) {
    log({ launch: opts });
    if (mode() === 'launch-throw') {
      throw new Error('Chromium distribution "' + (opts.channel || 'chromium') + '" is not found\\nsecond line of the stack');
    }
    return {
      async newContext(o) {
        log({ newContext: { storageState: o.storageState, viewport: o.viewport } });
        return {
          async newPage() {
            return {
              url: () => 'https://app.example.test/dashboard',
              async goto(u) {
                log({ goto: u });
                if (mode() === 'goto-throw') throw new Error('page.goto: net::ERR_ABORTED\\nCall log:\\n  navigating');
              },
              async waitForLoadState() {},
              async waitForTimeout() {},
              locator() { return { async count() { return mode() === 'not-authenticated' ? 1 : 0; } }; },
            };
          },
          async storageState(o) {
            log({ storageState: o.path });
            fs.writeFileSync(o.path, JSON.stringify({ cookies: [{ name: 'sid' }], origins: [] }));
          },
        };
      },
      async close() { log({ close: true }); },
    };
  },
};
module.exports = { chromium, __fake: true };
`;

// Calls resumeSession as a LIBRARY (what an executor does), printing one line.
const DRIVER = `
const s = require(process.env.SESSION_JS);
(async () => {
  try {
    const r = await s.resumeSession({
      statePath: process.env.STATE,
      url: 'https://app.example.test/',
      landmark: { absent: '#login' },
      timeoutMs: 0,
      channel: process.env.WANT_CHANNEL || undefined,
    });
    await r.browser.close();
    console.log('OK loaded=' + (s.loadPlaywright().__fake === true));
  } catch (e) { console.log('ERR ' + String(e.message).split('\\n')[0]); }
})();
`;

// A project with a saved session, and playwright installed unless withPlaywright is false.
function project({ withPlaywright = true, withState = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-session-'));
  if (withPlaywright) {
    const pw = path.join(dir, 'node_modules', 'playwright');
    fs.mkdirSync(pw, { recursive: true });
    fs.writeFileSync(path.join(pw, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0-fake', main: 'index.js' }));
    fs.writeFileSync(path.join(pw, 'index.js'), FAKE_PW);
  }
  const state = path.join(dir, 'test', '.auth', 'demo-qa-state.json');
  if (withState) {
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ cookies: [{ name: 'sid' }], origins: [] }));
  }
  fs.writeFileSync(path.join(dir, 'drive.js'), DRIVER);
  return { dir, state, log: path.join(dir, 'pw.json') };
}

const events = p => (fs.existsSync(p.log) ? JSON.parse(fs.readFileSync(p.log, 'utf8')) : []);
const pick = (p, key) => events(p).filter(e => key in e).map(e => e[key]);

function run(p, args, env = {}) {
  // NODE_PATH deliberately unset: resolution must come from the project itself.
  const base = { ...process.env, FAKE_PW_LOG: p.log, SESSION_JS: SESSION, STATE: p.state };
  delete base.NODE_PATH;
  delete base.PLAYWRIGHT_CHANNEL;
  delete base.HEADED;
  try {
    const stdout = execFileSync(process.execPath, args, { cwd: p.dir, encoding: 'utf8', env: { ...base, ...env } });
    return { code: 0, out: stdout.trim() };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}`.trim() };
  }
}
const cli = (p, extra = [], env = {}) => run(p, [SESSION, 'resume', '--state', p.state, '--url', 'https://app.example.test/', '--absent', '#login', ...extra], env);
const lib = (p, env = {}) => run(p, ['drive.js'], env);

// ── finding playwright ───────────────────────────────────────────────────────
// The plugin is installed under ~/.claude/plugins; a bare require() from this file walks the
// PLUGIN's tree, so a project that has playwright still failed with "Cannot find module".
test('playwright is resolved from the project, not from the plugin directory', () => {
  const p = project();
  const { code, out } = cli(p);
  assert.strictEqual(code, 0, out);
  assert.match(out, /RESULT: RESUME_PASS/);
});

test('a monorepo install one level up is still found', () => {
  const root = project();                       // playwright lives here
  const sub = path.join(root.dir, 'packages', 'web-qa');
  fs.mkdirSync(sub, { recursive: true });
  fs.copyFileSync(path.join(root.dir, 'drive.js'), path.join(sub, 'drive.js'));
  const { code, out } = run({ ...root, dir: sub }, [SESSION, 'resume', '--state', root.state,
    '--url', 'https://app.example.test/', '--absent', '#login']);
  assert.strictEqual(code, 0, out);
  assert.match(out, /RESULT: RESUME_PASS/);
});

test('a missing playwright gives one actionable line, not a module stack', () => {
  const p = project({ withPlaywright: false });
  const { code, out } = cli(p);
  assert.strictEqual(code, 1);
  assert.match(out, /npm i -D playwright/);
  assert.match(out, /playwright install chromium/);
  assert.ok(out.includes(p.dir), 'names the project it looked in');
  assert.ok(!/Cannot find module/.test(out), 'no raw resolver error');
  assert.ok(!/at Object\.|at Module\./.test(out), 'no stack frames');
  assert.match(out, /RESULT: RESUME_FAIL/);
});

test('the library entry point loads the project package too', () => {
  const p = project();
  const { code, out } = lib(p);
  assert.strictEqual(code, 0, out);
  assert.match(out, /^OK loaded=true$/m);
});

// ── which browser ────────────────────────────────────────────────────────────
// `channel: 'chrome'` was hardcoded, so the script demanded a Google Chrome INSTALL even
// where `npx playwright install chromium` had already provided a working browser.
test('the default launch asks for no channel — bundled Chromium is enough', () => {
  const p = project();
  cli(p);
  const launches = pick(p, 'launch');
  assert.strictEqual(launches.length, 1);
  assert.ok(!('channel' in launches[0]), `no channel demanded, got ${JSON.stringify(launches[0])}`);
  assert.strictEqual(launches[0].headless, true);
});

test('--channel and --headed are honoured', () => {
  const p = project();
  cli(p, ['--channel', 'msedge', '--headed']);
  assert.deepStrictEqual(pick(p, 'launch'), [{ headless: false, channel: 'msedge' }]);
});

test('PLAYWRIGHT_CHANNEL works for callers that cannot pass a flag', () => {
  const p = project();
  cli(p, [], { PLAYWRIGHT_CHANNEL: 'chrome' });
  assert.deepStrictEqual(pick(p, 'launch'), [{ headless: true, channel: 'chrome' }]);
});

// An explicitly requested browser is never quietly swapped for another one.
test('a requested channel that will not launch is an error, not a substitution', () => {
  const p = project();
  const { code, out } = cli(p, ['--channel', 'chrome'], { FAKE_PW_MODE: 'launch-throw' });
  assert.strictEqual(code, 1);
  assert.match(out, /"chrome"/);
  assert.match(out, /nothing was substituted/);
  assert.strictEqual(pick(p, 'launch').length, 1, 'no second, silent launch');
  assert.match(out, /RESULT: RESUME_FAIL/);
});

test('with no channel asked for, a launch failure points at the install command', () => {
  const p = project();
  const { out } = cli(p, [], { FAKE_PW_MODE: 'launch-throw' });
  assert.match(out, /playwright install chromium/);
  assert.ok(!/substituted/.test(out));
});

// ── never leave a browser running ────────────────────────────────────────────
// Only the landmark check used to close the browser: a bad URL or a goto timeout left a
// headless browser alive for the rest of the run, one per attempt.
test('a goto failure closes the browser it opened', () => {
  const p = project();
  const { code, out } = cli(p, [], { FAKE_PW_MODE: 'goto-throw' });
  assert.strictEqual(code, 1);
  assert.strictEqual(pick(p, 'close').length, 1, 'browser closed');
  assert.match(out, /ERR_ABORTED/);
  assert.match(out, /RESULT: RESUME_FAIL/);
});

test('a dead session closes the browser and says to log in again', () => {
  const p = project();
  const { code, out } = lib(p, { FAKE_PW_MODE: 'not-authenticated' });
  assert.strictEqual(code, 0, out);
  assert.match(out, /^ERR session not restored .* log in again$/m);
  assert.strictEqual(pick(p, 'close').length, 1);
});

test('no state file: nothing is launched at all', () => {
  const p = project({ withState: false });
  const { code, out } = cli(p);
  assert.strictEqual(code, 1);
  assert.match(out, /log in first/);
  assert.strictEqual(pick(p, 'launch').length, 0, 'a missing file needs no browser');
});

test('a live session refreshes the state file, then closes the browser', () => {
  const p = project();
  const { code, out } = cli(p);
  assert.strictEqual(code, 0, out);
  assert.deepStrictEqual(pick(p, 'storageState'), [p.state], 'idle clock restarted on use');
  assert.strictEqual(pick(p, 'close').length, 1);
  assert.match(out, /session alive \(saved [\d.]+ min ago\)/);
});

// ── the landmark rules, with no browser involved ─────────────────────────────
const { isAuthenticated, saveSession } = require('./session.js');
const fakePage = (counts) => ({
  url: () => 'https://app.example.test/login?returnUrl=/dashboard',
  locator: (sel) => ({ count: async () => counts[sel] }),
  waitForTimeout: async () => {},
  context: () => ({ storageState: async () => {} }),
});

test('a landmark is required — a URL is never proof of a login', async () => {
  await assert.rejects(() => isAuthenticated(fakePage({}), {}), /never verified by URL/);
  await assert.rejects(() => isAuthenticated(fakePage({}), null), /never verified by URL/);
});

test('saveSession refuses to write a state file from a page that is not logged in', async () => {
  await assert.rejects(
    () => saveSession(fakePage({ '#login': 1 }), { statePath: path.join(os.tmpdir(), 'never.json'), landmark: { absent: '#login' }, timeoutMs: 0 }),
    /refusing to save/);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'never.json')));
});

// ── CLI argument guards ──────────────────────────────────────────────────────
test('the CLI insists on a state, a url and a landmark', () => {
  const p = project();
  for (const [args, re] of [
    [['resume', '--url', 'https://x.test/', '--absent', '#l'], /--state and --url are required/],
    [['resume', '--state', p.state, '--absent', '#l'], /--state and --url are required/],
    [['resume', '--state', p.state, '--url', 'https://x.test/'], /--present or --absent is required/],
  ]) {
    const { code, out } = run(p, [SESSION, ...args]);
    assert.strictEqual(code, 1);
    assert.match(out, re);
    assert.match(out, /RESULT: RESUME_FAIL/);
  }
});

const finish = () => {
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
};
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
  }
  finish();
})();
