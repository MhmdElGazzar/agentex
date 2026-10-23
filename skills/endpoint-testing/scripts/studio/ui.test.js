'use strict';
// Static checks on the studio page: both languages complete, no external resource, RTL Arabic
// by default. Run: node skills/endpoint-testing/scripts/studio/ui.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const html = fs.readFileSync(path.join(__dirname, 'studio.html'), 'utf8');
const strings = JSON.parse(fs.readFileSync(path.join(__dirname, 'strings.json'), 'utf8'));

test('strings.json: ar and en have exactly the same keys, none empty', () => {
  assert.deepStrictEqual(Object.keys(strings.ar).sort(), Object.keys(strings.en).sort());
  for (const lang of ['ar', 'en']) for (const [k, v] of Object.entries(strings[lang])) assert.ok(typeof v === 'string' && v.trim(), `${lang}.${k} is empty`);
});

test('every data-i18n key and every t(\'…\') key used by the page exists', () => {
  const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/\bt\('([a-z0-9.-]+)'/gi)) keys.add(m[1]);
  // template keys built at run time: t(`kind.${k}`), t(`badge.${…}`), t(`filter.${f}`)
  for (const k of ['happy', 'not-found', 'no-token', 'missing-field']) keys.add(`kind.${k}`);
  for (const k of ['ui', 'project', 'auto', 'placeholder', 'manual']) keys.add(`badge.${k}`);
  for (const k of ['all', 'needs-review', 'failing', 'blocked', 'skipped']) keys.add(`filter.${k}`);
  for (const k of ['bad-type', 'credential-shaped', 'bad-value', 'other']) keys.add(`s3.refused.${k}`);
  for (const k of ['catalog', 'suite', 'data-store', 'token', 'env-line']) keys.add(`s5.write.${k}`);
  const missing = [...keys].filter(k => !(k in strings.en));
  assert.deepStrictEqual(missing, []);
});

test('the appendix wording is used verbatim for the Q21 and conflict strings', () => {
  assert.strictEqual(strings.en['q21.refused'], 'Creating data is off for "{env}": this environment is not marked non-production. To allow it, add "nonProduction": true to environments/{env}.json. Collecting existing values still works.');
  assert.strictEqual(strings.en['ed.conflict'], 'This suite changed on disk after you opened it. Nothing was saved, and the file on disk was kept as it is. Reload to see it; your unsaved edits are listed below so you can apply them again.');
  assert.match(strings.ar['q21.title'], /يريد الوكيل إنشاء/);
});

test('no http(s):// resource, @import or font URL in the page', () => {
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<img\b/i);
});

test('Arabic is the default and right-to-left', () => {
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /LANG = STUDIO\.lang === 'en' \? 'en' : 'ar'/);
  assert.match(html, /dir = LANG === 'ar' \? 'rtl' : 'ltr'/);
});

test('no in-page button asks the agent to collect from the editor', () => {
  const editor = html.slice(html.indexOf('<main id="editor"'), html.indexOf('<main id="wizard"'));
  assert.doesNotMatch(editor, /s3\.(collect|again)|ask the agent|<button[^>]*>[^<]*\bcollect\b/i);
});


// ---- a tiny DOM, enough to run the page's own script ------------------------------------
// Faithful where it matters: append/replaceChildren turn a non-Node argument into a text
// node of String(arg) — so a stray `null` becomes the literal text "null", like a browser.
const vm = require('node:vm');
class FakeNode {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.handlers = {}; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.classList = { add() {}, remove() {}, toggle() {} }; this.style = {}; this.dataset = {}; }
  _adopt(c) { return c && c.nodeType ? c : { nodeType: 3, text: String(c) }; }
  append(...k) { for (const c of k) this.children.push(this._adopt(c)); }
  replaceChildren(...k) { this.children = k.map((c) => this._adopt(c)); this._text = ''; }
  remove() {}
  addEventListener(e, f) { this.handlers[e] = f; }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ''; }
  set innerHTML(v) { this.children = []; this._text = String(v); }
  get innerHTML() { return this.textContent; }
  querySelectorAll() { return []; }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c.nodeType === 1) c.find(pred, out); return out; }
}
function loadPage(routes = {}) {
  const nodes = {};
  const document = {
    createElement: (tag) => new FakeNode(tag), createTextNode: (s) => ({ nodeType: 3, text: String(s) }),
    getElementById: (id) => (nodes[id] = nodes[id] || new FakeNode(id)), querySelectorAll: () => [],
    documentElement: new FakeNode('html'), body: new FakeNode('body'),
  };
  const pending = () => new Promise(() => {}); // anything unrouted never answers: the boot code idles
  const fetch = (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${String(url).split('?')[0]}`;
    if (!(key in routes)) return pending();
    const body = routes[key];
    return Promise.resolve({ status: 200, json: async () => (typeof body === 'function' ? body(opts) : body) });
  };
  const src = html.match(/<script>([\s\S]*)<\/script>/)[1]
    .replace(/'__STUDIO_(\w+)__'/g, (_, k) => (k === 'LANG' ? "'en'" : k === 'VIEW' ? "'editor'" : "''"))
    .replace('const needsReview = __STUDIO_NEEDS_REVIEW__;', 'const needsReview = () => false;')
    .replace('__STUDIO_VIEW_HELPERS__', () => require('./studio_view.js').source());
  const window = { listeners: {}, addEventListener(e, f) { this.listeners[e] = f; } };
  const ctx = vm.createContext({ window, document, fetch, location: { search: '', href: '' }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, URLSearchParams, console, setTimeout });
  vm.runInContext(src + '\n;globalThis.__P = { ED, WZ, openDrawer, save, renderEditor, renderStep3, setValue, loadPreview, renderStep5, startWizard, unloadWarning, t, tn, setLang(v) { LANG = v; }, STR: () => STR, set STR(v) { STR = v; } };', ctx);
  ctx.__P.STR = strings; // the real strings, English
  return { P: ctx.__P, nodes, ctx, window };
}
const textOf = (n) => n.textContent;

test('S-3: the drawer of a case with no message check and no last run shows no literal "null"', () => {
  const { P, nodes } = loadPage();
  P.ED.path = 'suite.json'; P.ED.doc = { cases: [{ name: 'c1', entry: 'GET /x' }] }; P.ED.endpoints = {}; P.ED.last = {};
  P.openDrawer({ name: 'c1', entry: 'GET /x', __i: 1 });
  const drawer = nodes.drawer;
  assert.ok(drawer.children.length > 5, 'the drawer rendered');
  assert.ok(!/null|undefined/.test(textOf(drawer)), `drawer text: ${textOf(drawer).slice(-200)}`);
});

test('AC7: the language button names the language it switches to; both languages have the plural variants', () => {
  assert.strictEqual(strings.en['app.lang'], 'العربية');
  assert.strictEqual(strings.ar['app.lang'], 'English');
  for (const key of ['ed.counts', 'ed.cases', 'cd.usedN', 'cd.casesNeed', 's3.progress', 's4.totals', 'ed.stat', 'q21.title']) {
    for (const c of ['one', 'two', 'few', 'many', 'other']) for (const l of ['en', 'ar']) assert.ok(strings[l][`${key}#${c}`], `${l} ${key}#${c}`);
    assert.ok(strings.ar[key] && strings.en[key], `${key} keeps its plain fallback`);
    const forms = new Set(['one', 'two', 'few', 'many'].map(c => strings.ar[`${key}#${c}`]));
    assert.strictEqual(forms.size, 4, `${key}: the Arabic one/two/few/many forms differ`);
  }
});

test('AC7: .mono text and inputs are LTR and isolated; t() isolates interpolated values', () => {
  assert.match(html, /\.mono \{[^}]*direction:ltr; unicode-bidi:isolate/);
  assert.match(html, /input\.mono \{ width:100%/);
  const { P } = loadPage();
  assert.strictEqual(P.t('ed.cases#other', { n: 5 }), '⁨5⁩ cases');
});

test('AC7: Arabic counts take their own form for 1, 2, 3-10 and 11+ (41 is "many")', () => {
  const { P } = loadPage();
  P.setLang('ar');
  const f = n => P.tn('ed.cases', 'n', { n });
  assert.strictEqual(new Set([f(1), f(2), f(5), f(41)]).size, 4);
  assert.strictEqual(f(41), P.t('ed.cases#many', { n: 41 }));
  assert.strictEqual(f(5), P.t('ed.cases#few', { n: 5 }));
});

test('AC4: the wizard (step >= 2) and the editor (unsaved edits) register a beforeunload warning; a clean editor and an approved wizard do not', () => {
  assert.match(html, /addEventListener\('beforeunload'/);
  const { P, ctx, window } = loadPage();
  const nodes = { wizard: ctx.document.getElementById('wizard'), editor: ctx.document.getElementById('editor') };
  assert.strictEqual(typeof window.listeners.beforeunload, 'function');
  nodes.wizard.hidden = true; nodes.editor.hidden = false;
  assert.strictEqual(P.unloadWarning(), false);
  P.ED.edits = [{ op: 'delete', index: 1 }];
  assert.strictEqual(P.unloadWarning(), true);
  let prevented = false;
  window.listeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  P.ED.edits = [];
  nodes.editor.hidden = true; nodes.wizard.hidden = false; P.WZ.step = 3;
  assert.strictEqual(P.unloadWarning(), true);
  P.WZ.approved = true;
  assert.strictEqual(P.unloadWarning(), false);
});

test('AC1: the user picker keeps its option nodes and the chosen user across polls; disabled users are last and greyed out', () => {
  const { P, nodes } = loadPage();
  P.WZ.envs = [{ name: 'qc', portalUrl: 'https://app.example.test', users: ['alice', 'locked', 'bob'], userInfo: [{ name: 'alice', disabled: null }, { name: 'locked', disabled: 'account locked' }, { name: 'bob', disabled: null }] }];
  P.WZ.needs = [];
  P.WZ.state = { env: 'qc', attached: true, values: {}, missing: {}, user: null, run: null, suggestedUser: null };
  P.renderStep3();
  const opts = nodes.userSel.children.slice();
  assert.deepStrictEqual(opts.map(o => o.attrs.value), ['', 'alice', 'bob', 'locked']);
  assert.strictEqual(opts[0].textContent, '— pick a user —');
  assert.ok('disabled' in opts[3].attrs && !('disabled' in opts[1].attrs));
  assert.match(opts[3].textContent, /account locked/);
  assert.match(nodes.whoLine.textContent, /Pick a user/);
  nodes.userSel.value = 'bob'; nodes.userSel.handlers.change({ target: nodes.userSel });
  for (let i = 0; i < 3; i++) P.renderStep3(); // three polls
  assert.ok(nodes.userSel.children.every((o, i) => o === opts[i]), 'the options were not rebuilt');
  assert.strictEqual(nodes.userSel.value, 'bob');
  assert.match(nodes.whoLine.textContent, /bob/);
  P.WZ.state = { ...P.WZ.state, suggestedUser: 'alice' };
  P.renderStep3();
  assert.ok(nodes.userSel.children[2].attrs.selected !== undefined, 'a suggestion rebuilds the list but the tester\'s choice (bob) stays selected');
  assert.strictEqual(nodes.userSel.value, 'bob');
});

test('AC1: with no choice, the picker preselects suggestedUser; once a run exists the line names the run\'s user', () => {
  const { P, nodes } = loadPage();
  P.WZ.envs = [{ name: 'qc', portalUrl: 'https://app.example.test', users: ['alice', 'bob'], userInfo: [{ name: 'alice', disabled: null }, { name: 'bob', disabled: null }] }];
  P.WZ.needs = [];
  P.WZ.state = { env: 'qc', attached: true, values: {}, missing: {}, user: null, run: null, suggestedUser: 'bob' };
  P.renderStep3();
  assert.strictEqual(nodes.userSel.value, 'bob');
  P.WZ.state = { ...P.WZ.state, user: 'alice', run: { runId: 'c1', status: 'ended' } };
  P.renderStep3();
  assert.match(nodes.whoLine.textContent, /alice/);
  assert.doesNotMatch(nodes.whoLine.textContent, /bob/);
});

test('AC5: no phase line after the run ended or failed; "Collect again — missing only" is disabled when nothing is missing', () => {
  const { P, nodes } = loadPage();
  P.WZ.envs = [{ name: 'qc', portalUrl: 'https://x.test', users: ['alice'], userInfo: [{ name: 'alice', disabled: null }] }];
  P.WZ.needs = [{ param: 'petId', in: 'path', type: 'integer' }];
  const base = { env: 'qc', attached: true, values: { petId: { value: 3, source: 'ui' } }, missing: {}, user: 'alice' };
  P.WZ.state = { ...base, run: { runId: 'c1', status: 'collecting', phase: { name: 'login', text: 'signing in' } } };
  P.renderStep3();
  assert.match(nodes.s3Notes.textContent, /signing in/);
  P.WZ.state = { ...base, run: { runId: 'c1', status: 'failed', reason: 'gate not cleared', phase: { name: 'login', text: 'signing in' } } };
  P.renderStep3();
  assert.doesNotMatch(nodes.s3Notes.textContent, /signing in/);
  assert.strictEqual(nodes.againMissing.disabled, true);
  P.WZ.state = { ...base, values: {}, run: { runId: 'c1', status: 'ended' } };
  P.renderStep3();
  assert.strictEqual(nodes.againMissing.disabled, false);
});

test('AC6: the editor has a Blocked filter and count; a filter with no match shows an empty state (AC7)', () => {
  const { P, nodes } = loadPage();
  P.ED.path = 's.json'; P.ED.endpoints = { 'a.get': { method: 'GET', path: '/x', params: [], pathParams: [] } };
  P.ED.doc = { cases: [{ name: 'c1', entry: 'a.get' }, { name: 'c2', entry: 'a.get' }] };
  P.ED.last = { 1: { name: 'c1', result: 'BLOCKED', reasonCode: 'token-missing', reason: 'x' }, 2: { name: 'c2', result: 'PASS', status: 200 } };
  P.renderEditor();
  const filters = nodes.filters.children.map(b => b.textContent);
  assert.ok(filters.some(f => /^Blocked \(1\)$/.test(f)), filters.join('|'));
  assert.match(nodes.stats.textContent, /1⁩ blocked/);
  P.ED.filter = 'blocked'; P.renderEditor();
  assert.strictEqual(nodes.caseRows.children.filter(r => r.attrs.class === 'row').length, 1);
  P.ED.last = {}; P.renderEditor();
  assert.match(nodes.caseRows.textContent, /No case matches the filter/);
});

const asyncTests = [];
asyncTests.push(['AC5: a refused typed value shows its reason on the row and the draft stays; a UI value gets a Change button', async () => {
  const { P, nodes } = loadPage({
    'POST /api/wizard/value': () => ({ ok: false, error: 'bad-type', expected: 'integer' }),
    'GET /api/wizard/state': () => P0.state,
  });
  const P0 = { state: null };
  P.WZ.envs = [{ name: 'qc', portalUrl: 'https://x.test', users: ['alice'], userInfo: [{ name: 'alice', disabled: null }] }];
  P.WZ.needs = [{ param: 'petId', in: 'path', type: 'integer' }, { param: 'status', in: 'query', type: 'string' }];
  P.WZ.step = 3;
  P0.state = { ok: true, env: 'qc', attached: true, values: { status: { value: 'sold', source: 'ui' } }, missing: {}, user: null, run: null };
  P.WZ.state = P0.state; P.WZ.drafts.petId = 'abc';
  await P.setValue('petId', 'abc', 'manual');
  assert.match(P.WZ.refused.petId, /integer/);
  assert.strictEqual(P.WZ.drafts.petId, 'abc', 'the draft stays');
  assert.match(nodes.needRows.textContent, /must be a ⁨integer⁩/);
  const change = nodes.needRows.find(n => n.tag === 'button' && n.textContent === 'Change');
  assert.strictEqual(change.length, 1, 'only the collected value has a Change button');
}]);
asyncTests.push(['AC6: step 4 splits ready from "will be BLOCKED: no token"; step 5 lists every write and warns', async () => {
  const preview = { ok: true, summary: { total: 10, ready: 6, review: 1, skipped: 3, tokenBlocked: 4, tokenVar: 'SHOP_TOKEN', byKind: { happy: 4 }, bySource: {}, endpoints: [], mismatches: [{ id: 'GET /x', params: { a: 'g1', b: 'g2' } }] },
    files: { catalog: 'c.json', suite: 's.json' }, exists: { catalog: false, suite: false }, token: { present: false }, baseUrl: { var: 'SHOP_BASE_URL', isSet: false, suggested: '' },
    writes: [{ path: 'c.json', kind: 'catalog', when: 'always' }, { path: 's.json', kind: 'suite', when: 'always' }, { path: '.agentex/cache/api-data/shop.json', kind: 'data-store', when: 'data' }, { path: '.env', kind: 'env-line', when: 'base-url' }] };
  const { P, nodes } = loadPage({ 'GET /api/wizard/preview': preview });
  await P.loadPreview();
  assert.match(nodes.totals.textContent, /2⁩ ready/);
  assert.match(nodes.totals.textContent, /4⁩ will be BLOCKED: no token/);
  assert.match(nodes.previewList.textContent, /come from different records/, 'step 4 shows the mismatch');
  P.renderStep5();
  assert.deepStrictEqual(nodes.fileList.children.length, 4);
  assert.match(nodes.fileList.textContent, /api-data\/shop\.json/);
  assert.match(nodes.fileList.textContent, /if you keep the base URL filled/);
  assert.strictEqual(nodes.tokWarn.hidden, false);
  assert.match(nodes.tokWarn.textContent, /SHOP_TOKEN/);
}]);
asyncTests.push(['AC4: a reload resumes at the furthest step the server holds', async () => {
  const held = { ok: true, step: 3, source: 'specs/a.json', suiteName: 'Shop', env: 'qc', needs: [{ param: 'petId', in: 'path', type: 'integer' }], selection: ['GET /x'], values: {}, missing: {}, attached: false, run: null, user: null };
  const { P } = loadPage({
    'GET /api/envs': { environments: [{ name: 'qc', portalUrl: 'https://x.test', users: ['alice'], userInfo: [{ name: 'alice', disabled: null }] }] },
    'GET /api/wizard/state': held,
    'POST /api/wizard/spec': { ok: true, kept: true, files: { catalog: 'c', suite: 's' }, exists: {}, ops: [{ id: 'GET /x', method: 'GET', path: '/x', summary: '', auth: 'public', needs: [] }], selection: ['GET /x'] },
  });
  await P.startWizard();
  assert.strictEqual(P.WZ.step, 3);
  assert.deepStrictEqual([...P.WZ.selection], ['GET /x']);
}]);
asyncTests.push(['S-5: after Reload the Save-conflict banner is hidden', async () => {
  const { P, nodes } = loadPage({ 'POST /api/suite/save': { ok: false, error: 'conflict' }, 'GET /api/suite': { ok: true, path: 'suite.json', json: { cases: [] }, etag: 'e2', canonical: true } });
  P.ED.path = 'suite.json'; P.ED.etag = 'e1'; P.ED.doc = { cases: [{ name: 'c1' }] }; P.ED.edits = [{ op: 'update', index: 1, update: { name: 'x' } }];
  const ok = await P.save();
  assert.strictEqual(ok, false);
  const box = nodes.edMsg;
  assert.ok(textOf(box).includes('changed on disk'), 'the banner is shown');
  const reload = box.find((n) => n.tag === 'button' && n.handlers.click)[0];
  reload.handlers.click();
  assert.strictEqual(textOf(box), '', 'the banner is gone right after Reload');
}]);

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
  }
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exit(failures.length ? 1 : 0);
})();
