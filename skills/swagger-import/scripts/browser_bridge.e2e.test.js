'use strict';
// e2e group 2: `browser_bridge.js renew` in a real headless Chromium against a local sign-in
// app (127.0.0.1, ephemeral port). The saved login is made by a library browser after the real
// UI sign-in. Skips (exit 77) when Playwright, the CLI or Chromium is not found;
// AGENTEX_E2E_REQUIRE=1 makes that a failure.
// Run: node skills/swagger-import/scripts/browser_bridge.e2e.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require(path.join(__dirname, '..', '..', '..', 'scripts', 'dev', 'e2e', 'harness.js'));

const deps = h.requireDeps();
const BRIDGE = path.join(__dirname, 'browser_bridge.js');
const { statePathFor } = require(path.join(__dirname, '..', '..', 'browser-driver', 'scripts', 'login_state.js'));
const { findCli } = require(BRIDGE);
const proj = h.project({
  files: {
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { portalUrl: 'http://127.0.0.1/', users: { buyer: {}, seller: {}, locked: { disabled: 'test' } } },
  },
});
const abs = (rel) => path.join(proj.dir, rel);
const outputs = [];
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(abs(rel))).digest('hex');
const posix = process.platform !== 'win32';

// The saved login: a real UI sign-in in a library browser, saved as storageState.
async function saveLogin(fx, rel) {
  const lb = await h.libBrowser(proj);
  const context = await lb.context();
  const page = await context.newPage();
  await page.goto(`${fx.origin}/login`);
  await page.locator('#sign-in').click();
  await page.locator('#account-menu').waitFor({ state: 'visible', timeout: 10000 });
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  await context.storageState({ path: abs(rel) });
  await context.close();
  await lb.browser.close();
}

async function renew(fx, args, { user = 'buyer', store = 's' } = {}) {
  const base = ['renew', '--store', store, '--env', 'qa', '--user', user, '--url', `${fx.origin}/`, '--api-origin', fx.origin,
    '--present', '#account-menu', '--landmark-ms', '3000', '--wait-ms', '1500'];
  const r = await h.exec(process.execPath, [BRIDGE, ...base, ...args], { cwd: proj.dir, env: proj.env() });
  outputs.push(r.out);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() || '{}';
  let json = {};
  try { json = JSON.parse(line); } catch { assert.fail(`renew printed no JSON line: ${h.mask(r.out).slice(-300)}`); }
  return { ...r, json };
}

let fx; let idle; const BUYER = statePathFor('qa', 'buyer');
const cases = [
  ['the project resolves the real @playwright/cli through the plugin\'s own findCli', () => {
    const cli = findCli(proj.dir);
    assert.strictEqual(fs.realpathSync(cli.pre[0]), fs.realpathSync(deps.cli));
  }],

  ['live session: renewed, the token reaches --store (0600), the saved login\'s sha256 and mtime are unchanged', async () => {
    fx = await h.startFixture();
    await saveLogin(fx, BUYER);
    const before = { sha: sha(BUYER), mtime: fs.statSync(abs(BUYER)).mtimeMs };
    const r = await renew(fx, []);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.renewed, true, r.out);
    assert.strictEqual(r.json.token.delivered, 'store');
    assert.strictEqual(r.json.stateFile, BUYER);
    const store = path.join(proj.dir, 'test', '.auth', 'api-tokens');
    const files = fs.readdirSync(store);
    assert.strictEqual(files.length, 1, 'one token file');
    if (posix) assert.strictEqual(fs.statSync(path.join(store, files[0])).mode & 0o777, 0o600, 'the token file is 0600');
    assert.ok(fx.issued().tokens.some((t) => fs.readFileSync(path.join(store, files[0]), 'utf8').includes(t)), 'the app\'s own token is what was stored');
    assert.strictEqual(sha(BUYER), before.sha, 'the saved login is read only (content)');
    assert.strictEqual(fs.statSync(abs(BUYER)).mtimeMs, before.mtime, 'the saved login is read only (mtime)');
  }],

  ['a saved login under another name that carries both env and user (seller-qa-state.json) is picked', async () => {
    const odd = 'test/.auth/seller-qa-state.json';
    fs.copyFileSync(abs(BUYER), abs(odd));
    const r = await renew(fx, [], { user: 'seller', store: 's3' });
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.renewed, true, r.out);
    assert.strictEqual(r.json.stateFile, odd);
  }],

  ['the API answers 401 to the token (landmark holds): renewed:false no-token, the token was seen, nothing stored', async () => {
    fx.rejectApi(true);
    const r = await renew(fx, [], { store: 's2' });
    fx.rejectApi(false);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.renewed, false);
    assert.strictEqual(r.json.reason, 'no-token');
    assert.strictEqual(r.json.token.seen, true);
    assert.strictEqual(r.json.token.delivered, null);
    assert.ok(!fs.existsSync(abs('test/.auth/api-tokens/s2-qa.json')), 'no token file for the refused token');
  }],

  ['the server expired the session: renewed:false landmark-failed', async () => {
    fx.invalidate();
    const r = await renew(fx, [], { store: 's4' });
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.json.renewed, false);
    assert.strictEqual(r.json.reason, 'landmark-failed');
    assert.strictEqual(r.json.token.delivered, null);
  }],

  ['a disabled user: exit 2 user-disabled, and a second app sees zero requests (no browser was opened)', async () => {
    idle = await h.startFixture();
    fs.copyFileSync(abs(BUYER), abs(statePathFor('qa', 'locked'))); // a saved login exists, so only the check stops it
    const r = await renew(idle, [], { user: 'locked', store: 's5' });
    assert.strictEqual(r.status, 2, r.out);
    assert.strictEqual(r.json.error, 'user-disabled');
    assert.deepStrictEqual(idle.requests(), []);
  }],

  ['no token, cookie or storage value appears in any output, nor in any file but test/.auth', () => {
    const { sids, tokens } = fx.issued();
    assert.ok(sids.length >= 1 && tokens.length >= 1);
    h.scanOutputs([...sids, ...tokens], outputs, proj.dir, { exclude: ['test/.auth'] });
  }],
];

h.run(cases);
