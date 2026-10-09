'use strict';
// Unit tests for the ADF composition module (O2 of the Jira design).
// Run: node scripts/lib/tracker/adf.test.js — fully offline, pure functions.
//
// Coverage per the design's §5.11 table:
//   - builder output pinned (doc/paragraph/heading/orderedList/bulletList/codeBlock/strong)
//   - toAdf paragraph/hardBreak mapping (blank lines split paragraphs, single
//     newlines become hardBreak; NO markdown parsing — a documented plain-text mapping)
//   - every builder output is a valid { type:'doc', version:1 } when wrapped by doc()
const assert = require('node:assert');
const { toAdf, doc, paragraph, heading, orderedList, bulletList, codeBlock, strong } = require('./adf.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── toAdf: the documented plain-text mapping ─────────────────────────────────
test('toAdf: one plain line becomes one paragraph in a version-1 doc', () => {
  assert.deepStrictEqual(toAdf('hello world'), {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
  });
});

test('toAdf: blank lines split paragraphs; single newlines become hardBreak', () => {
  assert.deepStrictEqual(toAdf('line one\nline two\n\npara two'), {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'line one' },
        { type: 'hardBreak' },
        { type: 'text', text: 'line two' },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: 'para two' }] },
    ],
  });
});

test('toAdf: no markdown parsing — *stars* and # hashes stay literal text', () => {
  const d = toAdf('# not a heading\n\n*not bold*');
  assert.strictEqual(d.content[0].content[0].text, '# not a heading');
  assert.strictEqual(d.content[1].content[0].text, '*not bold*');
});

test('toAdf: empty/nullish input is one empty paragraph (a valid minimal doc)', () => {
  const empty = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] };
  assert.deepStrictEqual(toAdf(''), empty);
  assert.deepStrictEqual(toAdf(null), empty);
  assert.deepStrictEqual(toAdf(undefined), empty);
});

test('toAdf: non-string input is stringified, never a crash', () => {
  assert.deepStrictEqual(toAdf(42).content[0].content[0], { type: 'text', text: '42' });
});

// ── builders: pinned shapes ──────────────────────────────────────────────────
test('doc(...nodes) wraps nodes in { type: doc, version: 1 }', () => {
  assert.deepStrictEqual(doc(paragraph('a'), paragraph('b')), {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ],
  });
});

test('paragraph: a string becomes a text node; inline nodes pass through', () => {
  assert.deepStrictEqual(paragraph('plain'), {
    type: 'paragraph', content: [{ type: 'text', text: 'plain' }],
  });
  assert.deepStrictEqual(paragraph(strong('bold'), ' tail'), {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' tail' },
    ],
  });
});

test('heading(level, text) pins attrs.level', () => {
  assert.deepStrictEqual(heading(3, 'Steps'), {
    type: 'heading', attrs: { level: 3 },
    content: [{ type: 'text', text: 'Steps' }],
  });
});

test('orderedList / bulletList: string items become listItem > paragraph', () => {
  assert.deepStrictEqual(orderedList(['first', 'second']), {
    type: 'orderedList',
    content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
    ],
  });
  assert.strictEqual(bulletList(['x']).type, 'bulletList');
  assert.deepStrictEqual(bulletList(['x']).content[0].content[0].content[0], { type: 'text', text: 'x' });
});

test('orderedList: a prebuilt block node passes through as the item body', () => {
  const item = paragraph(strong('do: '), 'click');
  assert.deepStrictEqual(orderedList([item]).content[0], { type: 'listItem', content: [item] });
});

test('codeBlock(text) pins the shape', () => {
  assert.deepStrictEqual(codeBlock('SELECT 1'), {
    type: 'codeBlock', content: [{ type: 'text', text: 'SELECT 1' }],
  });
});

test('strong(text) is an inline text node with the strong mark', () => {
  assert.deepStrictEqual(strong('key'), { type: 'text', text: 'key', marks: [{ type: 'strong' }] });
});

// ── validity: every builder wrapped by doc() yields a well-formed v1 doc ────
test('every builder output wrapped in doc() is a valid { type: doc, version: 1 } tree', () => {
  const d = doc(
    heading(2, 'h'),
    paragraph('p'),
    orderedList(['a', 'b']),
    bulletList(['c']),
    codeBlock('x'),
  );
  assert.strictEqual(d.type, 'doc');
  assert.strictEqual(d.version, 1);
  assert.ok(Array.isArray(d.content) && d.content.length === 5);
  (function walk(node) {
    assert.ok(node && typeof node.type === 'string', `node without a type: ${JSON.stringify(node)}`);
    for (const child of node.content || []) walk(child);
  })(d);
});

// ── read path + mention (skill-consolidation-foundation WP-6) ────────────────
const adf = require('./adf.js');

test('toPlainText inverts toAdf: paragraphs -> blank line, hardBreak -> newline, text literal', () => {
  for (const s of ['one line', 'line one\nline two', 'para one\n\npara two\nwith break', 'مرحبا — résumé <b> & "q"']) {
    assert.strictEqual(adf.toPlainText(toAdf(s)), s);
  }
});

test('toPlainText walks marks, mentions, emoji, lists, headings, code and links', () => {
  const d = doc(
    heading(2, 'Title'),
    { type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'acc-1', text: '@Sam Tester' } },
      { type: 'text', text: ' please ' },
      strong('check'),
      { type: 'text', text: ' ' },
      { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
      { type: 'text', text: ' ' },
      { type: 'inlineCard', attrs: { url: 'https://example.com/x' } },
    ] },
    bulletList(['a', 'b']),
    orderedList(['first']),
    codeBlock('x = 1'),
  );
  assert.strictEqual(adf.toPlainText(d), 'Title\n\n@Sam Tester please check 😄 https://example.com/x\n\n- a\n- b\n\n- first\n\nx = 1');
});

test('toPlainText is total: null, a bare string, an unknown node type', () => {
  assert.strictEqual(adf.toPlainText(null), '');
  assert.strictEqual(adf.toPlainText('already plain'), 'already plain');
  assert.strictEqual(adf.toPlainText({ type: 'doc', version: 1, content: [{ type: 'mysteryNode', content: [{ type: 'text', text: 'kept' }] }] }), 'kept');
});

test('mention(id, text): the ADF mention node Jira renders as a real @-mention', () => {
  assert.deepStrictEqual(adf.mention('5b10ac8d82e05b22cc7d4ef5', '@Sam Tester'),
    { type: 'mention', attrs: { id: '5b10ac8d82e05b22cc7d4ef5', text: '@Sam Tester' } });
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
