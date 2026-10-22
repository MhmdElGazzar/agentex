'use strict';
// Tests for plaintext.js — ADO comment HTML -> plain text. Run: node scripts/lib/tracker/plaintext.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { htmlToText } = require('./plaintext.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

test('plain text passes through; null/undefined become empty', () => {
  assert.strictEqual(htmlToText('just text'), 'just text');
  assert.strictEqual(htmlToText(null), '');
  assert.strictEqual(htmlToText(undefined), '');
});

test('named and numeric entities decode — markup characters come back literal', () => {
  assert.strictEqual(htmlToText('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &apos;e&apos;'), 'a <b> & "c" \'d\' \'e\'');
  assert.strictEqual(htmlToText('&#1578;&#x62C;&nbsp;x'), 'تج x');
  assert.strictEqual(htmlToText('&amp;lt;'), '&lt;', 'decoded once, never twice');
});

test('line structure: <br> is a newline, block ends are newlines, list items get "- "', () => {
  assert.strictEqual(htmlToText('one<br>two<br/>three<BR />four'), 'one\ntwo\nthree\nfour');
  assert.strictEqual(htmlToText('<div>first</div><div>second</div>'), 'first\nsecond');
  assert.strictEqual(htmlToText('<p>para one</p><p>para two</p>'), 'para one\npara two');
  assert.strictEqual(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
});

test('tags are stripped, their text kept — an ADO mention anchor reads as @Name', () => {
  assert.strictEqual(htmlToText('<a href="#" data-vss-mention="version:2.0,abc-123">@Sam Tester</a> please check <b>this</b>'),
    '@Sam Tester please check this');
  assert.strictEqual(htmlToText('<img src="x.png" alt="shot">see image'), 'see image');
});

test('non-ASCII is literal; runs of blank lines collapse; the result is trimmed', () => {
  assert.strictEqual(htmlToText('<div>  مرحبا — résumé  </div><div><br></div><div><br></div><div>end</div>'), 'مرحبا — résumé\n\nend');
});

test('structural: pure, no requires beyond node:', () => {
  const src = fs.readFileSync(path.join(__dirname, 'plaintext.js'), 'utf8');
  assert.ok(!/child_process|process\.exit\(/.test(src));
  for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) assert.ok(m[1].startsWith('node:'), m[1]);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
