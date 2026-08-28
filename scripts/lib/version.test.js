'use strict';
// Unit tests for the shared version-compare lib (scripts/lib/version.js) — the single
// version-semantics source for both migrate.js's stamp-newer abort and
// self_update.js's update check. Run: node scripts/lib/version.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { compareVersions } = require('./version.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── numeric segments ──────────────────────────────────────────────────────────
test('numeric: a < b is negative, a > b is positive', () => {
  assert.ok(compareVersions('0.20.1', '0.21.0') < 0);
  assert.ok(compareVersions('0.21.0', '0.20.1') > 0);
});

test('numeric: compares per segment, not lexically (1.10 > 1.9)', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0);
});

// ── unequal lengths ───────────────────────────────────────────────────────────
test('unequal lengths: missing segments count as 0', () => {
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.1', '1.2') > 0);
  assert.ok(compareVersions('1.2', '1.2.1') < 0);
});

// ── equality ──────────────────────────────────────────────────────────────────
test('equality: identical dotted versions compare 0', () => {
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(compareVersions('0.20.1', '0.20.1'), 0);
});

// ── non-numeric parts ─────────────────────────────────────────────────────────
test('non-numeric segments compare lexically when both are non-numeric', () => {
  assert.ok(compareVersions('1.2.beta', '1.2.alpha') > 0);
  assert.ok(compareVersions('1.2.alpha', '1.2.beta') < 0);
  assert.strictEqual(compareVersions('1.0.alpha', '1.0.alpha'), 0);
});

test('non-numeric equal segments continue to the next segment', () => {
  assert.ok(compareVersions('1.alpha.2', '1.alpha.3') < 0);
});

test('non-string input is coerced (String())', () => {
  assert.strictEqual(compareVersions(1.2, '1.2'), 0);
});

// ── regression: migrate.js must use THIS module, not a private copy ───────────
// migrate.js is a program (guards execute at require time), so the assertion is
// structural on its source: it requires the shared lib and no longer carries its
// own compareVersions definition — the two version gates can never disagree.
test('migrate.js requires the shared lib and has no private compareVersions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrate.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/version(\.js)?['"]\)/,
    'migrate.js must require ./lib/version.js');
  assert.ok(!/function\s+compareVersions/.test(src),
    'migrate.js must not define its own compareVersions');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
