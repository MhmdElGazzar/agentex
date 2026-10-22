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

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
