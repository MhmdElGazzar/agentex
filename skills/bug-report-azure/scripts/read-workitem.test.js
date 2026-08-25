'use strict';
// Self-contained tests for read-workitem.js — the bug skill's read-only entry
// point (template-bug read, parent-story validation, title search). Offline:
// fetch is injected in-process; one spawned run proves the one-JSON-line CLI
// contract with zero network (it fails on config resolution before any fetch).
// Run: node skills/bug-report-azure/scripts/read-workitem.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./read-workitem.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-readwi-0123456789abcdef';
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT']) delete process.env[n];

function proj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-rwi-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org: 'exampleorg', project: 'Sample Project' } }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}

function fakeFetch(routes = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    for (const r of routes) {
      if ((r.method || 'GET') === (opts.method || 'GET') && String(url).includes(r.match)) {
        const status = r.status || 200;
        return { ok: status < 300, status, text: async () => JSON.stringify(r.json || {}) };
      }
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  await test('show: returns the work item (id/type/title/state/url + fields), exit 0', async () => {
    const f = fakeFetch([{
      match: '/workitems/321',
      json: { id: 321, fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'Checkout story', 'System.State': 'Active', 'System.AreaPath': 'P\\A' } },
    }]);
    const { code, out } = await run(['show', '--id', '321'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.workItem.id, 321);
    assert.strictEqual(out.workItem.type, 'User Story');
    assert.strictEqual(out.workItem.title, 'Checkout story');
    assert.strictEqual(out.workItem.state, 'Active');
    assert.ok(out.workItem.url.includes('321'));
    assert.strictEqual(out.workItem.fields['System.AreaPath'], 'P\\A');
  });

  await test('show --expand all propagates $expand and returns relations', async () => {
    const f = fakeFetch([{
      match: '/workitems/9',
      json: { id: 9, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 't' }, relations: [{ rel: 'AttachedFile' }] },
    }]);
    const { code, out } = await run(['show', '--id', '9', '--expand', 'all'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0);
    assert.match(f.calls[0].url, /\$expand=all/);
    assert.deepStrictEqual(out.workItem.relations, [{ rel: 'AttachedFile' }]);
  });

  await test('show: a 404 is a clean not-found failure, exit 1', async () => {
    const f = fakeFetch([{ match: '/workitems/999', status: 404, json: { message: 'work item 999 does not exist' } }]);
    const { code, out } = await run(['show', '--id', '999'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error.status, 404);
    assert.match(out.error.message, /999/);
  });

  await test('find: returns matching ids (and an empty list is a happy result)', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/wiql', json: { workItems: [{ id: 11 }] } }]);
    const r1 = await run(['find', '--type', 'Bug', '--title', 'Payment fails'], { cwd: proj(), fetch: f });
    assert.strictEqual(r1.code, 0);
    assert.deepStrictEqual(r1.out.ids, [11]);
    const f2 = fakeFetch([{ method: 'POST', match: '/wiql', json: { workItems: [] } }]);
    const r2 = await run(['find', '--type', 'Bug', '--title', 'Nothing like this'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.code, 0);
    assert.deepStrictEqual(r2.out.ids, []);
  });

  await test('missing subcommand / missing required flags exit 2 with usage in the JSON', async () => {
    for (const argv of [[], ['show'], ['find', '--type', 'Bug'], ['nonsense']]) {
      const { code, out } = await run(argv, { cwd: proj(), fetch: fakeFetch([]) });
      assert.strictEqual(code, 2, JSON.stringify(argv));
      assert.strictEqual(out.ok, false);
      assert.ok(out.error && out.error.message);
    }
  });

  await test('no write surface: only GETs and the WIQL POST ever leave the script', async () => {
    const f = fakeFetch([
      { match: '/workitems/1', json: { id: 1, fields: {} } },
      { method: 'POST', match: '/wiql', json: { workItems: [] } },
    ]);
    const dir = proj();
    await run(['show', '--id', '1'], { cwd: dir, fetch: f });
    await run(['find', '--type', 'Bug', '--title', 'x'], { cwd: dir, fetch: f });
    for (const c of f.calls) {
      assert.ok(c.method === 'GET' || (c.method === 'POST' && c.url.includes('/wiql')),
        `unexpected ${c.method} ${c.url}`);
    }
    const src = fs.readFileSync(path.join(__dirname, 'read-workitem.js'), 'utf8');
    assert.ok(!src.includes('execute: true'), 'the script must not carry a write path');
    assert.ok(!/child_process/.test(src), 'no process spawning in the delivered script');
  });

  await test('sentinel PAT never reaches stdout/stderr (spawned CLI run, one JSON line, zero network)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-rwi-'));
    fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`); // no tracker config on purpose
    const r = spawnSync(process.execPath, [path.join(__dirname, 'read-workitem.js'), 'show', '--id', '1'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, AZURE_PAT: SENTINEL_PAT },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'exactly one JSON line');
    const out = JSON.parse(lines[0]);
    assert.strictEqual(out.ok, false);
    assert.ok(!r.stdout.includes(SENTINEL_PAT) && !r.stderr.includes(SENTINEL_PAT), 'PAT leaked');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
