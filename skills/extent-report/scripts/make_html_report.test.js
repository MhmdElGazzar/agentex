'use strict';
// Tests for make_html_report.js — including the first-class `warning` and
// `viewMismatch` statuses (ui-check verdicts) and `flaky` (the browser-testing flake
// doctrine's outcome for a scenario that only passed on its one retry). Run-summary
// JSON contract widened from 5 to 8 statuses.
// Run: node skills/extent-report/scripts/make_html_report.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'make_html_report.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function render(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-extent-'));
  const inFile = path.join(dir, 'in.json');
  const outFile = path.join(dir, 'out.html');
  fs.writeFileSync(inFile, JSON.stringify(data));
  execFileSync(process.execPath, [SCRIPT, inFile, outFile], { encoding: 'utf8' });
  return fs.readFileSync(outFile, 'utf8');
}

const WARNING_COLOR = '#EAC54F';
const VIEWMISMATCH_COLOR = '#4D9DE0';
const FLAKY_COLOR = '#E0619B';
const PASSED_COLOR = '#2E9E4F';

const OLD_STYLE = {
  title: 'Legacy Run', date: '2026-08-13',
  summary: { total: 4, passed: 2, failed: 1, blocked: 1, naDescoped: 0, notRun: 0 },
  testCases: [
    { name: 'tc1', spec: 'test/a.md', status: 'failed', steps: [
      { desc: 'step one', status: 'passed', note: '' },
      { desc: 'step two', status: 'failed', note: 'defect #1' },
    ]},
  ],
};

const NEW_STYLE = {
  title: 'UI Check Run', date: '2026-08-13',
  summary: { total: 6, passed: 1, failed: 1, blocked: 1, warnings: 1, viewMismatch: 1, naDescoped: 0, notRun: 1 },
  testCases: [
    { name: 'checkout-ui', spec: 'test/suite1/checkout.md', status: 'warning', steps: [
      { desc: 'ui-check: figma 1:2 — mode: reference', status: 'warning', note: 'layout drift: sidebar moved' },
    ]},
    { name: 'mobile-ui', spec: 'test/suite1/mobile.md', status: 'viewMismatch', steps: [
      { desc: 'ui-check: figma 3:4 — mode: exact', status: 'viewMismatch', note: 'baseline is mobile 390x844; run targets desktop 1440x900' },
    ]},
  ],
};

test('legacy 5-status JSON renders with no trace of the new statuses', () => {
  const html = render(OLD_STYLE);
  assert.ok(!html.includes(WARNING_COLOR), 'no warning color in legacy render');
  assert.ok(!html.includes(VIEWMISMATCH_COLOR), 'no viewMismatch color in legacy render');
  assert.ok(!html.includes('View Mismatch'), 'no View Mismatch label in legacy render');
  assert.ok(!/>WARNING</.test(html), 'no WARNING stat card in legacy render');
  assert.ok(!html.includes(FLAKY_COLOR), 'no flaky color in legacy render');
  assert.ok(!/>FLAKY</.test(html), 'no FLAKY stat card in legacy render');
});

test('summary warnings/viewMismatch counts get their own stat cards', () => {
  const html = render(NEW_STYLE);
  assert.match(html, />WARNING</, 'WARNING stat card');
  assert.match(html, />VIEW MISMATCH</, 'VIEW MISMATCH stat card');
});

test('new statuses appear as legend entries with their own colors', () => {
  const html = render(NEW_STYLE);
  assert.match(html, /Warning/, 'Warning legend label');
  assert.match(html, /View Mismatch/, 'View Mismatch legend label');
  assert.ok(html.includes(WARNING_COLOR), 'warning color present');
  assert.ok(html.includes(VIEWMISMATCH_COLOR), 'viewMismatch color present');
});

test('donut gains segments for the new statuses', () => {
  const html = render(NEW_STYLE);
  const donutFills = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(donutFills.includes(WARNING_COLOR), `warning donut segment (got: ${donutFills.join(',')})`);
  assert.ok(donutFills.includes(VIEWMISMATCH_COLOR), 'viewMismatch donut segment');
});

test('step/test-case status accepts warning and viewMismatch as pills', () => {
  const html = render(NEW_STYLE);
  assert.ok(html.includes(`color:${WARNING_COLOR}`), 'warning pill colored');
  assert.ok(html.includes(`color:${VIEWMISMATCH_COLOR}`), 'viewMismatch pill colored');
  assert.match(html, />Warning<\/span>/, 'Warning pill label');
  assert.match(html, />View Mismatch<\/span>/, 'View Mismatch pill label');
});

test('test-case rollup border uses the new colors', () => {
  const html = render(NEW_STYLE);
  assert.ok(html.includes(`border-left-color:${WARNING_COLOR}`), 'warning rollup border');
  assert.ok(html.includes(`border-left-color:${VIEWMISMATCH_COLOR}`), 'viewMismatch rollup border');
});

test('coverage counts warning and viewMismatch as exercised', () => {
  // exercised = passed+failed+blocked+warnings+viewMismatch = 5 of 6 -> 83%
  const html = render(NEW_STYLE);
  assert.match(html, />83%</, 'coverage 83%');
});

// A run where one scenario failed on infrastructure and passed on its single retry.
// The doctrine calls that FLAKY, not PASS — the report has to say so.
const FLAKY_RUN = {
  title: 'Regression with a flake', date: '2026-08-24',
  summary: { total: 5, passed: 2, failed: 1, blocked: 0, flaky: 1, naDescoped: 0, notRun: 1 },
  testCases: [
    { name: 'cart-add-item', spec: 'test/suite1/cart.md', status: 'flaky', steps: [
      { desc: 'Open the product page', status: 'passed', note: '' },
      { desc: 'Add to cart', status: 'flaky', note: 'attempt 1: net::ERR_CONNECTION_RESET before the page loaded; attempt 2 passed' },
    ]},
  ],
};

test('flaky gets its own stat card, legend row and color', () => {
  const html = render(FLAKY_RUN);
  assert.match(html, />FLAKY</, 'FLAKY stat card');
  assert.match(html, />Flaky</, 'Flaky legend label');
  assert.ok(html.includes(FLAKY_COLOR), 'flaky color present');
});

test('a flaky test case is never rendered as passed', () => {
  const html = render(FLAKY_RUN);
  assert.ok(html.includes(`border-left-color:${FLAKY_COLOR}`), 'flaky rollup border');
  // The rollup is the whole point: a scenario that only passed on a retry must not
  // read green anywhere on the card, even though one of its steps did pass.
  assert.ok(!html.includes(`border-left-color:${PASSED_COLOR}`),
    'a flaky test case must not carry a passed rollup');
  assert.match(html, />Flaky<\/span>/, 'Flaky pill label');
});

test('donut gains a flaky segment', () => {
  const html = render(FLAKY_RUN);
  const donutFills = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(donutFills.includes(FLAKY_COLOR), `flaky donut segment (got: ${donutFills.join(',')})`);
});

test('coverage counts flaky as exercised', () => {
  // exercised = passed+failed+blocked+warnings+viewMismatch+flaky = 4 of 5 -> 80%
  const html = render(FLAKY_RUN);
  assert.match(html, />80%</, 'coverage 80%');
});
console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
