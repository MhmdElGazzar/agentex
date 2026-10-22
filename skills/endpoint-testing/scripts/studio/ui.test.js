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
  for (const k of ['all', 'needs-review', 'failing', 'skipped']) keys.add(`filter.${k}`);
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
    .replace('const needsReview = __STUDIO_NEEDS_REVIEW__;', 'const needsReview = () => false;');
  const ctx = vm.createContext({ document, fetch, location: { search: '', href: '' }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, URLSearchParams, console, setTimeout });
  vm.runInContext(src + '\n;globalThis.__P = { ED, openDrawer, save, STR: () => STR, set STR(v) { STR = v; } };', ctx);
  ctx.__P.STR = strings; // the real strings, English
  return { P: ctx.__P, nodes, ctx };
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

const asyncTests = [];
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
