'use strict';
// e2e group 4: the setup wizard's secret-user-field fix, on the real /setup page in a real headless
// Chromium, served by the real scripts/wizard/server.js on 127.0.0.1 (a probed free port: the
// server cannot print a URL for --port=0). A secret user field that holds a plain string on disk
// is kept byte-identical by a Save with no edit, and removed when the tester clears it on screen.
// Skips (exit 77) when Playwright, the CLI or Chromium is not found; AGENTEX_E2E_REQUIRE=1 makes
// that a failure. Only the users-step round trip is covered: setup and the wizard also run live at
// every release. Run: node scripts/wizard/ui.e2e.test.js   Time: about 6 s.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require(path.join(__dirname, '..', 'dev', 'e2e', 'harness.js'));

h.requireDeps();
const SERVER = path.join(__dirname, 'server.js');
const PLAIN = 'Usr-plain#value-1';
const NAME = 'USER_PLAIN_APIKEY';
const projectConfig = { name: 'p', defaultEnvironment: 'qa', userFields: [{ key: 'phone', label: 'phone' }, { key: 'apiKey', label: 'key', secret: true }] };
const users = { plain: { phone: '0550000001', apiKey: PLAIN, hand: 'kept' } };
const proj = h.project({
  files: {
    'config/project.json': projectConfig,
    'environments/qa.json': { portalUrl: 'https://qa.example.test', defaults: {}, users },
  },
});
const disk = () => JSON.parse(proj.read('environments/qa.json'));
const outputs = [];
h.maskValues([PLAIN]); // the value never reaches a FAIL line

// The server prints no URL for --port=0, so a free port is probed and an "in use" start is retried.
async function startWizard() {
  let last;
  for (let i = 0; i < 3; i++) {
    const port = await h.freePort();
    try {
      const kid = await h.startChild(SERVER, [proj.dir, `--port=${port}`, '--no-open', '--lang=en'], { cwd: proj.dir, env: proj.env(), readyLine: /Wizard running at: (\S+)/ });
      return { kid, url: /Wizard running at: (\S+)/.exec(kid.ready)[1] };
    } catch (e) { last = e; if (!/in use/i.test(e.message)) throw e; }
  }
  throw last;
}
const nextButton = (page) => page.getByRole('button', { name: /Next/ });
const saveButton = (page) => page.getByRole('button', { name: /Save/ });

// The page's own navigation: step by step, to the users step.
async function toUsersStep(page) {
  await page.locator('#mc-steps').click();
  await page.locator('#btn-start').click();
  for (let i = 0; i < 12 && !(await page.locator('.user-card').count()); i++) { await nextButton(page).click(); await page.waitForTimeout(150); }
  await page.locator('.user-card').first().waitFor({ state: 'visible', timeout: 5000 });
}
async function toSaveAndSave(page) {
  for (let i = 0; i < 12 && !(await saveButton(page).count()); i++) { await nextButton(page).click(); await page.waitForTimeout(150); }
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/save')), saveButton(page).click()]);
  assert.strictEqual(res.status(), 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true, JSON.stringify(body));
  await page.getByText('Setup complete').waitFor({ state: 'visible', timeout: 5000 });
  return body;
}
async function exited(kid) { for (let i = 0; i < 40 && !kid.exited(); i++) await new Promise((r) => setTimeout(r, 100)); return kid.exited(); }

let lb;
const cases = [
  ['Save with the secret field untouched (another field of the user edited, so the file IS rewritten): the plain value stays byte-identical, hand-added keys stay, and no .env line is written for it', async () => {
    lb = await h.libBrowser(proj);
    const before = disk();
    assert.strictEqual(before.users.plain.apiKey, PLAIN);
    const w = await startWizard();
    const context = await lb.context();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(w.url);
    await page.waitForSelector('#mc-steps');
    await toUsersStep(page);
    assert.strictEqual(await page.locator('#usf-0-apiKey').inputValue(), '', 'the name slot stays empty: the string is not a name');
    assert.match(await page.locator('.user-card .field-secret-note').first().textContent(), /plain-text value|plain text/i);
    assert.ok(!(await page.content()).includes(PLAIN), 'the page never shows the plain value');
    // An unedited environment is not written at all, so the phone is edited with a real input: the file is rewritten.
    await page.locator('.user-card .field', { hasText: 'phone' }).locator('input').fill('0550000099');
    const saved = await toSaveAndSave(page);
    assert.ok(saved.written.includes('environments/qa.json'), 'the environment file was really written');
    const after = disk();
    assert.strictEqual(after.users.plain.apiKey, PLAIN, 'the plain value is kept');
    assert.deepStrictEqual(after.users.plain, { ...before.users.plain, phone: '0550000099' }, 'only the edited field changed');
    assert.ok(proj.read('environments/qa.json').includes(JSON.stringify(PLAIN)), 'byte-identical on disk');
    if (proj.exists('.env')) assert.ok(!/USER_PLAIN|Usr-plain/.test(proj.read('.env')), 'no .env line for the plain value');
    assert.deepStrictEqual(errors, []);
    assert.ok(await exited(w.kid), 'the one-shot server shut itself down after the save');
    outputs.push(w.kid.out(), w.kid.err());
    await context.close();
  }],

  ['a second run: typing a name and clearing the field on screen, then Save, removes the key; the hand-added key and the phone stay', async () => {
    const w = await startWizard();
    const context = await lb.context();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(w.url);
    await page.waitForSelector('#mc-steps');
    await toUsersStep(page);
    assert.strictEqual(disk().users.plain.apiKey, PLAIN, 'the first run left the value on disk');
    await page.locator('#usf-0-apiKey').fill(NAME);          // a real input event: the field is edited
    await page.locator('#usf-0-apiKey').fill('');            // and cleared on screen
    assert.strictEqual(await page.locator('#usf-0-apiKey').inputValue(), '');
    const saved = await toSaveAndSave(page);
    assert.ok(saved.written.includes('environments/qa.json'), 'the environment file was really written');
    const after = disk();
    assert.ok(!('apiKey' in after.users.plain), 'cleared on screen: the key is gone');
    assert.strictEqual(after.users.plain.hand, 'kept', 'the hand-added key stays');
    assert.strictEqual(after.users.plain.phone, '0550000099');
    assert.deepStrictEqual(errors, []);
    assert.ok(await exited(w.kid));
    outputs.push(w.kid.out(), w.kid.err());
    await context.close();
  }],

  ['the plain value appears in no output and in no file once it is cleared; it was never written to .env or project.json', () => {
    h.scanOutputs([PLAIN], outputs, proj.dir);
  }],

  ['the only requests that would leave 127.0.0.1 are the setup page\'s own web fonts (aborted by the harness): no new host', () => {
    // ui.html links Google Fonts (a stylesheet and its files). The harness aborted them, so nothing left the machine.
    const hosts = new Set(lb.external().map((u) => new URL(u).hostname));
    assert.deepStrictEqual([...hosts].filter((x) => !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(x)), []);
  }],
];

h.run(cases);
