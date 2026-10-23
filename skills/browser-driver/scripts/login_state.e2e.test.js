'use strict';
// e2e group 1: the saved login (login_state.js) against the REAL @playwright/cli and a real
// headless Chromium, on a local sign-in app (127.0.0.1, ephemeral port). Skips (exit 77) when
// Playwright, the CLI or Chromium is not found; AGENTEX_E2E_REQUIRE=1 makes that a failure.
// Run: node skills/browser-driver/scripts/login_state.e2e.test.js
// Time: about 25 s, bounded by login_state.js's own fixed 15 s landmark wait on the stale case.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require(path.join(__dirname, '..', '..', '..', 'scripts', 'dev', 'e2e', 'harness.js'));

h.requireDeps();
const LOGIN_STATE = path.join(__dirname, 'login_state.js');
const proj = h.project({
  files: {
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { portalUrl: 'http://127.0.0.1/', users: { buyer: {}, ci: {} } },
  },
});
const STATE = 'test/.auth/qa-buyer-state.json';
const outputs = [];                                   // everything the CLI and the script printed
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(proj.dir, rel))).digest('hex');
const posix = process.platform !== 'win32';

async function loginState(args, extraEnv = {}) {
  const r = await h.exec(process.execPath, [LOGIN_STATE, ...args], { cwd: proj.dir, env: proj.env(extraEnv) });
  outputs.push(r.out);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  let json = {};
  try { json = JSON.parse(line); } catch { assert.fail(`login_state.js printed no JSON line: ${h.mask(r.out).slice(-300)}`); }
  return { ...r, json };
}

let fx; let first; let second;
const cases = [
  ['UI login, then `save --present "#account-menu"` is SAVED: file 0600, an HttpOnly sid and the token in it, sidecar written', async () => {
    fx = await h.startFixture();
    first = h.cliSession(proj);
    outputs.push((await first.open(`${fx.origin}/login`)).out);
    outputs.push((await first.pw('click', '#sign-in')).out);
    const r = await loginState(['save', '--session', first.name, '--user', 'buyer', '--present', '#account-menu']);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.result, 'SAVED');
    assert.strictEqual(r.json.path, STATE);
    if (posix) assert.strictEqual(fs.statSync(path.join(proj.dir, STATE)).mode & 0o777, 0o600, 'the login file is 0600');
    // The real CLI wrote real storageState: the HttpOnly cookie round-tripped with the token.
    const saved = JSON.parse(proj.read(STATE));
    const sid = saved.cookies.find((c) => c.name === 'sid');
    assert.ok(sid && sid.httpOnly === true, 'the HttpOnly sid cookie is in the saved login');
    const items = (saved.origins.find((o) => o.origin === fx.origin) || { localStorage: [] }).localStorage;
    assert.ok(items.some((i) => i.name === 'token'), 'the localStorage token is in the saved login');
    const meta = JSON.parse(proj.read('test/.auth/qa-buyer-state.meta.json'));
    assert.strictEqual(meta.url, `${fx.origin}/`);
    assert.deepStrictEqual(meta.landmark, { present: '#account-menu' });
    assert.ok(!Number.isNaN(Date.parse(meta.savedAt)));
    await first.close();
  }],

  ['a NEW session: `load` is RESUME_PASS (landmark held), and no second login happened', async () => {
    second = h.cliSession(proj);
    outputs.push((await second.open()).out);
    const r = await loginState(['load', '--session', second.name, '--user', 'buyer']);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.result, 'RESUME_PASS');
    assert.strictEqual(fx.requests().filter((q) => q === 'POST /login').length, 1, 'the saved login replaced the login, there was no second POST /login');
    assert.ok(fx.requests().includes('GET /'), 'the page was really loaded');
  }],

  ['AGENTEX_CI=1 `save` is SKIPPED ci-mode and writes no file, even with a signed-in session', async () => {
    const r = await loginState(['save', '--session', second.name, '--user', 'ci', '--present', '#account-menu'], { AGENTEX_CI: '1' });
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.result, 'SKIPPED');
    assert.strictEqual(r.json.reason, 'ci-mode');
    assert.ok(!proj.exists('test/.auth/qa-ci-state.json'), 'no login file');
    assert.ok(!proj.exists('test/.auth/qa-ci-state.meta.json'), 'no sidecar');
  }],

  ['the server invalidates the session: `load` is RESUME_FAIL landmark-failed, cookies are cleared, the file is untouched (waits 15 s)', async () => {
    const before = sha(STATE);
    fx.invalidate();
    const r = await loginState(['load', '--session', second.name, '--user', 'buyer']);
    assert.strictEqual(r.status, 1, r.out);
    assert.strictEqual(r.json.result, 'RESUME_FAIL');
    assert.strictEqual(r.json.reason, 'landmark-failed');
    assert.strictEqual(sha(STATE), before, 'load never writes the login file');
    const cookies = await second.pw('cookie-list');
    outputs.push(cookies.out);
    assert.doesNotMatch(cookies.out, /\bsid\b/, 'the dead login was cleared from the browser');
    await second.close();
  }],

  ['CSRF site, stale login: `load` is landmark-failed AND reloads the page, so the form login in the same session shows the normal rejection, never the 403 (waits 15 s)', async () => {
    fx.csrf(true);                                  // "/" is now the sign-in form with a csrf cookie
    const third = h.cliSession(proj);
    outputs.push((await third.open()).out);
    const r = await loginState(['load', '--session', third.name, '--user', 'buyer']);
    assert.strictEqual(r.status, 1, r.out);
    assert.strictEqual(r.json.reason, 'landmark-failed');
    assert.match(r.json.detail, /page was reloaded/);
    const cookies = await third.pw('cookie-list');
    outputs.push(cookies.out);
    assert.match(cookies.out, /\bcsrf\b/, 'the reload gave the form a fresh csrf cookie');
    outputs.push((await third.pw('fill', 'input[type=password]', 'wrong')).out);
    outputs.push((await third.pw('click', '#sign-in')).out);
    const text = await third.pw('eval', 'document.body.innerText');
    outputs.push(text.out);
    assert.doesNotMatch(text.out, /CSRF verification failed/, 'the form on the reloaded page is not rejected as a CSRF failure');
    assert.match(text.out, /Your email or password is incorrect!/);
    await third.close();
  }],

  ['negative control: clearing cookies WITHOUT a reload on the same CSRF form makes the submit a 403 (the fixture really models the defect)', async () => {
    const fourth = h.cliSession(proj);
    outputs.push((await fourth.open(`${fx.origin}/`)).out);
    outputs.push((await fourth.pw('cookie-clear')).out);
    outputs.push((await fourth.pw('localstorage-clear')).out);
    outputs.push((await fourth.pw('fill', 'input[type=password]', 'wrong')).out);
    outputs.push((await fourth.pw('click', '#sign-in')).out);
    const text = await fourth.pw('eval', 'document.body.innerText');
    outputs.push(text.out);
    assert.match(text.out, /CSRF verification failed/);
    assert.doesNotMatch(text.out, /Your email or password is incorrect!/);
    await fourth.close();
    fx.csrf(false);
  }],

  ['`load` on a session that was never opened is BLOCKED session-not-open, exit 2', async () => {
    const never = h.cliSession(proj);
    const r = await loginState(['load', '--session', never.name, '--user', 'buyer']);
    assert.strictEqual(r.status, 2, r.out);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.strictEqual(r.json.reason, 'session-not-open');
    assert.strictEqual(r.json.infrastructure, true);
  }],

  ['no cookie or token sentinel appears in any output, nor in any file but the saved login', () => {
    const { sids, tokens } = fx.issued();
    assert.ok(sids.length >= 1 && tokens.length >= 1);
    h.scanOutputs([...sids, ...tokens], outputs, proj.dir, { exclude: ['test/.auth'] });
  }],
];

h.run(cases);
