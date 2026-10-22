'use strict';
// Run: node scripts/lib/run_stamp.test.js
const assert = require('node:assert');
const { runStamp } = require('./run_stamp.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

test('local time, zero-padded: YYYY-MM-DD_HH-MM-SS', () => {
  assert.strictEqual(runStamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02_03-04-05');
});

test('it is local time, not UTC', () => {
  const d = new Date(2026, 5, 15, 23, 59, 58);
  assert.strictEqual(runStamp(d).slice(11, 13), '23');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
