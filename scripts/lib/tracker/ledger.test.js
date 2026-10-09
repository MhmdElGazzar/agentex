'use strict';
// Unit tests for the tracker write-plan ledger. Run: node scripts/lib/tracker/ledger.test.js
// Offline by construction — intents are plain closures, nothing touches a network.
const assert = require('node:assert');
const { WritePlan } = require('./ledger.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

(async () => {
  await test('plan() lists every intent, in declared order, without running anything', async () => {
    let ran = 0;
    const plan = new WritePlan([
      { step: 'upload', describe: 'POST .../attachments', run: async () => { ran++; return {}; } },
      { step: 'create', describe: 'POST .../workitems/$Bug', run: async () => { ran++; return {}; } },
    ]);
    assert.deepStrictEqual(plan.plan(), [
      { step: 'upload', describe: 'POST .../attachments' },
      { step: 'create', describe: 'POST .../workitems/$Bug' },
    ]);
    assert.strictEqual(ran, 0, 'plan() must not execute intents');
  });

  await test('execute() runs intents sequentially in declared order', async () => {
    const order = [];
    const plan = new WritePlan([
      { step: 'a', describe: 'first', run: async () => { order.push('a'); return { id: 1 }; } },
      { step: 'b', describe: 'second', run: async () => { order.push('b'); return { id: 2 }; } },
      { step: 'c', describe: 'third', run: async () => { order.push('c'); return { id: 3 }; } },
    ]);
    const ledger = await plan.execute();
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    assert.deepStrictEqual(ledger.map((l) => l.status), ['done', 'done', 'done']);
    assert.deepStrictEqual(ledger.map((l) => l.id), [1, 2, 3]);
  });

  await test('first failure stops the plan — later steps are not-attempted, never run', async () => {
    const order = [];
    const plan = new WritePlan([
      { step: 'a', describe: 'ok', run: async () => { order.push('a'); return { id: 10, url: 'https://x/10' }; } },
      { step: 'b', describe: 'boom', run: async () => { order.push('b'); throw new Error('server said no'); } },
      { step: 'c', describe: 'never', run: async () => { order.push('c'); return { id: 30 }; } },
    ]);
    const ledger = await plan.execute();
    assert.deepStrictEqual(order, ['a', 'b'], 'step c must never run');
    assert.strictEqual(ledger[0].status, 'done');
    assert.strictEqual(ledger[1].status, 'failed');
    assert.strictEqual(ledger[1].reason, 'server said no');
    assert.strictEqual(ledger[2].status, 'not-attempted');
    assert.strictEqual(ledger[2].id, undefined);
  });

  await test('IDs + URLs captured by earlier steps survive a mid-plan throw', async () => {
    const plan = new WritePlan([
      { step: 'create', describe: 'create Bug', run: async () => ({ id: 4711, url: 'https://org/proj/_workitems/edit/4711' }) },
      { step: 'link', describe: 'parent link', run: async () => { throw new Error('403 forbidden'); } },
    ]);
    const ledger = await plan.execute();
    assert.strictEqual(ledger[0].id, 4711, 'the created ID must be in the ledger');
    assert.strictEqual(ledger[0].url, 'https://org/proj/_workitems/edit/4711');
    assert.strictEqual(ledger[1].status, 'failed');
  });

  await test('no step is ever re-invoked — no retry, no cleanup', async () => {
    const calls = { a: 0, b: 0 };
    const plan = new WritePlan([
      { step: 'a', describe: 'ok', run: async () => { calls.a++; return {}; } },
      { step: 'b', describe: 'fails', run: async () => { calls.b++; throw new Error('transient-looking error'); } },
    ]);
    await plan.execute();
    assert.strictEqual(calls.a, 1);
    assert.strictEqual(calls.b, 1, 'a failed step must not be retried');
  });

  await test('execute() never throws — the ledger IS the failure report', async () => {
    const plan = new WritePlan([
      { step: 'only', describe: 'fails', run: async () => { throw new Error('x'); } },
    ]);
    const ledger = await plan.execute();
    assert.strictEqual(ledger[0].status, 'failed');
  });

  await test('every ledger entry carries step + describe (exact intended-write accounting)', async () => {
    const plan = new WritePlan([
      { step: 's1', describe: 'd1', run: async () => ({}) },
      { step: 's2', describe: 'd2', run: async () => { throw new Error('e'); } },
      { step: 's3', describe: 'd3', run: async () => ({}) },
    ]);
    const ledger = await plan.execute();
    assert.deepStrictEqual(ledger.map((l) => [l.step, l.describe]), [['s1', 'd1'], ['s2', 'd2'], ['s3', 'd3']]);
  });

  await test('a malformed intent is rejected at declaration time', async () => {
    assert.throws(() => new WritePlan([{ step: 'x' }]), /describe|run/);
    assert.throws(() => new WritePlan('nope'), /array/i);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
