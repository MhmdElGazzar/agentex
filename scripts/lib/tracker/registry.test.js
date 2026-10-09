'use strict';
// Tests for the generic fail-closed strategy registry (scripts/lib/tracker/registry.js).
// Run: node scripts/lib/tracker/registry.test.js
// Offline, pure. The registry is shared by task-estimation's strategies and the
// tracker CLI's ops strategies; each consumer passes its own label and member list.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistry } = require('./registry.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const refusal = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal'); };

const MEMBERS = ['provider', 'alpha', 'beta'];
const stub = (provider, omit = []) => {
  const s = { provider, alpha() {}, beta() {} };
  for (const m of omit) delete s[m];
  return s;
};
const reg = (map) => createRegistry({ label: 'widget strategy', requiredMembers: MEMBERS, map });

test('providers() lists keys in insertion order; get() returns the registered strategy object', () => {
  const a = stub('acme'); const z = stub('zeta');
  const r = reg({ zeta: z, acme: a });
  assert.deepStrictEqual(r.providers(), ['zeta', 'acme']);
  assert.strictEqual(r.get('acme'), a);
});

test('get(unknown): exit-2 refusal with the label, the name, and the providers that have one', () => {
  const e = refusal(() => reg({ ado: stub('ado'), jira: stub('jira') }).get('acme'));
  assert.strictEqual(e.exitCode, 2);
  assert.strictEqual(e.message,
    "No widget strategy is registered for tracker provider 'acme' — providers with one: ado, jira. " +
    "Refusing rather than falling back to another provider's behavior; nothing was read or written.");
});

test('inherited object keys are never strategies; an empty map says "none"', () => {
  const e = refusal(() => reg({}).get('toString'));
  assert.strictEqual(e.exitCode, 2);
  assert.match(e.message, /providers with one: none\./);
});

test('missing required members (functions, and the provider string) are named in order', () => {
  const e = refusal(() => reg({ acme: stub('acme', ['beta', 'alpha']) }).get('acme'));
  assert.strictEqual(e.exitCode, 2);
  assert.match(e.message, /^The widget strategy registered for tracker provider 'acme' is missing required member\(s\): alpha, beta\. /);
  const np = refusal(() => reg({ acme: stub('acme', ['provider']) }).get('acme'));
  assert.match(np.message, /missing required member\(s\): provider\./);
});

test('a strategy registered under another provider\'s key is refused', () => {
  const e = refusal(() => reg({ acme: stub('zeta') }).get('acme'));
  assert.strictEqual(e.exitCode, 2);
  assert.match(e.message, /^The widget strategy registered under 'acme' declares provider 'zeta' — a strategy must be registered under its own provider\. /);
});

test('construction validates its own arguments', () => {
  assert.throws(() => createRegistry({ requiredMembers: MEMBERS, map: {} }), /label/);
  assert.throws(() => createRegistry({ label: 'x', map: {} }), /requiredMembers/);
  assert.throws(() => createRegistry({ label: 'x', requiredMembers: MEMBERS }), /map/);
});

test('structural: no process spawning, no force-exit, no npm dependencies', () => {
  const src = fs.readFileSync(path.join(__dirname, 'registry.js'), 'utf8');
  assert.ok(!/child_process|spawnSync|execSync/.test(src));
  assert.ok(!src.includes('process.exit('));
  for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) assert.ok(/^(node:|\.)/.test(m[1]), `unexpected dependency ${m[1]}`);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
