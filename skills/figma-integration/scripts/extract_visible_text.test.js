'use strict';
// Self-contained test for the effective-visibility TEXT walk.
// Run: node extract_visible_text.test.js
// Imports the REAL extractor — no copy of the logic lives here, so editing the
// extractor cannot leave this test passing against a stale duplicate.
const assert = require('assert');
const { extractVisibleText, framesOf } = require('./extract_visible_text.js');
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

const textNode = (characters, visible, opacity) =>
  ({ type: 'TEXT', characters, visible, opacity });
const frame = (name, children, opacity) =>
  ({ type: 'FRAME', name, children, opacity, visible: true });

test('extracts visible text layers', () => {
  const node = frame('Frame', [textNode('Visible text'), textNode('Another visible')]);
  assert.deepStrictEqual(extractVisibleText(node), ['Visible text', 'Another visible']);
});

test('skips text with visible: false', () => {
  const node = frame('Frame', [textNode('Visible'), textNode('Hidden', false)]);
  assert.deepStrictEqual(extractVisibleText(node), ['Visible']);
});

test('skips text under an opacity: 0 ancestor', () => {
  const node = frame('Frame', [
    textNode('Visible'),
    frame('HiddenGroup', [textNode('Should be skipped')], 0),
  ]);
  assert.deepStrictEqual(extractVisibleText(node), ['Visible']);
});

test('a visible:true descendant cannot escape a hidden ancestor', () => {
  const hidden = frame('HiddenGroup', [textNode('Should be skipped', true)]);
  hidden.visible = false;
  const node = frame('Frame', [textNode('Visible'), hidden]);
  assert.deepStrictEqual(extractVisibleText(node), ['Visible']);
});

test('a TEXT node with its own opacity: 0 is skipped', () => {
  const node = frame('Frame', [textNode('Visible'), textNode('Ghost', true, 0)]);
  assert.deepStrictEqual(extractVisibleText(node), ['Visible']);
});

test('keeps text under partial opacity (0.5 * 0.5 = 0.25, still nonzero)', () => {
  const node = frame('Frame', [
    frame('SemiTransparent', [textNode('Semi-visible text')], 0.5),
  ]);
  assert.deepStrictEqual(extractVisibleText(node), ['Semi-visible text']);
});

test('collapses whitespace in extracted text', () => {
  const node = frame('Frame', [textNode('Text  with   extra\n  spaces')]);
  assert.deepStrictEqual(extractVisibleText(node), ['Text with extra spaces']);
});

test('walks nested frames in document order', () => {
  const node = frame('Root', [
    frame('Section1', [textNode('Section 1 title'), textNode('Section 1 body')]),
    frame('Section2', [textNode('Section 2 title')]),
  ]);
  assert.deepStrictEqual(extractVisibleText(node), [
    'Section 1 title', 'Section 1 body', 'Section 2 title',
  ]);
});

test('framesOf splits a SECTION into child frames', () => {
  const section = {
    type: 'SECTION', name: 'Feature', visible: true,
    children: [frame('Screen A', []), frame('Screen B', [])],
  };
  assert.deepStrictEqual(framesOf(section).map(f => f.name), ['Screen A', 'Screen B']);
});

test('framesOf returns a lone frame as itself', () => {
  const lone = frame('Just Me', [textNode('hi')]);
  assert.deepStrictEqual(framesOf(lone).map(f => f.name), ['Just Me']);
});

console.log(`${passed} passed`);
