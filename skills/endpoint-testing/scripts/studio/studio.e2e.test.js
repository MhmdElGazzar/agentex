'use strict';
// e2e group 3: the studio page (studio.html + studio_view.js + server.js) in a real headless
// Chromium, served by the real `server.js --port=0 --no-open` on 127.0.0.1. Skips (exit 77)
// when Playwright, the CLI or Chromium is not found; AGENTEX_E2E_REQUIRE=1 makes that a failure.
// Run: node skills/endpoint-testing/scripts/studio/studio.e2e.test.js
// Time: about 12 s (the picker case waits 3.5 s for three polls of the page's own 1 s poll).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'dev', 'e2e', 'harness.js'));

h.requireDeps();
const SERVER = path.join(__dirname, 'server.js');
const STRINGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'strings.json'), 'utf8'));
const PETSTORE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'golden', 'import', 'petstore-oa3', 'spec.json'), 'utf8');
const FSI = '⁨'; const PDI = '⁩';
const PORTAL = 'http://127.0.0.1:9/portal';
const SUITE_REL = 'integration/api_test_suites/orders/orders_suite.json';

// One studio server per call, each on its own project root (the session file is per root).
async function startStudio(files, args) {
  const proj = h.project({ files });
  const kid = await h.startChild(SERVER, [proj.dir, '--port=0', '--no-open', ...args], { cwd: proj.dir, env: proj.env(), readyLine: /^\{"ok":true.*\}$/m });
  const info = JSON.parse(kid.ready);
  return { proj, kid, url: info.url, origin: `http://127.0.0.1:${info.port}` };
}
// A page of one library browser context, with its page errors and every request collected.
async function openPage(lb, url) {
  const context = await lb.context();
  const page = await context.newPage();
  const seen = { errors: [], requests: [] };
  page.on('pageerror', (e) => seen.errors.push(String(e.message)));
  page.on('request', (r) => seen.requests.push(r.url()));
  await page.goto(url, { waitUntil: 'load' });
  return { page, context, seen };
}
const onlyLoopback = (seen) => seen.requests.filter((u) => /^https?:/.test(u)).every((u) => new URL(u).hostname === '127.0.0.1');

const wizardFiles = () => ({
  'config/project.json': { defaultEnvironment: 'qa' },
  'environments/qa.json': { portalUrl: PORTAL, users: { a: { email: 'a@example.test' }, b: { email: 'b@example.test' }, c: { disabled: 'test' } } },
  'spec.json': PETSTORE,
});
const suiteResult = {
  startedAt: '2026-10-23T10:00:00.000Z',
  cases: [{ suite: SUITE_REL, index: 1, name: 'get-happy', result: 'BLOCKED', reasonCode: 'token-missing', reason: 'no token for "orders" on "qa": set ORDERS_TOKEN in .env' }],
};
const editorFiles = () => ({
  '.gitignore': '.agentex/\ntest/.auth/\n',
  'config/project.json': { defaultEnvironment: 'qa' },
  'environments/qa.json': { portalUrl: PORTAL, users: { a: {} } },
  'integration/api_test_suites/orders/orders_api.json': { name: 'orders', target: 'catalog', baseUrl: 'http://127.0.0.1:9', auth: { type: 'none' },
    requests: [{ name: 'get-order', method: 'GET', path: '/orders/{orderId}', params: ['orderId'] }] },
  [SUITE_REL]: { name: 'orders-suite', cases: [
    { name: 'get-happy', entry: 'orders.get-order', kind: 'happy', params: { orderId: 1042 }, sources: { orderId: 'ui' }, expect: { status: 200 } },
    { name: 'get-other', entry: 'orders.get-order', params: { orderId: 7 }, sources: { orderId: 'manual' }, expect: { status: 200 } },
  ] },
  'executions/2026-10-23_10-00-00/api-tests/suite-result.json': suiteResult,
});

let lb; let wiz; let wp; let edPage;   // the library browser, the wizard server, the wizard page, the editor page
const HOSTILE = [
  ["a quote that closes the string ('), then code", "x';globalThis.__pwn=1;//"],
  ['a </script> that closes the tag, then a script', '</script><script>globalThis.__pwn=2</script>'],
  ['a U+2028 line terminator', 'a b'],
];

const cases = [
  ['wizard: steps 1 and 2 through the page\'s own UI reach step 3 with the user picker', async () => {
    lb = await h.libBrowser();
    wiz = await startStudio(wizardFiles(), ['--mode', 'wizard', '--lang=ar']);
    wp = await openPage(lb, wiz.url);
    const { page } = wp;
    await page.locator('#specIn').fill('spec.json');
    await page.locator('#nameIn').fill('Pets');
    await page.locator('#envIn').selectOption('qa');
    await page.locator('#s1Next').click();
    await page.locator('#opRows tr').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#s2Next').click();
    await page.locator('#userSel').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepStrictEqual(wp.seen.errors, []);
  }],

  ['picker: the chosen user survives at least three polls, and the <select> is not rebuilt under the tester', async () => {
    const { page, seen } = wp;
    await page.locator('#userSel').selectOption('b');
    await page.evaluate(() => { document.querySelector('#userSel option[value="b"]').__probe = true; });
    const polls = () => seen.requests.filter((u) => u.endsWith('/api/wizard/state')).length;
    const before = polls();
    await page.waitForTimeout(3500);
    assert.ok(polls() - before >= 3, `the page polled ${polls() - before} times in 3.5 s`);
    assert.strictEqual(await page.locator('#userSel').inputValue(), 'b', 'the choice survived the polls');
    assert.strictEqual(await page.evaluate(() => document.querySelector('#userSel option[value="b"]').__probe === true), true, 'the same <option> node: the list was not rebuilt');
    assert.deepStrictEqual(seen.errors, []);
  }],

  ['picker: a disabled user is a disabled, LAST option carrying its reason', async () => {
    const opts = await wp.page.locator('#userSel option').evaluateAll((os) => os.map((o) => ({ value: o.value, disabled: o.disabled, text: o.textContent })));
    assert.deepStrictEqual(opts.map((o) => o.value), ['', 'a', 'b', 'c']);
    assert.strictEqual(opts[3].disabled, true);
    assert.ok(!opts[1].disabled && !opts[2].disabled);
    assert.match(opts[3].text, /test/);
    assert.strictEqual(opts[0].text, STRINGS.ar['s3.pickUser']);
  }],

  ['bidi: interpolated values sit inside FSI...PDI, and .mono computes direction: ltr (inside an rtl page)', async () => {
    const { page } = wp;
    const who = await page.locator('#whoLine').textContent();
    assert.ok(who.includes(`${FSI}${PORTAL}${PDI}`), 'the portal URL is isolated');
    assert.ok(who.includes(`${FSI}b${PDI}`), 'the user name is isolated');
    assert.strictEqual(await page.evaluate(() => document.documentElement.dir), 'rtl');
    const mono = await page.locator('#needRows td.mono').first().evaluate((n) => { const s = getComputedStyle(n); return { direction: s.direction, bidi: s.unicodeBidi }; });
    assert.strictEqual(mono.direction, 'ltr');
    assert.match(mono.bidi, /isolate/);
  }],

  ['plural: the page\'s own helper gives the Arabic forms for 1, 2, 3 and 11, each its own string, pairwise different', async () => {
    const forms = await wp.page.evaluate(() => [1, 2, 3, 11].map((n) => tn('ed.cases', 'n', { n })));
    const want = [['one', 1], ['two', 2], ['few', 3], ['many', 11]].map(([cat, n]) => STRINGS.ar[`ed.cases#${cat}`].replace('{n}', `${FSI}${n}${PDI}`));
    assert.deepStrictEqual(forms, want);
    assert.strictEqual(new Set(forms).size, 4);
    assert.deepStrictEqual(wp.seen.errors, []);
  }],

  ['view helpers: the page\'s own token split clamps to the ready cases, and a user\'s disabled state changes the picker signature', async () => {
    const r = await wp.page.evaluate(() => ({
      few: V.tokenSplit({ ready: 5, tokenBlocked: 2 }), clamped: V.tokenSplit({ ready: 4, tokenBlocked: 9 }),
      same: V.userSignature([{ name: 'a', disabled: null }]), locked: V.userSignature([{ name: 'a', disabled: 'x' }]),
    }));
    assert.deepStrictEqual(r.few, { ready: 3, blocked: 2 });
    assert.deepStrictEqual(r.clamped, { ready: 0, blocked: 4 });
    assert.notStrictEqual(r.same, r.locked);
  }],

  ['wizard page: nothing leaves 127.0.0.1', () => {
    assert.ok(onlyLoopback(wp.seen), wp.seen.requests.join(' '));
    assert.deepStrictEqual(lb.external(), []);
  }],

  ['editor: a last run holding one token-BLOCKED result: "Blocked (1)", and clicking it shows that row with its reason', async () => {
    const ed = await startStudio(editorFiles(), ['--mode', 'editor', '--lang=en']);
    const e = await openPage(lb, ed.url);
    const { page } = e;
    await page.locator('#caseRows tr.row').first().waitFor({ state: 'visible', timeout: 10000 });
    assert.strictEqual(await page.locator('#caseRows tr.row').count(), 2);
    const blocked = page.getByRole('button', { name: 'Blocked (1)' });
    assert.strictEqual(await blocked.count(), 1, 'the Blocked filter shows its count');
    await blocked.click();
    assert.strictEqual(await page.locator('#caseRows tr.row').count(), 1);
    const row = await page.locator('#caseRows tr.row').first().textContent();
    assert.match(row, /get-happy/);
    assert.match(row, /Blocked/);
    assert.ok(row.includes(`${FSI}ORDERS_TOKEN${PDI}`), 'the missing token variable is named');
    assert.ok((await page.locator('#stats').textContent()).includes(`${FSI}1${PDI} blocked`), 'the stats line counts it');
    assert.deepStrictEqual(e.seen.errors, []);
    edPage = e;
  }],

  ['editor: a filter with no match shows a visible empty state (a non-zero box)', async () => {
    const { page } = edPage;
    await page.getByRole('button', { name: 'Failing (0)' }).click();
    assert.strictEqual(await page.locator('#caseRows tr.row').count(), 0);
    const empty = page.locator('#caseRows td', { hasText: 'No case matches the filter' });
    await empty.waitFor({ state: 'visible', timeout: 5000 });
    const box = await empty.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'the empty state takes room on screen');
    assert.ok((await empty.textContent()).includes(`${FSI}Failing${PDI}`), 'the filter name is isolated');
    assert.deepStrictEqual(edPage.seen.errors, []);
    assert.ok(onlyLoopback(edPage.seen));
  }],

  ...HOSTILE.map(([label, value]) => [`hostile --spec (${label}): no page error, no injected global, the input holds the value verbatim`, async () => {
    const s = await startStudio(wizardFiles(), ['--mode', 'wizard', '--lang=ar', `--spec=${value}`]);
    const w = await openPage(lb, s.url);
    // #wizard is unhidden BEFORE the page's boot fills #specIn (after its /api/envs and /api/wizard/state calls): wait for the boot's last step, the step tabs.
    await w.page.locator('#stepTabs span').first().waitFor({ state: 'visible', timeout: 15000 });
    assert.deepStrictEqual(w.seen.errors, []);
    assert.strictEqual(await w.page.evaluate(() => typeof globalThis.__pwn), 'undefined', 'no injected code ran');
    assert.strictEqual(await w.page.locator('#specIn').inputValue(), value);
    assert.strictEqual(await w.page.evaluate(() => STUDIO.spec), value);
    assert.ok(onlyLoopback(w.seen));
    await w.context.close();
  }]),

  ...HOSTILE.map(([label, value]) => [`hostile --suite (${label}): no page error, no injected global, the page holds the value verbatim`, async () => {
    const s = await startStudio(editorFiles(), ['--mode', 'editor', '--lang=en', `--suite=${value}`]);
    const w = await openPage(lb, s.url);
    await w.page.locator('#editor').waitFor({ state: 'visible', timeout: 10000 });
    await w.page.locator('#edMsg .note').waitFor({ state: 'visible', timeout: 10000 }); // the unknown suite is reported, not run
    assert.deepStrictEqual(w.seen.errors, []);
    assert.strictEqual(await w.page.evaluate(() => typeof globalThis.__pwn), 'undefined', 'no injected code ran');
    assert.strictEqual(await w.page.evaluate(() => STUDIO.suite), value);
    assert.ok(onlyLoopback(w.seen));
    await w.context.close();
  }]),

  ['no request left 127.0.0.1 in this whole file', () => {
    assert.deepStrictEqual(lb.external(), []);
  }],
];

h.run(cases);
