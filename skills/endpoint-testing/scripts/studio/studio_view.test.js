'use strict';
// Tests for studio/studio_view.js — the page helpers, run with no DOM.
// Run: node skills/endpoint-testing/scripts/studio/studio_view.test.js
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const V = require('./studio_view.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const INFO = [
  { name: 'alice', disabled: null },
  { name: 'locked', disabled: 'account locked after 5 failed sign-ins' },
  { name: 'bob', disabled: null },
];
const LABELS = { pickLabel: '— pick a user —' };
const picked = opts => opts.filter(o => o.selected).map(o => o.value);

test('AC1: the picker starts on "— pick a user —" when nothing is chosen or suggested', () => {
  const opts = V.userOptions(INFO, { selected: null, suggested: null, ...LABELS });
  assert.strictEqual(opts[0].value, '');
  assert.strictEqual(opts[0].text, '— pick a user —');
  assert.deepStrictEqual(picked(opts), ['']);
});

test('AC1: the options keep the selection across three renders (a poll never resets it)', () => {
  let selected = 'bob';
  const sigs = [];
  for (let i = 0; i < 3; i++) {
    const opts = V.userOptions(INFO, { selected, suggested: 'alice', ...LABELS });
    assert.deepStrictEqual(picked(opts), ['bob'], `render ${i}`);
    sigs.push(V.userSignature(INFO));
  }
  assert.strictEqual(new Set(sigs).size, 1, 'the signature is stable, so the page never rebuilds the list');
});

test('AC1: a disabled user is listed last, greyed out, with its reason, and is never selected', () => {
  const opts = V.userOptions(INFO, { selected: 'locked', suggested: 'locked', ...LABELS });
  assert.deepStrictEqual(opts.map(o => o.value), ['', 'alice', 'bob', 'locked']);
  const locked = opts[3];
  assert.strictEqual(locked.disabled, true);
  assert.strictEqual(locked.reason, 'account locked after 5 failed sign-ins');
  assert.match(locked.text, /account locked after 5 failed sign-ins/);
  assert.ok(opts.slice(0, 3).every(o => !o.disabled));
  assert.deepStrictEqual(picked(opts), [''], 'a disabled user cannot be the selection');
});

test('AC1: `disabled: true` (no reason) still greys the user out', () => {
  const opts = V.userOptions([{ name: 'x', disabled: '' }, { name: 'y', disabled: null }], { selected: null, suggested: null, ...LABELS });
  assert.deepStrictEqual(opts.map(o => [o.value, o.disabled]), [['', false], ['y', false], ['x', true]]);
});

test('AC2: the picker preselects suggestedUser only while nothing was chosen', () => {
  assert.deepStrictEqual(picked(V.userOptions(INFO, { selected: null, suggested: 'alice', ...LABELS })), ['alice']);
  assert.deepStrictEqual(picked(V.userOptions(INFO, { selected: undefined, suggested: 'bob', ...LABELS })), ['bob']);
  assert.deepStrictEqual(picked(V.userOptions(INFO, { selected: 'bob', suggested: 'alice', ...LABELS })), ['bob']);
  assert.deepStrictEqual(picked(V.userOptions(INFO, { selected: '', suggested: 'alice', ...LABELS })), [''], 'an explicit "pick a user" is kept');
  assert.deepStrictEqual(picked(V.userOptions(INFO, { selected: null, suggested: 'nobody', ...LABELS })), ['']);
});

test('the user signature changes when a user is added or disabled', () => {
  const a = V.userSignature(INFO);
  assert.notStrictEqual(a, V.userSignature(INFO.concat([{ name: 'carol', disabled: null }])));
  assert.notStrictEqual(a, V.userSignature(INFO.map(u => (u.name === 'alice' ? { ...u, disabled: 'x' } : u))));
});

test('AC7: interpolated values are wrapped in FSI...PDI; the template text is not', () => {
  assert.strictEqual(V.interpolate('{n} of {m}', { n: 3, m: 'x' }), '⁨3⁩ of ⁨x⁩');
  assert.strictEqual(V.interpolate('no vars {k}', {}), 'no vars {k}');
  assert.strictEqual(V.bidi('a/b'), '⁨a/b⁩');
});

test('AC7: Arabic plural forms follow Intl.PluralRules (1, 2, 3-10, 11+ each differ); 41 picks "many"', () => {
  const strs = { 'n.cases#one': 'حالة', 'n.cases#two': 'حالتان', 'n.cases#few': 'حالات', 'n.cases#many': 'حالة ', 'n.cases#other': 'حالة  ', 'n.cases': 'fallback' };
  assert.strictEqual(V.plural(strs, 'ar', 'n.cases', 1), 'حالة');
  assert.strictEqual(V.plural(strs, 'ar', 'n.cases', 2), 'حالتان');
  assert.strictEqual(V.plural(strs, 'ar', 'n.cases', 5), 'حالات');
  assert.strictEqual(V.plural(strs, 'ar', 'n.cases', 41), 'حالة ');
  assert.strictEqual(V.pluralKey(strs, 'ar', 'n.cases', 41), 'n.cases#many');
  assert.strictEqual(V.pluralKey(strs, 'ar', 'n.cases', 10), 'n.cases#few');
  assert.strictEqual(V.pluralKey(strs, 'ar', 'n.cases', 11), 'n.cases#many');
  assert.strictEqual(V.pluralKey(strs, 'ar', 'n.cases', 0), 'n.cases#other');
});

test('AC7: English uses one/other, and a key with no variants falls back to the plain key', () => {
  const strs = { 'k#one': '{n} case', 'k#other': '{n} cases', plain: '{n} things' };
  assert.strictEqual(V.pluralKey(strs, 'en', 'k', 1), 'k#one');
  assert.strictEqual(V.pluralKey(strs, 'en', 'k', 2), 'k#other');
  assert.strictEqual(V.pluralKey(strs, 'en', 'plain', 2), 'plain');
  assert.strictEqual(V.pluralKey({ 'k#other': 'x' }, 'en', 'k', 1), 'k#other', 'a missing variant falls to other');
});

test('AC7: an empty filter gets an empty state; a filter with matches does not', () => {
  assert.deepStrictEqual(V.emptyState(0, 'blocked'), { key: 'ed.emptyFilter', filter: 'blocked' });
  assert.strictEqual(V.emptyState(3, 'blocked'), null);
});

test('AC6: the ready count splits into ready and "will be BLOCKED: no token"', () => {
  assert.deepStrictEqual(V.tokenSplit({ ready: 10, tokenBlocked: 4 }), { ready: 6, blocked: 4 });
  assert.deepStrictEqual(V.tokenSplit({ ready: 3 }), { ready: 3, blocked: 0 });
  assert.deepStrictEqual(V.tokenSplit({ ready: 2, tokenBlocked: 9 }), { ready: 0, blocked: 2 });
});

test('the file is injectable: evaluated in a bare context it yields the same helpers', () => {
  const src = V.source();
  assert.ok(!/<\/script/i.test(src));
  const ctx = vm.createContext({});
  const out = vm.runInContext(src, ctx);
  assert.strictEqual(typeof out.userOptions, 'function');
  assert.strictEqual(out.bidi('x'), '⁨x⁩');
  assert.strictEqual(src, fs.readFileSync(path.join(__dirname, 'studio_view.js'), 'utf8').length ? src : '');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exit(failures.length ? 1 : 0);
