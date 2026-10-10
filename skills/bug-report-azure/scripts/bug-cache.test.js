'use strict';
// Focused tests for the project-wide Bug cache. The adapter is a stub; no network.
// Run: node skills/bug-report-azure/scripts/bug-cache.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sync, cacheFile, scopeWiql, FULL_REBUILD_DAYS } = require('./bug-cache.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack || e.message}`); }
}

const NOW = new Date('2026-10-09T12:00:00Z');
const later = (days) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

function project(azure = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bc-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: { org: 'exampleorg', project: 'Sample Project', ...azure },
  }));
  return dir;
}

function bug(id, title, { state = 'Active', parent = 321, changed = '2026-10-01T09:00:00Z', type = 'Bug' } = {}) {
  return { id, fields: {
    'System.Id': id, 'System.WorkItemType': type, 'System.Title': title, 'System.State': state,
    'System.Parent': parent, 'System.ChangedDate': changed,
  } };
}

// A board of work items; query returns whatever `rows` says, getWorkItems reads the board.
function adapter(board, { areaPath = null, rows, omit = [], queryError, rawQuery, rawItems } = {}) {
  const calls = { queries: [], batches: [] };
  return {
    calls,
    name: 'ado',
    config: { base: 'https://dev.azure.com/exampleorg', project: 'Sample Project', areaPath },
    async query(text) {
      calls.queries.push(text);
      if (queryError) throw queryError;
      if (rawQuery !== undefined) return rawQuery;
      const ids = rows ? rows() : [...board.keys()];
      return { workItems: ids.map((id) => ({ id })) };
    },
    async getWorkItems(ids, { fields }) {
      calls.batches.push({ ids, fields });
      if (rawItems) return { items: rawItems, missing: [] };
      return {
        items: ids.filter((id) => board.has(id) && !omit.includes(id)).map((id) => board.get(id)),
        missing: ids.filter((id) => !board.has(id) || omit.includes(id)),
      };
    },
  };
}

(async () => {
  await test('the first sync is a full build over the window, written to .agentex/cache', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')], [12, bug(12, 'Wrong VAT', { parent: 400 })]]);
    const a = adapter(board);
    const out = await sync(dir, a, { now: NOW });
    assert.strictEqual(out.mode, 'full');
    assert.deepStrictEqual(out.bugs.map((b) => [b.id, b.title, b.parentId]), [[11, 'Pay button dead', 321], [12, 'Wrong VAT', 400]]);
    assert.ok(a.calls.queries[0].includes("[System.TeamProject] = 'Sample Project'"));
    assert.ok(a.calls.queries[0].includes("[System.WorkItemType] = 'Bug'"));
    assert.ok(a.calls.queries[0].includes("[System.ChangedDate] >= '2025-10-09'"), a.calls.queries[0]);
    assert.ok(a.calls.batches[0].fields.includes('Microsoft.VSTS.TCM.ReproSteps'));
    const disk = JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8'));
    assert.strictEqual(disk.syncedAt, NOW.toISOString());
    assert.deepStrictEqual(Object.keys(disk.bugs).sort(), ['11', '12']);
  });

  await test('a later sync reads only the delta since the day before the last sync and merges it', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')], [12, bug(12, 'Wrong VAT')]]);
    await sync(dir, adapter(board), { now: NOW });
    board.set(12, bug(12, 'Wrong VAT on renewal', { changed: '2026-10-10T08:00:00Z' }));
    board.set(13, bug(13, 'Logout loops', { changed: '2026-10-10T08:30:00Z' }));
    const a = adapter(board, { rows: () => [12, 13] });
    const out = await sync(dir, a, { now: later(1) });
    assert.strictEqual(out.mode, 'delta');
    assert.ok(a.calls.queries[0].includes("[System.ChangedDate] >= '2026-10-08'"), a.calls.queries[0]);
    assert.deepStrictEqual(a.calls.batches[0].ids, [12, 13]);
    assert.deepStrictEqual(out.bugs.map((b) => [b.id, b.title]), [[11, 'Pay button dead'], [12, 'Wrong VAT on renewal'], [13, 'Logout loops']]);
  });

  await test('an empty delta skips the batch read and keeps the mirror', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await sync(dir, adapter(board), { now: NOW });
    const a = adapter(board, { rows: () => [] });
    const out = await sync(dir, a, { now: later(0.1) });
    assert.strictEqual(a.calls.batches.length, 0);
    assert.deepStrictEqual(out.bugs.map((b) => b.id), [11]);
  });

  await test('a failed query throws and leaves the previous mirror untouched', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await sync(dir, adapter(board), { now: NOW });
    const before = fs.readFileSync(cacheFile(dir), 'utf8');
    await assert.rejects(() => sync(dir, adapter(board, { queryError: new Error('HTTP 503') }), { now: later(1) }), /HTTP 503/);
    assert.strictEqual(fs.readFileSync(cacheFile(dir), 'utf8'), before);
  });

  await test('an id the batch omits fails the sync instead of shrinking the mirror', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')], [12, bug(12, 'Wrong VAT')]]);
    await assert.rejects(() => sync(dir, adapter(board, { omit: [12] }), { now: NOW }), /omitted #12/);
    assert.strictEqual(fs.existsSync(cacheFile(dir)), false);
  });

  await test('azure.bugCacheDays 0 turns the cache off with no request', async () => {
    const dir = project({ bugCacheDays: 0 });
    const a = adapter(new Map([[11, bug(11, 'x')]]));
    const out = await sync(dir, a, { now: NOW });
    assert.deepStrictEqual(out, { enabled: false, bugs: [] });
    assert.strictEqual(a.calls.queries.length, 0);
  });

  await test('an invalid azure.bugCacheDays is a config error naming the key', async () => {
    for (const bad of [-1, 2.5, '30']) {
      await assert.rejects(() => sync(project({ bugCacheDays: bad }), adapter(new Map()), { now: NOW }), /azure\.bugCacheDays/);
    }
  });

  await test('the area path scopes the query, and a changed scope forces a full rebuild', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await sync(dir, adapter(board), { now: NOW });
    const a = adapter(board, { areaPath: "Sample Project\\Team's Area" });
    const out = await sync(dir, a, { now: later(1) });
    assert.strictEqual(out.mode, 'full');
    assert.ok(a.calls.queries[0].includes("[System.AreaPath] UNDER 'Sample Project\\Team''s Area'"), a.calls.queries[0]);
  });

  await test(`a mirror whose last full build is older than ${FULL_REBUILD_DAYS} days is rebuilt (drops deleted Bugs)`, async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')], [12, bug(12, 'Wrong VAT')]]);
    await sync(dir, adapter(board), { now: NOW });
    board.delete(12);
    const out = await sync(dir, adapter(board), { now: later(FULL_REBUILD_DAYS + 1) });
    assert.strictEqual(out.mode, 'full');
    assert.deepStrictEqual(out.bugs.map((b) => b.id), [11]);
  });

  await test('Bugs that fall out of the window leave the mirror', async () => {
    const dir = project({ bugCacheDays: 20 });
    const board = new Map([[11, bug(11, 'old', { changed: '2026-09-20T00:00:00Z' })], [12, bug(12, 'new', { changed: '2026-10-08T00:00:00Z' })]]);
    await sync(dir, adapter(board), { now: NOW });
    const out = await sync(dir, adapter(board, { rows: () => [] }), { now: later(5) });
    assert.deepStrictEqual(out.bugs.map((b) => b.id), [12]);
  });

  await test('a work item that is no longer a Bug is dropped on the next delta', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await sync(dir, adapter(board), { now: NOW });
    board.set(11, bug(11, 'Pay button dead', { type: 'Task', changed: '2026-10-09T13:00:00Z' }));
    const out = await sync(dir, adapter(board), { now: later(0.5) });
    assert.deepStrictEqual(out.bugs, []);
  });

  await test('toEntry shapes the stored entry; parentId and changedDate are always kept', async () => {
    const dir = project();
    const out = await sync(dir, adapter(new Map([[11, bug(11, 'Pay button dead')]])), {
      now: NOW, toEntry: (wi) => ({ id: wi.id, title: wi.fields['System.Title'].toUpperCase(), extra: 1 }),
    });
    assert.deepStrictEqual(out.bugs[0], { id: 11, title: 'PAY BUTTON DEAD', extra: 1, parentId: 321, changedDate: '2026-10-01T09:00:00Z' });
  });

  await test('a WIQL response without a work-item list fails instead of meaning "no changes"', async () => {
    const dir = project();
    await assert.rejects(() => sync(dir, adapter(new Map(), { rawQuery: {} }), { now: NOW }), /no work-item list/);
    assert.strictEqual(fs.existsSync(cacheFile(dir)), false);
  });

  await test('a batch item without its type, or one that was not requested, fails the sync', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await assert.rejects(() => sync(dir, adapter(board, { rawItems: [{ id: 11, fields: {} }] }), { now: NOW }), /without its work item type/);
    await assert.rejects(() => sync(dir, adapter(board, { rawItems: [bug(99, 'stray')] }), { now: NOW }), /unrequested/);
    await assert.rejects(() => sync(dir, adapter(board, { rawItems: [] }), { now: NOW }), /0 of 1/);
    assert.strictEqual(fs.existsSync(cacheFile(dir)), false);
  });

  await test('a syncedAt from a clock that ran ahead does not push the delta into the future', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')]]);
    await sync(dir, adapter(board), { now: later(3) });
    const a = adapter(board, { rows: () => [] });
    await sync(dir, a, { now: NOW });
    assert.ok(a.calls.queries[0].includes("[System.ChangedDate] >= '2026-10-08'"), a.calls.queries[0]);
  });

  await test('refresh forces a full rebuild of a valid mirror', async () => {
    const dir = project();
    const board = new Map([[11, bug(11, 'Pay button dead')], [12, bug(12, 'Wrong VAT')]]);
    await sync(dir, adapter(board), { now: NOW });
    board.delete(12);
    const out = await sync(dir, adapter(board), { now: later(1), refresh: true });
    assert.strictEqual(out.mode, 'full');
    assert.deepStrictEqual(out.bugs.map((b) => b.id), [11]);
  });

  await test('the mirror folder ignores itself in git, even when .agentex/cache/ is committed', async () => {
    const dir = project();
    await sync(dir, adapter(new Map([[11, bug(11, 'x')]])), { now: NOW });
    const ignore = fs.readFileSync(path.join(path.dirname(cacheFile(dir)), '.gitignore'), 'utf8');
    assert.ok(ignore.split('\n').includes('*'), ignore);
  });

  await test('scopeWiql escapes quotes in the project name', async () => {
    assert.ok(scopeWiql("O'Brien", null, '2026-01-01').includes("[System.TeamProject] = 'O''Brien'"));
  });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} passed`);
  if (failures.length) process.exitCode = 1;
})();
