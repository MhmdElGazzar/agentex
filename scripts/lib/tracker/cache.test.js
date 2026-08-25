'use strict';
// Unit tests for the field-metadata cache. Run: node scripts/lib/tracker/cache.test.js
// Offline: the adapter is a hand-rolled fake with call counting — no network.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('./cache.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function proj() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cache-')); }

const BUG_FIELDS = [
  { referenceName: 'System.Title', name: 'Title', alwaysRequired: true },
  { referenceName: 'Microsoft.VSTS.Common.Severity', name: 'Severity', alwaysRequired: false, allowedValues: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] },
  { referenceName: 'Microsoft.VSTS.Common.Priority', name: 'Priority', alwaysRequired: false, allowedValues: ['1', '2', '3', '4'] },
  { referenceName: 'Custom.Environment', name: 'Environment', alwaysRequired: false, allowedValues: ['QA', 'UAT', 'Prod'] },
];
const TC_FIELDS = [
  { referenceName: 'System.Title', name: 'Title', alwaysRequired: true },
  { referenceName: 'System.AreaPath', name: 'Area Path', alwaysRequired: false },
];

function fakeAdapter({ bug = BUG_FIELDS, tc = TC_FIELDS, base = 'https://dev.azure.com/exampleorg', project = 'Sample Project' } = {}) {
  const a = {
    name: 'ado',
    config: { base, project, apiVersion: '7.1' },
    calls: [],
    async listFields(type) {
      a.calls.push(type);
      return type === 'Bug' ? bug : tc;
    },
  };
  return a;
}

(async () => {
  await test('first use builds the cache: one listFields per type, file written with schemaVersion', async () => {
    const dir = proj();
    const a = fakeAdapter();
    const r = await cache.ensure(dir, a, { types: ['Bug', 'Test Case'] });
    assert.strictEqual(r.rebuilt, true);
    assert.deepStrictEqual(a.calls, ['Bug', 'Test Case'], 'exactly one metadata fetch per type');
    const file = path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json');
    assert.ok(fs.existsSync(file), 'per-provider cache file exists');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(disk.schemaVersion, 1);
    assert.strictEqual(disk.provider, 'ado');
    assert.strictEqual(disk.org, 'https://dev.azure.com/exampleorg');
    assert.strictEqual(disk.project, 'Sample Project');
    assert.ok(disk.builtAt);
    assert.deepStrictEqual(disk.types.Bug.fields['Microsoft.VSTS.Common.Severity'].allowedValues,
      ['1 - Critical', '2 - High', '3 - Medium', '4 - Low']);
  });

  await test('second use reads only — zero metadata fetches', async () => {
    const dir = proj();
    await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const a2 = fakeAdapter();
    const r = await cache.ensure(dir, a2, { types: ['Bug'] });
    assert.strictEqual(r.rebuilt, false);
    assert.deepStrictEqual(a2.calls, [], 'cache hit must not touch the tracker');
  });

  await test('schemaVersion mismatch rebuilds', async () => {
    const dir = proj();
    const a = fakeAdapter();
    await cache.ensure(dir, a, { types: ['Bug'] });
    const file = path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.schemaVersion = 0;
    fs.writeFileSync(file, JSON.stringify(disk));
    const a2 = fakeAdapter();
    const r = await cache.ensure(dir, a2, { types: ['Bug'] });
    assert.strictEqual(r.rebuilt, true);
    assert.deepStrictEqual(a2.calls, ['Bug']);
  });

  await test('org/project mismatch rebuilds (a copied project must not reuse foreign metadata)', async () => {
    const dir = proj();
    await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const other = fakeAdapter({ project: 'Another Project' });
    const r = await cache.ensure(dir, other, { types: ['Bug'] });
    assert.strictEqual(r.rebuilt, true);
    assert.deepStrictEqual(other.calls, ['Bug']);
  });

  await test('refresh:true (the --refresh-fields path) rebuilds even when the cache is valid', async () => {
    const dir = proj();
    await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const a2 = fakeAdapter();
    const r = await cache.ensure(dir, a2, { types: ['Bug'], refresh: true });
    assert.strictEqual(r.rebuilt, true);
    assert.deepStrictEqual(a2.calls, ['Bug']);
  });

  await test('a requested type missing from a valid cache is fetched and merged (reads only)', async () => {
    const dir = proj();
    await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const a2 = fakeAdapter();
    const r = await cache.ensure(dir, a2, { types: ['Bug', 'Test Case'] });
    assert.deepStrictEqual(a2.calls, ['Test Case'], 'only the missing type is fetched');
    assert.ok(r.cache.types['Test Case']);
    assert.ok(r.cache.types.Bug, 'the existing type is kept');
  });

  await test('validation: a bad picklist value is caught with the real allowedValues', async () => {
    const dir = proj();
    const { cache: c } = await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const results = cache.validateValues(c, 'Bug', [
      { field: 'Microsoft.VSTS.Common.Severity', value: 'Very Bad' },
      { field: 'Microsoft.VSTS.Common.Priority', value: 2 },
    ]);
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].reason, 'invalid-value');
    assert.deepStrictEqual(results[0].allowedValues, ['1 - Critical', '2 - High', '3 - Medium', '4 - Low']);
    assert.strictEqual(results[1].ok, true, 'numeric 2 matches picklist "2"');
  });

  await test('validation: a field absent from the project type is flagged, not emitted blind', async () => {
    const dir = proj();
    const { cache: c } = await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    const [r] = cache.validateValues(c, 'Bug', [{ field: 'Custom.BugCategory', value: 'Functional' }]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'field-not-on-type');
  });

  await test('validation: a field with no allowedValues accepts any value', async () => {
    const dir = proj();
    const { cache: c } = await cache.ensure(dir, fakeAdapter(), { types: ['Test Case'] });
    const [r] = cache.validateValues(c, 'Test Case', [{ field: 'System.AreaPath', value: 'Any\\Path' }]);
    assert.strictEqual(r.ok, true);
  });

  await test('stale-cache path: liveFieldMap re-fetches without touching the file, and staleness is detectable', async () => {
    const dir = proj();
    const { cache: c } = await cache.ensure(dir, fakeAdapter(), { types: ['Bug'] });
    // The org's admin renamed the picklist values after the cache was built:
    const liveNow = fakeAdapter({
      bug: [{ referenceName: 'Custom.Environment', allowedValues: ['QA-2', 'UAT-2', 'Prod'] }],
    });
    const live = await cache.liveFieldMap(liveNow, 'Bug');
    assert.deepStrictEqual(live['Custom.Environment'].allowedValues, ['QA-2', 'UAT-2', 'Prod']);
    const cachedAllowed = c.types.Bug.fields['Custom.Environment'].allowedValues;
    assert.notDeepStrictEqual(live['Custom.Environment'].allowedValues, cachedAllowed, 'divergence detectable');
    // and the FILE was not rewritten by the live read — refresh stays the user's call:
    const disk = JSON.parse(fs.readFileSync(path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json'), 'utf8'));
    assert.deepStrictEqual(disk.types.Bug.fields['Custom.Environment'].allowedValues, ['QA', 'UAT', 'Prod']);
  });

  await test('a corrupt cache file rebuilds instead of crashing', async () => {
    const dir = proj();
    const file = path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ nope');
    const a = fakeAdapter();
    const r = await cache.ensure(dir, a, { types: ['Bug'] });
    assert.strictEqual(r.rebuilt, true);
    assert.deepStrictEqual(a.calls, ['Bug']);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
