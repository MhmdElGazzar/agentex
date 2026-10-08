'use strict';
// Tests for the deprecated ci_gate.js forwarder (old CI template path).
// Run: node skills/browser-testing/scripts/ci_gate.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHIM = path.join(__dirname, 'ci_gate.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

test('forwards to the real gate: same one-line JSON on stdout, same exit code, deprecation on stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cg-shim-'));
  const r = spawnSync(process.execPath, [SHIM, '--all'], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr); // not an AgenTeX project → usage, exit 2
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).blockedReasons[0].code, 'usage');
  assert.match(r.stderr, /DEPRECATED path skills\/browser-testing\/scripts\/ci_gate\.js/);
});

test('structural pin: the shim never calls process.exit(', () => {
  assert.ok(!fs.readFileSync(SHIM, 'utf8').includes('process.exit('));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
