'use strict';
// Tests for the task-estimation strategy registry (strategies/index.js).
// Run: node skills/task-estimation/scripts/strategies/registry.test.js
// Offline. Covers: registry construction and its fail-closed lookup, and the
// structural doctrine on every strategies/*.js module (no process spawning, no
// force-exit, no npm dependencies).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_MEMBERS, createRegistry, defaultRegistry, compat } = require('./index.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const stub = (provider, omit = []) => {
  const s = { provider };
  for (const m of REQUIRED_MEMBERS) if (m !== 'provider') s[m] = async () => {};
  for (const m of omit) delete s[m];
  return s;
};
const refusal = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal'); };

(async () => {
  // ── registry construction ───────────────────────────────────────────────────
  await test('REQUIRED_MEMBERS is the interface: provider + seven operations', async () => {
    assert.deepStrictEqual(REQUIRED_MEMBERS, ['provider', 'parseIds', 'openStoriesRead', 'currentSprint',
      'readStory', 'testingChildren', 'storyRow', 'validate']);
  });

  await test('defaultRegistry registers ado and jira, each a complete strategy under its own key', async () => {
    assert.deepStrictEqual(defaultRegistry.providers(), ['ado', 'jira']);
    for (const p of defaultRegistry.providers()) {
      const s = defaultRegistry.get(p);
      assert.strictEqual(s.provider, p);
      for (const m of REQUIRED_MEMBERS.slice(1)) assert.strictEqual(typeof s[m], 'function', `${p}.${m}`);
    }
  });

  await test('createRegistry: providers() in insertion order; get() returns the registered strategy', async () => {
    const a = stub('acme'); const b = stub('zeta');
    const r = createRegistry({ zeta: b, acme: a });
    assert.deepStrictEqual(r.providers(), ['zeta', 'acme']);
    assert.strictEqual(r.get('acme'), a);
  });

  await test('get(unknown) refuses with exit 2, naming the provider and listing the providers that have one', async () => {
    const e = refusal(() => createRegistry({ ado: stub('ado') }).get('jira'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /'jira'/);
    assert.match(e.message, /providers with one: ado\./);
    assert.match(e.message, /Refusing rather than falling back/);
    assert.ok(!(e instanceof TypeError));
    const proto = refusal(() => createRegistry({}).get('toString'));
    assert.strictEqual(proto.exitCode, 2, 'inherited object keys are not strategies');
    assert.match(proto.message, /providers with one: none/);
  });

  await test('get() refuses (exit 2) a registered strategy missing a required member, naming it', async () => {
    const e = refusal(() => createRegistry({ acme: stub('acme', ['storyRow', 'validate']) }).get('acme'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /missing required member\(s\): storyRow, validate/);
    const np = refusal(() => createRegistry({ acme: stub('acme', ['provider']) }).get('acme'));
    assert.match(np.message, /missing required member\(s\): provider/);
  });

  await test('get() refuses (exit 2) a strategy whose provider differs from its registry key', async () => {
    const e = refusal(() => createRegistry({ acme: stub('zeta') }).get('acme'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /registered under 'acme' declares provider 'zeta'/);
  });

  await test('compat: the pinned exports create-tasks.js keeps', async () => {
    assert.strictEqual(compat.PARENT_LINK, 'System.LinkTypes.Hierarchy-Reverse');
    assert.ok(compat.currentIterationWiql('P', 'T').includes("@CurrentIteration('[P]\\T')"));
    assert.strictEqual(compat.currentSprintJql('PROJ', 'Story'), 'project = "PROJ" AND issuetype = "Story" AND sprint in openSprints() ORDER BY key');
  });

  // ── structural doctrine on every strategy module ────────────────────────────
  const modules = fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'));
  await test('every strategies/*.js module: no child_process/spawn, no process.exit(, only node: or relative requires', async () => {
    assert.ok(modules.length >= 4, modules.join(', '));
    for (const n of modules) {
      const src = fs.readFileSync(path.join(__dirname, n), 'utf8');
      assert.ok(!/child_process|spawnSync|execSync|\bspawn\(/.test(src), `${n} must not spawn processes`);
      assert.ok(!src.includes('process.exit('), `${n} must not force-exit`);
      for (const m of src.matchAll(/require\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        // node: builtins, sibling modules, or the repo's tracker lib (path.join(LIB, …)) — never a package.
        assert.ok(/^'node:/.test(arg) || /^'\.\.?\//.test(arg) || /^path\.join\((LIB|__dirname)\b/.test(arg),
          `${n}: require(${arg}) is not a node: builtin or a repo-relative path`);
      }
    }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
