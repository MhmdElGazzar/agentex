'use strict';
// Unit tests for the tracker-ops skill's workitem.js (design WP-6 / F-1).
// Run: node skills/tracker-ops/scripts/workitem.test.js
// Fully offline: fetch is INJECTED — a scripted fake with call recording.
// No network, no tracker, no CLI. spawnSync appears ONLY here (test-side) to
// pin the one-JSON-line CLI contract; the delivered script spawns nothing.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./workitem.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_TOKEN = 'SENTINEL-JIRA-TOKEN-wi-a1b2c3d4e5f6';
const SENTINEL_EMAIL = 'sentinel.ops@example.com';
const SENTINEL_PAT = 'SENTINEL-PAT-wi-00112233445566778899';

// The tests own the credential environment — real values must not leak in.
for (const n of ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT', 'AGENTEX_CI']) delete process.env[n];

// Throwaway consumer projects — one per provider.
function jproj(jiraExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-wi-j-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ jira: { site: 'example', project: 'PROJ', ...jiraExtra } }));
  fs.writeFileSync(path.join(dir, '.env'), `JIRA_EMAIL=${SENTINEL_EMAIL}\nJIRA_API_TOKEN=${SENTINEL_TOKEN}\n`);
  return dir;
}
function aproj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-wi-a-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org: 'exampleorg', project: 'Sample Project' } }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}
function writeSpec(dir, obj) {
  const p = path.join(dir, `spec-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// Scripted fake fetch: matches [method + url substring], records every call.
function fakeFetch(routes = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    for (const r of routes) {
      if ((r.method || 'GET') !== (opts.method || 'GET')) continue;
      if (!String(url).includes(r.match)) continue;
      const status = r.status || 200;
      const text = r.text !== undefined ? r.text : JSON.stringify(r.json !== undefined ? r.json : {});
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

const J_TRANSITIONS = { transitions: [
  { id: '11', name: 'In Progress', to: { name: 'In Progress' } },
  { id: '21', name: 'Done', to: { name: 'Done' } },
] };
function jRoutes(extra = []) {
  return [
    ...extra,
    { match: '/issue/PROJ-1/transitions', json: J_TRANSITIONS },
    { method: 'POST', match: '/issue/PROJ-1/transitions', status: 204, text: '' },
    { method: 'POST', match: '/issue/PROJ-1/comment', json: { id: '9001' } },
    { method: 'POST', match: '/rest/api/3/issueLink', status: 201, text: '' },
    { method: 'PUT', match: '/rest/api/3/issue/PROJ-1', status: 204, text: '' },
    { match: '/rest/api/3/issue/PROJ-1', json: { key: 'PROJ-1', fields: { issuetype: { name: 'Story' }, summary: 'Checkout', status: { name: 'To Do' } }, renderedFields: { description: '<p>x</p>' } } },
    { method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 'Checkout' } }] } },
    { method: 'POST', match: '/rest/api/3/issue', json: { key: 'PROJ-2' } },
  ];
}
const isWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/search/jql')) && !(c.method === 'POST' && c.url.includes('/wiql'));

(async () => {
  // ── reads ───────────────────────────────────────────────────────────────────
  await test('show (jira): provider-neutral summary — id, type, title, state, url', async () => {
    const { code, out } = await run(['show', '--id', 'PROJ-1'], { cwd: jproj(), fetch: fakeFetch(jRoutes()) });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.workItem.id, 'PROJ-1');
    assert.strictEqual(out.workItem.type, 'Story');
    assert.strictEqual(out.workItem.state, 'To Do');
    assert.ok(out.workItem.url.includes('/browse/PROJ-1'));
  });

  await test('search (jira): the query passes through as JQL; results carry ids + titles', async () => {
    const f = fakeFetch(jRoutes());
    const { code, out } = await run(['search', '--query', 'project = "PROJ" AND status = "To Do"'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].id, 'PROJ-1');
    assert.strictEqual(out.results[0].title, 'Checkout');
    const q = f.calls.find((c) => c.url.includes('/search/jql'));
    assert.match(q.body, /project = \\"PROJ\\"/);
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'search is a read');
  });

  // ── dry-run default / --execute split, per write subcommand ───────────────
  await test('create (jira): dry run plans the POST and sends NOTHING; --execute creates and returns key + url', async () => {
    const dir = jproj();
    const spec = writeSpec(dir, { fields: { summary: 'ad-hoc task' } });
    const f1 = fakeFetch(jRoutes());
    const r1 = await run(['create', '--type', 'Task', '--spec', spec], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.strictEqual(r1.out.plan.length, 1);
    assert.strictEqual(r1.out.plan[0].request.method, 'POST');
    assert.match(r1.out.note, /nothing has been written/i);
    assert.strictEqual(f1.calls.filter(isWrite).length, 0, 'dry run writes nothing');
    const f2 = fakeFetch(jRoutes());
    const r2 = await run(['create', '--type', 'Task', '--spec', spec, '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.strictEqual(r2.out.mode, 'executed');
    assert.strictEqual(r2.out.result.id, 'PROJ-2');
    assert.ok(r2.out.result.url.includes('/browse/PROJ-2'));
    assert.strictEqual(f2.calls.filter(isWrite).length, 1, 'exactly the one approved write');
  });

  await test('update (jira): dry run → descriptor only; --execute → PUT on the wire', async () => {
    const dir = jproj();
    const spec = writeSpec(dir, { fields: { summary: 'renamed' } });
    const f1 = fakeFetch(jRoutes());
    const r1 = await run(['update', '--id', 'PROJ-1', '--spec', spec], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.strictEqual(f1.calls.filter(isWrite).length, 0);
    const f2 = fakeFetch(jRoutes());
    const r2 = await run(['update', '--id', 'PROJ-1', '--spec', spec, '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    const w = f2.calls.filter(isWrite);
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].method, 'PUT');
    assert.match(w[0].body, /renamed/);
  });

  await test('transition (jira): the dry run resolves the REAL transition and sends no POST; --execute posts the resolved id', async () => {
    const dir = jproj();
    const f1 = fakeFetch(jRoutes());
    const r1 = await run(['transition', '--id', 'PROJ-1', '--to', 'done'], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.strictEqual(r1.out.plan[0].transition.id, '21');
    assert.strictEqual(r1.out.plan[0].transition.name, 'Done');
    assert.strictEqual(f1.calls.filter(isWrite).length, 0, 'the transitions read is free; the POST waits for approval');
    const f2 = fakeFetch(jRoutes());
    const r2 = await run(['transition', '--id', 'PROJ-1', '--to', 'Done', '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    const w = f2.calls.filter(isWrite);
    assert.strictEqual(w.length, 1);
    assert.deepStrictEqual(JSON.parse(w[0].body), { transition: { id: '21' } });
  });

  await test('transition (jira) FAILS CLOSED on no match — the error lists the REAL available transitions', async () => {
    const { code, out } = await run(['transition', '--id', 'PROJ-1', '--to', 'Nonexistent'], { cwd: jproj(), fetch: fakeFetch(jRoutes()) });
    assert.strictEqual(code, 1, JSON.stringify(out));
    assert.match(out.error.serverMessage, /In Progress/);
    assert.match(out.error.serverMessage, /Done/);
  });

  await test('comment (jira): a plain string body is ADF-wrapped; dry run sends nothing', async () => {
    const dir = jproj();
    const f1 = fakeFetch(jRoutes());
    const r1 = await run(['comment', '--id', 'PROJ-1', '--body', 'retested on qc — passes'], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.strictEqual(f1.calls.filter(isWrite).length, 0);
    const f2 = fakeFetch(jRoutes());
    const r2 = await run(['comment', '--id', 'PROJ-1', '--body', 'retested on qc — passes', '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    const w = f2.calls.filter(isWrite);
    assert.strictEqual(w.length, 1);
    const body = JSON.parse(w[0].body);
    assert.strictEqual(body.body.type, 'doc', 'plain strings are wrapped via toAdf by the adapter');
    assert.strictEqual(body.body.version, 1);
  });

  await test('link (jira): dry run → descriptor; --execute → issueLink with the named type, acting item outward', async () => {
    const dir = jproj();
    const f1 = fakeFetch(jRoutes());
    const r1 = await run(['link', '--id', 'PROJ-1', '--type', 'Relates', '--target', 'PROJ-2'], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.strictEqual(f1.calls.filter(isWrite).length, 0);
    const f2 = fakeFetch(jRoutes());
    const r2 = await run(['link', '--id', 'PROJ-1', '--type', 'Relates', '--target', 'PROJ-2', '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    const w = f2.calls.filter(isWrite);
    assert.strictEqual(w.length, 1);
    const body = JSON.parse(w[0].body);
    assert.deepStrictEqual(body.type, { name: 'Relates' });
    assert.deepStrictEqual(body.outwardIssue, { key: 'PROJ-1' });
    assert.deepStrictEqual(body.inwardIssue, { key: 'PROJ-2' });
  });

  // ── capability flags answer unsupported ops UPFRONT ───────────────────────
  await test('transition (ADO) routes to the honest State-field update — stated in the plan, PATCH System.State on --execute', async () => {
    const dir = aproj();
    const f1 = fakeFetch([]);
    const r1 = await run(['transition', '--id', '42', '--to', 'Active'], { cwd: dir, fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.match(r1.out.note, /State[- ]field update/i, 'the honest ADO equivalent is stated to the user');
    assert.match(JSON.stringify(r1.out.plan[0]), /System\.State/);
    assert.strictEqual(f1.calls.filter(isWrite).length, 0);
    const f2 = fakeFetch([{ method: 'PATCH', match: '/wit/workitems/42', json: { id: 42, rev: 2 } }]);
    const r2 = await run(['transition', '--id', '42', '--to', 'Active', '--execute'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    const w = f2.calls.filter((c) => c.method === 'PATCH');
    assert.strictEqual(w.length, 1);
    assert.match(w[0].body, /System\.State/);
    assert.match(w[0].body, /Active/);
    assert.match(r2.out.note, /State[- ]field update/i);
  });

  await test('comment (ADO) is refused UPFRONT naming the capability flag — exit 2, zero requests', async () => {
    const f = fakeFetch([]);
    const { code, out } = await run(['comment', '--id', '42', '--body', 'x'], { cwd: aproj(), fetch: f });
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.ok(out.blocked.some((b) => b.reason === 'unsupported-op'), JSON.stringify(out));
    assert.match(JSON.stringify(out.blocked), /capabilities\.comments/);
    assert.match(JSON.stringify(out.blocked), /not supported on this tracker/);
    assert.strictEqual(f.calls.length, 0);
  });

  // ── CI guard (AGENTEX_CI=1): writes refused, reads and dry runs unaffected ──
  await test('CI guard: --execute under AGENTEX_CI=1 is refused BEFORE any read — exit 2, ci-mode, zero calls', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const dir = jproj();
      const spec = writeSpec(dir, { fields: { summary: 't' } });
      const f = fakeFetch(jRoutes());
      const { code, out } = await run(['create', '--type', 'Task', '--spec', spec, '--execute'], { cwd: dir, fetch: f });
      assert.strictEqual(code, 2, JSON.stringify(out));
      assert.ok(out.blocked.some((b) => b.reason === 'ci-mode'), JSON.stringify(out));
      assert.match(JSON.stringify(out.blocked), /tracker writes are disabled in CI/);
      assert.strictEqual(f.calls.length, 0, 'refused before any request left the machine');
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('CI guard: reads and dry-run plans are UNAFFECTED under AGENTEX_CI=1', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const dir = jproj();
      const r1 = await run(['show', '--id', 'PROJ-1'], { cwd: dir, fetch: fakeFetch(jRoutes()) });
      assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
      const f = fakeFetch(jRoutes());
      const r2 = await run(['comment', '--id', 'PROJ-1', '--body', 'x'], { cwd: dir, fetch: f });
      assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
      assert.strictEqual(r2.out.mode, 'plan');
      assert.strictEqual(f.calls.filter(isWrite).length, 0);
    } finally { delete process.env.AGENTEX_CI; }
  });

  // ── CLI contract: exactly one JSON line, bad usage exits 2 ─────────────────
  await test('CLI with no args: exit 2, exactly ONE JSON line on stdout', async () => {
    const dir = jproj();
    const r = spawnSync(process.execPath, [path.join(__dirname, 'workitem.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
  });

  // ── structural pins ────────────────────────────────────────────────────────
  await test('no child_process and no process.exit in the delivered script (structural source read)', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'workitem.js'), 'utf8');
    assert.ok(!/child_process|spawnSync|execSync/.test(src), 'workitem.js must not spawn processes');
    assert.ok(!src.includes('process.exit('), 'workitem.js must not force-exit (exit-drain doctrine)');
  });

  // ── sentinel sweep: credentials in ZERO bytes of any output ────────────────
  await test('sentinel credentials absent from every mode\'s output on both providers', async () => {
    const outs = [];
    const jd = jproj();
    const spec = writeSpec(jd, { fields: { summary: 't' } });
    outs.push(await run(['show', '--id', 'PROJ-1'], { cwd: jd, fetch: fakeFetch(jRoutes()) }));
    outs.push(await run(['create', '--type', 'Task', '--spec', spec], { cwd: jd, fetch: fakeFetch(jRoutes()) }));
    outs.push(await run(['create', '--type', 'Task', '--spec', spec, '--execute'], { cwd: jd, fetch: fakeFetch(jRoutes()) }));
    outs.push(await run(['transition', '--id', 'PROJ-1', '--to', 'Nope'], { cwd: jd, fetch: fakeFetch(jRoutes()) }));
    const ad = aproj();
    outs.push(await run(['transition', '--id', '42', '--to', 'Active'], { cwd: ad, fetch: fakeFetch([]) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_TOKEN), 'jira token leaked');
    assert.ok(!all.includes(SENTINEL_EMAIL), 'jira email leaked');
    assert.ok(!all.includes(SENTINEL_PAT), 'PAT leaked');
    assert.ok(!all.includes(Buffer.from(`${SENTINEL_EMAIL}:${SENTINEL_TOKEN}`).toString('base64')), 'basic pair leaked');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
