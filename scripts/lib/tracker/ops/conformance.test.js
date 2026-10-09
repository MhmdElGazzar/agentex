'use strict';
// Shared conformance suite: the properties EVERY registered tracker-ops
// strategy must have (the golden suite pins the bytes; this pins the contract).
// Run: node scripts/lib/tracker/ops/conformance.test.js
//
// It iterates defaultRegistry.providers() — no hand-maintained list — and
// requires conformance/<provider>.fixture.js for each; a registered strategy
// without a fixture FAILS. Then it registers a synthetic third provider
// (conformance/stub.fixture.js: an in-memory 'acme' adapter + a stub strategy)
// and runs it through the UNMODIFIED scripts/tracker.js spine with the same
// checks.
//
// Fixture contract (conformance/<provider>.fixture.js):
//   refs { item, item2, missing }  ids the routes answer for (missing: one a batch read lacks)
//   batchFields        the field list a batch read asks for
//   query              a search text in the provider's query language
//   transitionTo       a transition target the routes resolve
//   project(dir)       writes config/project.json (+ a .env with sentinel credentials)
//   routes()           fake-fetch routes (real providers) — or inMemory(caps) (stub)
//   isWrite(call)      true for a board write request
// Offline: every request goes to an injected fake fetch (or the in-memory
// adapter). No network, ever.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require(path.join(__dirname, '..', '..', '..', 'tracker.js'));
const { REQUIRED_MEMBERS, defaultRegistry, makeRegistry } = require('./index.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

for (const k of Object.keys(process.env)) {
  if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { method: opts.method || 'GET', url: String(url), body: opts.body };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method || !call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const resp = r.respond ? r.respond(call) : r;
      const status = resp.status || 200;
      const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.json ?? {});
      return { ok: status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

// One spine run against a fixture. caps: capability overrides (stub only).
async function exec(fixture, registry, argv, { caps } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ops-conf-'));
  fixture.project(dir);
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ fields: {} }));
  const args = argv.map((a) => (a === '{SPEC}' ? spec : a));
  if (fixture.inMemory) {
    const { adapter, calls } = fixture.inMemory(caps);
    const r = await run(args, { cwd: dir, registry, resolveTracker: () => adapter });
    return { ...r, calls };
  }
  const f = fakeFetch(fixture.routes());
  const r = await run(args, { cwd: dir, fetch: f, registry });
  return { ...r, calls: f.calls };
}

const SUMMARY_KEYS = ['id', 'type', 'title', 'state', 'url', 'fields'];
const strOrNull = (v) => v === null || typeof v === 'string';

async function conformance(key, strategy, fixture, registry) {
  const { refs } = fixture;
  const writes = (r) => r.calls.filter(fixture.isWrite);

  await test(`[${key}] 1. every contract member exists with the right type; provider === its registry key`, async () => {
    for (const m of REQUIRED_MEMBERS) assert.strictEqual(typeof strategy[m], m === 'provider' ? 'string' : 'function', `${key}.${m}`);
    assert.strictEqual(strategy.provider, key);
    assert.strictEqual(registry.get(key), strategy);
  });

  await test(`[${key}] 2. show returns the neutral summary shape`, async () => {
    const r = await exec(fixture, registry, ['show', '--id', refs.item]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.provider, key);
    for (const k of SUMMARY_KEYS) assert.ok(k in r.out.workItem, `summary key ${k}`);
    const w = r.out.workItem;
    assert.ok(typeof w.id === 'string' || typeof w.id === 'number');
    assert.ok(strOrNull(w.type) && strOrNull(w.title) && strOrNull(w.state));
    assert.strictEqual(typeof w.url, 'string');
    assert.strictEqual(writes(r).length, 0);
  });

  await test(`[${key}] 3. search returns neutral rows (id + url), count === rows; a read`, async () => {
    const r = await exec(fixture, registry, ['search', '--query', fixture.query]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(Array.isArray(r.out.results) && r.out.results.length > 0);
    assert.strictEqual(r.out.count, r.out.results.length);
    for (const row of r.out.results) { assert.ok('id' in row); assert.strictEqual(typeof row.url, 'string'); }
    assert.strictEqual(writes(r).length, 0);
  });

  await test(`[${key}] 4. nothing is written without --execute (transition / update / comment / link / create)`, async () => {
    for (const argv of [
      ['transition', '--id', refs.item, '--to', fixture.transitionTo],
      ['update', '--id', refs.item, '--spec', '{SPEC}'],
      ['comment', '--id', refs.item, '--body', 'x'],
      ['link', '--id', refs.item, '--type', 'Relates', '--target', refs.item],
      ['create', '--type', 'Task', '--spec', '{SPEC}'],
    ]) {
      const r = await exec(fixture, registry, argv);
      assert.ok(r.code === 0 || r.code === 2, `${argv[0]}: ${JSON.stringify(r.out)}`);
      if (r.code === 0) {
        assert.strictEqual(r.out.mode, 'plan', argv[0]);
        assert.ok(Array.isArray(r.out.plan) && r.out.plan.length >= 1, argv[0]);
        assert.match(r.out.note, /nothing has been written/);
      }
      assert.strictEqual(writes(r).length, 0, `${argv[0]} wrote without --execute`);
    }
  });

  await test(`[${key}] 6. batch returns {items:[{id, fields}], missing} in input order with only the asked fields`, async () => {
    const r = await exec(fixture, registry, ['batch', '--ids', [refs.item2, refs.item, refs.missing].join(','), '--fields', fixture.batchFields.join(',')]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.items.map((i) => String(i.id)), [String(refs.item2), String(refs.item)]);
    for (const i of r.out.items) assert.deepStrictEqual(Object.keys(i.fields), fixture.batchFields);
    assert.deepStrictEqual(r.out.missing.map(String), [String(refs.missing)]);
    assert.strictEqual(writes(r).length, 0);
  });

  await test(`[${key}] 7. comments return [{author, date, text}] oldest first, plain text`, async () => {
    const r = await exec(fixture, registry, ['comments', '--id', refs.item]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.comments.map((c) => Object.keys(c)), [['author', 'date', 'text'], ['author', 'date', 'text']]);
    assert.deepStrictEqual(r.out.comments.map((c) => c.text), ['first', 'second']);
    assert.ok(r.out.comments[0].date < r.out.comments[1].date);
  });

  await test(`[${key}] 8. relations --kind child returns neutral rows; iterations returns neutral rows`, async () => {
    const r = await exec(fixture, registry, ['relations', '--id', refs.item, '--kind', 'child']);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const rel = r.out.items[0].relations;
    assert.ok(rel.length >= 1);
    for (const x of rel) {
      assert.strictEqual(x.kind, 'child');
      for (const k of ['id', 'type', 'title', 'state']) assert.ok(k in x, `relation key ${k}`);
    }
    const it = await exec(fixture, registry, ['iterations', '--timeframe', 'current']);
    assert.strictEqual(it.code, 0, JSON.stringify(it.out));
    assert.ok(it.out.iterations.length >= 1);
    for (const x of it.out.iterations) {
      for (const k of ['id', 'name', 'startDate', 'finishDate', 'timeFrame']) assert.ok(k in x, `iteration key ${k}`);
      assert.strictEqual(x.timeFrame, 'current');
    }
    assert.strictEqual(writes(r).length + writes(it).length, 0);
  });

  await test(`[${key}] 5. under AGENTEX_CI=1 every --execute write is refused BEFORE any read (zero requests)`, async () => {
    process.env.AGENTEX_CI = '1';
    try {
      for (const argv of [
        ['transition', '--id', refs.item, '--to', fixture.transitionTo, '--execute'],
        ['update', '--id', refs.item, '--spec', '{SPEC}', '--execute'],
        ['comment', '--id', refs.item, '--body', 'x', '--execute'],
        ['link', '--id', refs.item, '--type', 'Relates', '--target', refs.item, '--execute'],
        ['create', '--type', 'Task', '--spec', '{SPEC}', '--execute'],
      ]) {
        const r = await exec(fixture, registry, argv);
        assert.strictEqual(r.code, 2, `${argv[0]}: ${JSON.stringify(r.out)}`);
        assert.ok(r.out.blocked.some((b) => b.reason === 'ci-mode'));
        assert.strictEqual(r.calls.length, 0, `${argv[0]}: a request was sent before the CI refusal`);
      }
    } finally { delete process.env.AGENTEX_CI; }
  });
}

(async () => {
  // Every registered strategy needs a fixture — no hand-maintained list.
  for (const p of defaultRegistry.providers()) {
    const file = path.join(__dirname, 'conformance', `${p}.fixture.js`);
    if (!fs.existsSync(file)) {
      await test(`[${p}] has a conformance fixture`, async () => { throw new Error(`missing ${path.relative(__dirname, file)}`); });
      continue;
    }
    await conformance(p, defaultRegistry.get(p), require(file), defaultRegistry);
  }

  // Synthetic third provider through the unmodified spine.
  const stub = require('./conformance/stub.fixture.js');
  const stubRegistry = makeRegistry({ ...Object.fromEntries(defaultRegistry.providers().map((p) => [p, defaultRegistry.get(p)])), [stub.provider]: stub.strategy });
  await conformance(stub.provider, stub.strategy, stub, stubRegistry);

  await test('[acme] a capability flag set to false is refused upfront even with a registered strategy (zero calls)', async () => {
    const r = await exec(stub, stubRegistry, ['comment', '--id', 'A-1', '--body', 'x'], { caps: { comments: false } });
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.ok(r.out.blocked.some((b) => b.reason === 'unsupported-op'));
    assert.match(JSON.stringify(r.out.blocked), /capabilities\.comments: false/);
    assert.strictEqual(r.calls.length, 0);
  });

  await test('[acme] without its registry line the same adapter is refused — read and write, zero calls', async () => {
    for (const argv of [['show', '--id', 'A-1'], ['update', '--id', 'A-1', '--spec', '{SPEC}', '--execute']]) {
      const r = await exec(stub, defaultRegistry, argv);
      assert.strictEqual(r.code, 2, JSON.stringify(r.out));
      assert.match(r.out.error.message, /No tracker-ops strategy is registered for tracker provider 'acme'/);
      assert.strictEqual(r.calls.length, 0);
    }
  });

  await test('structural: no ops/*.js module spawns, force-exits, or requires an npm package', async () => {
    for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(!/child_process|spawnSync|execSync/.test(src), name);
      assert.ok(!src.includes('process.exit('), name);
      for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) assert.ok(/^(node:|\.)/.test(m[1]), `${name}: ${m[1]}`);
    }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
