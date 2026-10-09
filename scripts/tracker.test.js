'use strict';
// Unit tests for the plugin-root tracker CLI, scripts/tracker.js (moved from
// skills/tracker-ops/scripts/ — skill-consolidation-foundation WP-2).
// Run: node scripts/tracker.test.js
// Fully offline: fetch is INJECTED — a scripted fake with call recording.
// No network, no tracker, no CLI. spawnSync appears ONLY here (test-side) to
// pin the one-JSON-line CLI contract; the delivered script spawns nothing.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./tracker.js');

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
function aproj(azureExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-wi-a-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org: 'exampleorg', project: 'Sample Project', ...azureExtra } }));
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

  await test('comment (ADO) plans and executes through the comments API — the body HTML-encoded, markup literal', async () => {
    const body = 'Totals <b>wrong</b> & "rounded" — it\'s off\nسطر ثانٍ';
    const encoded = 'Totals &lt;b&gt;wrong&lt;/b&gt; &amp; &quot;rounded&quot; — it&#39;s off<br>سطر ثانٍ';
    const f1 = fakeFetch([]);
    const r1 = await run(['comment', '--id', '42', '--body', body], { cwd: aproj(), fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.mode, 'plan');
    assert.deepStrictEqual(r1.out.plan[0].request.body, { text: encoded }, 'the dry run shows the exact body');
    assert.strictEqual(f1.calls.length, 0);
    const f2 = fakeFetch([{ method: 'POST', match: '/wit/workItems/42/comments', json: { id: 9 } }]);
    const r2 = await run(['comment', '--id', '42', '--body', body, '--execute'], { cwd: aproj(), fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.strictEqual(f2.calls.length, 1);
    assert.strictEqual(JSON.parse(f2.calls[0].body).text, encoded, 'request body: markup characters literal, Arabic literal');
    assert.ok(f2.calls[0].body.includes('سطر ثانٍ'), 'non-ASCII travels unescaped');
  });

  await test('renderDiscussion: ADO HTML (encoded, <br>, mention anchor) / Jira ADF (toAdf, mention node) — byte-exact', async () => {
    const { defaultRegistry } = require('./lib/tracker/ops/index.js');
    const { toAdf } = require('./lib/tracker/adf.js');
    const adoR = defaultRegistry.get('ado').renderDiscussion;
    const jiraR = defaultRegistry.get('jira').renderDiscussion;
    assert.strictEqual(adoR('a < b & c > "d" \'e\'\nnext', null), 'a &lt; b &amp; c &gt; &quot;d&quot; &#39;e&#39;<br>next');
    assert.strictEqual(adoR('please check', { id: 'guid-1', displayName: 'Pat <PO>' }),
      '<a href="#" data-vss-mention="version:2.0,guid-1">@Pat &lt;PO&gt;</a> please check');
    assert.deepStrictEqual(jiraR('two\n\nparas', null), toAdf('two\n\nparas'), 'no mention: exactly today\'s toAdf body');
    assert.deepStrictEqual(jiraR('please check\nnow', { id: 'acc-9', displayName: 'Pat Owner' }), {
      type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'mention', attrs: { id: 'acc-9', text: '@Pat Owner' } }, { type: 'text', text: ' ' },
        { type: 'text', text: 'please check' }, { type: 'hardBreak' }, { type: 'text', text: 'now' },
      ] }],
    });
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
    const r = spawnSync(process.execPath, [path.join(__dirname, 'tracker.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
  });

  // ── structural pins ────────────────────────────────────────────────────────
  await test('no child_process and no process.exit in the delivered script (structural source read)', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'tracker.js'), 'utf8');
    assert.ok(!/child_process|spawnSync|execSync/.test(src), 'tracker.js must not spawn processes');
    assert.ok(!src.includes('process.exit('), 'tracker.js must not force-exit (exit-drain doctrine)');
  });

  // ── strategy spine (WP-4): no provider branches, fail-closed registry ───────
  await test('structural: tracker.js has no adapter.name comparison, no provider literal, no provider field token', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'tracker.js'), 'utf8');
    assert.ok(!/adapter\.name\s*[!=]==?|[!=]==?\s*adapter\.name/.test(src), 'adapter.name must not be compared');
    assert.ok(!/['"`](ado|jira|azure)['"`]/.test(src), 'no provider-name string literal in the spine');
    for (const tok of ['System.', 'issuetype', 'issues', 'workItems']) {
      assert.ok(!src.includes(tok), `provider field token "${tok}" in tracker.js — provider mapping belongs in scripts/lib/tracker/ops/<provider>.js`);
    }
  });

  await test('a provider with an adapter but no strategy is refused (exit 2) on a read AND a write — zero requests', async () => {
    const calls = [];
    const acme = {
      name: 'acme', capabilities: { query: 'aql', comments: true, transitions: true },
      webUrl: (id) => `https://acme.example.com/item/${id}`,
    };
    for (const m of ['getWorkItem', 'query', 'createWorkItem', 'updateWorkItem', 'addComment', 'addRelation', 'transition']) {
      acme[m] = async (...a) => { calls.push([m, ...a]); return {}; };
    }
    const f = fakeFetch([]);
    const dir = aproj();
    const spec = writeSpec(dir, { fields: { title: 't' } });
    for (const argv of [['show', '--id', '1'], ['search', '--query', 'x'], ['update', '--id', '1', '--spec', spec, '--execute'], ['comment', '--id', '1', '--body', 'x']]) {
      const { code, out } = await run(argv, { cwd: dir, fetch: f, resolveTracker: () => acme });
      assert.strictEqual(code, 2, `${argv[0]}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.ok, false);
      assert.match(out.error.message, /No tracker-ops strategy is registered for tracker provider 'acme' — providers with one: ado, jira\. Refusing rather than falling back/);
    }
    assert.strictEqual(calls.length, 0, 'no adapter method was called');
    assert.strictEqual(f.calls.length, 0, 'no request left the machine');
  });

  // ── the move (WP-2): one CLI, no trace of the old path ──────────────────────
  await test('no reference to the old skill-local CLI path anywhere in the plugin outside CHANGELOG.md', async () => {
    const root = path.join(__dirname, '..');
    // Tracked files when git is available (test-side spawn only); else a walk
    // that skips the untracked/private trees.
    let files;
    const ls = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
    if (ls.status === 0 && ls.stdout.trim()) files = ls.stdout.trim().split(/\r?\n/);
    else {
      const SKIP = new Set(['.git', 'node_modules', '.claude', '.planning', 'graphify-out', 'non-consolidated-skills']);
      files = [];
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
          if (SKIP.has(e.name)) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(r); else files.push(r);
        }
      };
      walk('');
    }
    // The old name, composed so this file never contains it literally.
    // read-<old name> (bug-report-azure's own read entry) is a different script.
    const OLD = new RegExp('(^|[^\\w-])' + 'work' + 'item\\.js');
    const hits = [];
    for (const rel of files) {
      if (rel === 'CHANGELOG.md' || !/\.(js|md|json|ya?ml|html)$/.test(rel)) continue;
      let text; try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      text.split(/\r?\n/).forEach((line, i) => { if (OLD.test(line)) hits.push(`${rel}:${i + 1}`); });
    }
    assert.deepStrictEqual(hits, [], `old path still referenced at: ${hits.join(', ')}`);
  });

  // ════ WP-7: CLI reads — show/batch/search --fields --out, comments, relations, iterations ════
  // A richer fake: respond(call, n) per route (n = this route's nth hit).
  function fake2(routes = []) {
    const calls = []; const hits = new Map();
    const fn = async (url, opts = {}) => {
      const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
      calls.push(call);
      for (const r of routes) {
        if ((r.method || 'GET') !== call.method || !call.url.includes(r.match)) continue;
        if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
        const n = (hits.get(r) || 0) + 1; hits.set(r, n);
        const resp = r.respond ? r.respond(call, n) : r;
        const status = resp.status || 200;
        const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.json ?? {});
        return { ok: status >= 200 && status < 300, status, text: async () => text };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };
    fn.calls = calls;
    return fn;
  }
  const { resolveTracker: realResolve } = require('./lib/tracker/index.js');
  // Wrap named adapter methods with call counters (spies), via the resolveTracker seam.
  function spying(names) {
    const counts = Object.fromEntries(names.map((n) => [n, 0]));
    const resolveTracker = (cwd, opts) => {
      const a = realResolve(cwd, opts);
      for (const n of names) {
        const orig = a[n];
        a[n] = function spy(...args) { counts[n]++; return orig.apply(this, args); };
      }
      return a;
    };
    return { counts, resolveTracker };
  }
  const NON_ASCII = 'تأكد من أن الإجمالي يشمل الضريبة — Ça coûte 5 € à Zoë, naïve façade';
  const tmpOut = (dir, rel) => path.join(dir, 'out', 'nested', rel);

  await test('show --fields --out (ADO): UTF-8 file round-trips non-ASCII byte-identical; stdout carries the path, never the body', async () => {
    const dir = aproj();
    const f = fake2([{ match: '/wit/workitems/42?', json: { id: 42, fields: { 'System.Title': 'Totals', 'System.Description': NON_ASCII } } }]);
    const file = tmpOut(dir, 'story-42.json');
    const { code, out } = await run(['show', '--id', '42', '--fields', 'System.Title,System.Description', '--out', file], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(f.calls.length, 1);
    assert.match(f.calls[0].url, /fields=System\.Title%2CSystem\.Description/);
    assert.deepStrictEqual(Object.keys(out), ['ok', 'provider', 'out', 'bytes']);
    assert.strictEqual(out.out, path.resolve(file));
    const buf = fs.readFileSync(file);
    assert.strictEqual(out.bytes, buf.length);
    assert.ok(buf.includes(Buffer.from(NON_ASCII, 'utf8')), 'the exact UTF-8 bytes the server sent');
    assert.ok(!JSON.stringify(out).includes('Totals') && !JSON.stringify(out).includes(NON_ASCII.slice(0, 5)), 'no body in stdout');
    const payload = JSON.parse(buf.toString('utf8'));
    assert.strictEqual(payload.workItem.fields['System.Description'], NON_ASCII);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'written via <file>.tmp + rename');
  });

  await test('show --fields --out (Jira): same round-trip; fields= beside expand', async () => {
    const dir = jproj();
    const f = fake2([{ match: '/rest/api/3/issue/PROJ-1?', json: { key: 'PROJ-1', fields: { summary: NON_ASCII }, renderedFields: { summary: NON_ASCII } } }]);
    const file = path.join(dir, 'proj-1.json');
    const { code, out } = await run(['show', '--id', 'PROJ-1', '--fields', 'summary', '--out', 'proj-1.json'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.match(f.calls[0].url, /expand=renderedFields%2Cnames&fields=summary/);
    assert.strictEqual(out.out, file, 'a relative --out resolves against the project');
    assert.ok(fs.readFileSync(file).includes(Buffer.from(NON_ASCII, 'utf8')));
    assert.ok(!JSON.stringify(out).includes(NON_ASCII.slice(0, 5)));
  });

  await test('show --fields with --expand on ADO: exit 2 before any request', async () => {
    const f = fake2([]);
    const { code } = await run(['show', '--id', '42', '--fields', 'System.Title', '--expand', 'all'], { cwd: aproj(), fetch: f });
    assert.strictEqual(code, 2);
    assert.strictEqual(f.calls.length, 0);
  });

  const batchEcho = (drop = []) => ({ method: 'POST', match: '/wit/workitemsbatch', respond: (call) => {
    const b = JSON.parse(call.body);
    return { json: { value: b.ids.filter((i) => !drop.includes(i)).reverse().map((id) => ({ id, fields: Object.fromEntries((b.fields || []).map((k) => [k, `${k}#${id}`])) })) } };
  } });
  await test('batch (ADO): only the requested fields, input order, missing listed; --ids-file; --out', async () => {
    const dir = aproj();
    const f = fake2([batchEcho([12])]);
    const r = await run(['batch', '--ids', '13,11,12', '--fields', 'System.Title,System.State'], { cwd: dir, fetch: f });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.items, [
      { id: 13, fields: { 'System.Title': 'System.Title#13', 'System.State': 'System.State#13' } },
      { id: 11, fields: { 'System.Title': 'System.Title#11', 'System.State': 'System.State#11' } },
    ]);
    assert.deepStrictEqual(r.out.missing, [12]);
    assert.strictEqual(r.out.count, 2);
    const idsFile = path.join(dir, 'ids.txt');
    fs.writeFileSync(idsFile, '21\n22, 23\n\n');
    const f2 = fake2([batchEcho()]);
    const r2 = await run(['batch', '--ids-file', idsFile, '--fields', 'System.Title', '--out', 'batch.json'], { cwd: dir, fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(JSON.parse(f2.calls[0].body).ids, [21, 22, 23]);
    assert.deepStrictEqual(Object.keys(r2.out), ['ok', 'provider', 'out', 'bytes', 'count', 'missing']);
    assert.strictEqual(r2.out.count, 3); assert.strictEqual(r2.out.missing, 0, 'stdout carries counts, never ids or bodies');
  });

  await test('batch: bad usage (no ids, no fields, both id sources) exits 2 with zero requests', async () => {
    const f = fake2([]);
    for (const argv of [['batch', '--fields', 'System.Title'], ['batch', '--ids', '1'], ['batch', '--ids', '1', '--ids-file', 'x', '--fields', 'a']]) {
      const { code, out } = await run(argv, { cwd: aproj(), fetch: f });
      assert.strictEqual(code, 2, JSON.stringify(out));
    }
    assert.strictEqual(f.calls.length, 0);
  });

  await test('batch (Jira): bulkfetch; a moved issue is reported in moved, its old key in missing', async () => {
    const f = fake2([{ method: 'POST', match: '/issue/bulkfetch', json: { issues: [
      { id: '10003', key: 'PROJ-3', fields: { summary: 'three' } },
      { id: '20009', key: 'NEW-9', fields: { summary: 'moved' } },
    ], issueErrors: [{ issueIdsOrKeys: ['PROJ-4'], status: 404 }] } }]);
    const { code, out } = await run(['batch', '--ids', 'PROJ-9,PROJ-3,PROJ-4', '--fields', 'summary'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.items, [{ id: 'PROJ-3', fields: { summary: 'three' } }]);
    assert.deepStrictEqual(out.missing, ['PROJ-9', 'PROJ-4']);
    assert.deepStrictEqual(out.moved, [{ id: 'NEW-9', fields: { summary: 'moved' } }]);
  });

  await test('search --fields (ADO): ids hydrated by one batch read; rows carry the requested fields', async () => {
    const f = fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 7 }, { id: 8 }] } }, batchEcho()]);
    const { code, out } = await run(['search', '--query', "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project", '--fields', 'System.Title'], { cwd: aproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.results.map((r) => [r.id, r.fields['System.Title']]), [[7, 'System.Title#7'], [8, 'System.Title#8']]);
    assert.ok(out.results.every((r) => typeof r.url === 'string'));
    assert.strictEqual(f.calls.length, 2);
  });

  await test('search --top (ADO): $top sent; truncated:true at the cap; out-of-range --top exits 2 with zero requests', async () => {
    const q = "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project";
    const f = fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] } }]);
    const r = await run(['search', '--query', q, '--top', '3'], { cwd: aproj(), fetch: f });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.match(f.calls[0].url, /\/wit\/wiql\?\$top=3&api-version=7\.1/);
    assert.strictEqual(r.out.truncated, true);
    const r2 = await run(['search', '--query', q, '--top', '4'], { cwd: aproj(), fetch: fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 1 }] } }]) });
    assert.ok(!('truncated' in r2.out), 'under the cap: no flag');
    const big = fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: Array.from({ length: 20000 }, (_, i) => ({ id: i + 1 })) } }]);
    const r3 = await run(['search', '--query', q], { cwd: aproj(), fetch: big });
    assert.ok(!/\$top/.test(big.calls[0].url), 'no $top unless --top is given');
    assert.strictEqual(r3.out.truncated, true, 'the service maximum (20,000) is a cap too');
    const none = fake2([]);
    for (const top of ['0', '20001', 'ten']) {
      const { code } = await run(['search', '--query', q, '--top', top], { cwd: aproj(), fetch: none });
      assert.strictEqual(code, 2, `--top ${top}`);
    }
    assert.strictEqual(none.calls.length, 0);
  });

  await test('search --top / --fields (Jira): limit passed, truncated at n; --top above 1000 exits 2', async () => {
    const f = fake2([{ method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 'a', labels: ['x'] } }, { key: 'PROJ-2', fields: { summary: 'b', labels: [] } }], nextPageToken: 'more' } }]);
    const { code, out } = await run(['search', '--query', 'project = "PROJ"', '--top', '2', '--fields', 'summary,labels'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    const body = JSON.parse(f.calls[0].body);
    assert.deepStrictEqual(body.fields, ['summary', 'labels']);
    assert.strictEqual(body.maxResults, 2);
    assert.strictEqual(out.truncated, true);
    assert.deepStrictEqual(out.results[0].fields, { summary: 'a', labels: ['x'] });
    const none = fake2([]);
    assert.strictEqual((await run(['search', '--query', 'x', '--top', '1001'], { cwd: jproj(), fetch: none })).code, 2);
    assert.strictEqual(none.calls.length, 0);
  });

  await test('ADO search scoping (scopeQuery): every WIQL shape', async () => {
    const { defaultRegistry } = require('./lib/tracker/ops/index.js');
    const scope = (q) => defaultRegistry.get('ado').scopeQuery(null, q);
    const S = '[System.TeamProject] = @project';
    for (const [q, want] of [
      ['SELECT [System.Id] FROM workitems', `SELECT [System.Id] FROM workitems WHERE ${S}`],
      ["SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'", `SELECT [System.Id] FROM workitems WHERE ${S} AND ([System.State] = 'Active')`],
      ["SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active' OR [System.State] = 'New' ORDER BY [System.Id] DESC",
        `SELECT [System.Id] FROM workitems WHERE ${S} AND ([System.State] = 'Active' OR [System.State] = 'New') ORDER BY [System.Id] DESC`],
      ['SELECT [System.Id] FROM workitems ORDER BY [System.ChangedDate]', `SELECT [System.Id] FROM workitems WHERE ${S} ORDER BY [System.ChangedDate]`],
      ["select [System.Id] from workitems where [System.Title] = 'where to order by' asof '2026-01-01'",
        `select [System.Id] from workitems where ${S} AND ([System.Title] = 'where to order by') asof '2026-01-01'`],
      ["SELECT [System.Id] FROM workitems WHERE [System.Title] CONTAINS 'it''s [System.TeamProject]'",
        `SELECT [System.Id] FROM workitems WHERE ${S} AND ([System.Title] CONTAINS 'it''s [System.TeamProject]')`],
      ['SELECT [System.Id] FROM workitems WHERE [System.Title] = "x where y"', `SELECT [System.Id] FROM workitems WHERE ${S} AND ([System.Title] = "x where y")`],
      ["SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.WorkItemType] = 'User Story' MODE (MustContain)",
        "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.TeamProject] = @project AND ([Source].[System.WorkItemType] = 'User Story') MODE (MustContain)"],
    ]) assert.strictEqual(scope(q), want, q);
    for (const q of [
      "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = 'Other Project'",
      'SELECT [System.Id] FROM workitems WHERE system.teamproject = @project',
      "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.TeamProject] = @project",
    ]) assert.strictEqual(scope(q), q, `names a project already: ${q}`);
  });

  await test('search (ADO): an unscoped WIQL is sent scoped to the configured project (named change #3)', async () => {
    const f = fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: [] } }]);
    await run(['search', '--query', "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'"], { cwd: aproj(), fetch: f });
    assert.strictEqual(JSON.parse(f.calls[0].body).query, "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND ([System.State] = 'Active')");
    assert.match(f.calls[0].url, /\/Sample%20Project\/_apis\/wit\/wiql\?/, '@project resolves on the project-scoped route');
  });

  const ADO_COMMENTS = { comments: [
    { id: 1, createdBy: { id: 'g-a', displayName: 'Ana', uniqueName: 'ana@example.com' }, createdDate: '2026-01-01T09:00:00Z', text: '<div>Is the total &lt;= 100?</div>' },
    { id: 2, createdBy: { id: 'g-b', displayName: 'Ben', uniqueName: 'ben@example.com' }, createdDate: '2026-01-02T09:00:00Z', text: `<div>${NON_ASCII}</div>` },
  ] };
  await test('comments (ADO + Jira): the same {author, date, text} shape, oldest first, plain text; --out', async () => {
    const a = await run(['comments', '--id', '42'], { cwd: aproj(), fetch: fake2([{ match: '/wit/workItems/42/comments', json: ADO_COMMENTS }]) });
    assert.strictEqual(a.code, 0, JSON.stringify(a.out));
    assert.deepStrictEqual(a.out.comments, [
      { author: 'Ana', date: '2026-01-01T09:00:00Z', text: 'Is the total <= 100?' },
      { author: 'Ben', date: '2026-01-02T09:00:00Z', text: NON_ASCII },
    ]);
    assert.strictEqual(a.out.count, 2);
    const { toAdf } = require('./lib/tracker/adf.js');
    const jc = { total: 1, comments: [{ id: '5', author: { accountId: 'acc', displayName: 'Ana' }, created: '2026-01-01T09:00:00.000+0000', body: toAdf('line one\nline two') }] };
    const dir = jproj();
    const j = await run(['comments', '--id', 'PROJ-1', '--out', 'c.json'], { cwd: dir, fetch: fake2([{ match: '/issue/PROJ-1/comment', json: jc }]) });
    assert.strictEqual(j.code, 0, JSON.stringify(j.out));
    assert.deepStrictEqual(Object.keys(j.out), ['ok', 'provider', 'out', 'bytes', 'count']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'c.json'), 'utf8')).comments, [{ author: 'Ana', date: '2026-01-01T09:00:00.000+0000', text: 'line one\nline two' }]);
  });

  const ADO_REL = (id, rel, target) => ({ rel, url: `https://dev.azure.com/exampleorg/_apis/wit/workItems/${target}` });
  const adoChildren = (n) => [
    { method: 'POST', match: '/wit/wiql', json: { workItems: Array.from({ length: n }, (_, i) => ({ id: 500 + i })) } },
    { method: 'POST', match: '/wit/workitemsbatch', respond: (call) => ({ json: { value: JSON.parse(call.body).ids.map((id) => ({ id, fields: { 'System.Parent': 42, 'System.Title': `[Testing] T${id}`, 'System.State': 'Active', 'System.WorkItemType': 'Task' } })) } }) },
  ];
  await test('relations --kind child: 1 child vs 50 children -> the SAME request count (ADO 2, Jira 1)', async () => {
    const counts = [];
    for (const n of [1, 50]) {
      const f = fake2(adoChildren(n));
      const { code, out } = await run(['relations', '--id', '42', '--kind', 'child'], { cwd: aproj(), fetch: f });
      assert.strictEqual(code, 0, JSON.stringify(out));
      assert.strictEqual(out.items[0].relations.length, n);
      assert.deepStrictEqual(out.items[0].relations[0], { kind: 'child', id: 500, type: 'Task', title: '[Testing] T500', state: 'Active' });
      counts.push(f.calls.length);
    }
    assert.deepStrictEqual(counts, [2, 2]);
    const jcounts = [];
    for (const n of [1, 50]) {
      const subtasks = Array.from({ length: n }, (_, i) => ({ key: `PROJ-${100 + i}`, fields: { summary: `[Testing] T${i}`, status: { name: 'To Do' }, issuetype: { name: 'Sub-task' } } }));
      const f = fake2([{ match: '/rest/api/3/issue/PROJ-1?', json: { key: 'PROJ-1', fields: { summary: 'S', subtasks, issuelinks: [] } } }]);
      const spy = spying(['getStory', 'listChildren']);
      const { code, out } = await run(['relations', '--id', 'PROJ-1', '--kind', 'child'], { cwd: jproj(), fetch: f, resolveTracker: spy.resolveTracker });
      assert.strictEqual(code, 0, JSON.stringify(out));
      assert.strictEqual(out.items[0].relations.length, n);
      assert.deepStrictEqual(out.items[0].relations[0], { kind: 'child', id: 'PROJ-100', type: 'Sub-task', title: '[Testing] T0', state: 'To Do' });
      assert.deepStrictEqual(spy.counts, { getStory: 1, listChildren: 1 }, 'Jira reuses the neutral reads');
      jcounts.push(f.calls.length);
    }
    assert.deepStrictEqual(jcounts, [1, 1]);
  });

  await test('relations (ADO non-child kinds): getStory (spy) + ONE hydrate; kind map; artifact links dropped', async () => {
    const story = { id: 42, fields: { 'System.Title': 'S' }, relations: [
      ADO_REL(42, 'System.LinkTypes.Hierarchy-Reverse', 7),
      ADO_REL(42, 'System.LinkTypes.Hierarchy-Forward', 501),
      ADO_REL(42, 'Microsoft.VSTS.Common.TestedBy-Forward', 900),
      ADO_REL(42, 'System.LinkTypes.Related', 61),
      ADO_REL(42, 'System.LinkTypes.Dependency-Forward', 62),
      { rel: 'ArtifactLink', url: 'vstfs:///Git/Commit/abc' },
      { rel: 'AttachedFile', url: 'https://dev.azure.com/exampleorg/_apis/wit/attachments/x' },
    ] };
    const f = fake2([
      { match: '/wit/workitems/42?', json: story },
      { method: 'POST', match: '/wit/workitemsbatch', respond: (call) => ({ json: { value: JSON.parse(call.body).ids.map((id) => ({ id, fields: { 'System.Title': `T${id}`, 'System.State': 'New', 'System.WorkItemType': id === 900 ? 'Test Case' : 'Bug' } })) } }) },
    ]);
    const spy = spying(['getStory']);
    const { code, out } = await run(['relations', '--id', '42', '--kind', 'parent,tested-by,related'], { cwd: aproj(), fetch: f, resolveTracker: spy.resolveTracker });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(spy.counts.getStory, 1);
    assert.strictEqual(f.calls.length, 2);
    assert.deepStrictEqual(out.items[0].relations, [
      { kind: 'parent', id: 7, type: 'Bug', title: 'T7', state: 'New' },
      { kind: 'tested-by', id: 900, type: 'Test Case', title: 'T900', state: 'New' },
      { kind: 'related', id: 61, type: 'Bug', title: 'T61', state: 'New' },
    ]);
    const all = await run(['relations', '--id', '42', '--kind', 'all'], { cwd: aproj(), fetch: fake2([
      { match: '/wit/workitems/42?', json: story }, ...adoChildren(1).slice(0, 1),
      { method: 'POST', match: '/wit/workitemsbatch', respond: (call) => ({ json: { value: JSON.parse(call.body).ids.map((id) => ({ id, fields: { 'System.Parent': 42, 'System.Title': `T${id}` } })) } }) },
    ]) });
    assert.strictEqual(all.code, 0, JSON.stringify(all.out));
    assert.deepStrictEqual(all.out.items[0].relations.map((r) => [r.kind, r.id, r.linkType]),
      [['parent', 7, undefined], ['child', 500, undefined], ['tested-by', 900, undefined], ['related', 61, undefined], ['link', 62, 'System.LinkTypes.Dependency-Forward']]);
  });

  await test('relations (Jira): parent + issue links inline (no hydrate); --kind tested-by refused naming the flag, zero requests', async () => {
    const issue = { key: 'PROJ-1', fields: {
      summary: 'S', subtasks: [],
      parent: { key: 'PROJ-EPIC', fields: { summary: 'Epic', status: { name: 'Open' }, issuetype: { name: 'Epic' } } },
      issuelinks: [
        { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'PROJ-8', fields: { summary: 'R', status: { name: 'Done' }, issuetype: { name: 'Bug' } } } },
        { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-9', fields: { summary: 'B', status: { name: 'To Do' }, issuetype: { name: 'Task' } } } },
      ],
    } };
    const f = fake2([{ match: '/rest/api/3/issue/PROJ-1?', json: issue }]);
    const { code, out } = await run(['relations', '--id', 'PROJ-1'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(out.items[0].relations, [
      { kind: 'parent', id: 'PROJ-EPIC', type: 'Epic', title: 'Epic', state: 'Open' },
      { kind: 'related', id: 'PROJ-8', type: 'Bug', title: 'R', state: 'Done' },
      { kind: 'link', linkType: 'Blocks', direction: 'is blocked by', id: 'PROJ-9', type: 'Task', title: 'B', state: 'To Do' },
    ]);
    assert.deepStrictEqual(out.skipped, [{ kind: 'tested-by', flag: 'relations.testedBy' }], '"all" never silently drops a kind');
    const none = fake2([]);
    const r = await run(['relations', '--id', 'PROJ-1', '--kind', 'tested-by'], { cwd: jproj(), fetch: none });
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.blocked.map((b) => [b.reason, b.flag]), [['unsupported-op', 'relations.testedBy']]);
    assert.match(r.out.blocked[0].message, /capabilities\.relations\.testedBy/);
    assert.strictEqual(none.calls.length, 0);
    const bad = await run(['relations', '--id', 'PROJ-1', '--kind', 'cousin'], { cwd: jproj(), fetch: none });
    assert.strictEqual(bad.code, 2);
  });

  const ITERS = { value: [
    { id: 'g1', name: 'Sprint 8', path: 'Sample Project\\Sprint 8', attributes: { startDate: '2026-01-01T00:00:00Z', finishDate: '2026-01-14T00:00:00Z', timeFrame: 'past' } },
    { id: 'g2', name: 'Sprint 9', path: 'Sample Project\\Sprint 9', attributes: { startDate: '2026-01-15T00:00:00Z', finishDate: '2026-01-28T00:00:00Z', timeFrame: 'current' } },
  ] };
  await test('iterations (ADO): team from --team or azure.team; ONE request; no team -> exit 2 naming azure.team, zero requests', async () => {
    const f = fake2([{ match: '/teamsettings/iterations', json: ITERS }]);
    const r = await run(['iterations', '--timeframe', 'current'], { cwd: aproj({ team: 'Sample Team' }), fetch: f });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(f.calls.length, 1);
    assert.match(f.calls[0].url, /\/Sample%20Project\/Sample%20Team\/_apis\/work\/teamsettings\/iterations/);
    assert.deepStrictEqual(r.out.iterations, [{ id: 'g2', name: 'Sprint 9', path: 'Sample Project\\Sprint 9', startDate: '2026-01-15T00:00:00Z', finishDate: '2026-01-28T00:00:00Z', timeFrame: 'current' }]);
    const g = fake2([{ match: '/teamsettings/iterations', json: ITERS }]);
    const r2 = await run(['iterations', '--team', 'Other Team'], { cwd: aproj(), fetch: g });
    assert.match(g.calls[0].url, /\/Other%20Team\//);
    assert.strictEqual(r2.out.iterations.length, 2);
    const none = fake2([]);
    const r3 = await run(['iterations'], { cwd: aproj(), fetch: none });
    assert.strictEqual(r3.code, 2); assert.match(r3.out.error.message, /azure\.team/);
    const r4 = await run(['iterations', '--board', '3'], { cwd: aproj({ team: 'T' }), fetch: none });
    assert.strictEqual(r4.code, 2, '--board is not an ADO option (never silently ignored)');
    assert.strictEqual(none.calls.length, 0);
  });

  await test('iterations (Jira): board by id or name (listBoards + listSprints spies); state mapping; no board -> exit 2 naming jira.board', async () => {
    const sprints = { isLast: true, values: [
      { id: 7, name: 'Sprint 7', state: 'closed', startDate: '2026-01-01', endDate: '2026-01-14' },
      { id: 8, name: 'Sprint 8', state: 'active', startDate: '2026-01-15', endDate: '2026-01-28' },
      { id: 9, name: 'Sprint 9', state: 'future' },
    ] };
    const f = fake2([{ match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values: [{ id: 3, name: 'PROJ board' }] } }, { match: '/rest/agile/1.0/board/3/sprint', json: sprints }]);
    const spy = spying(['listBoards', 'listSprints']);
    const r = await run(['iterations', '--board', 'PROJ board'], { cwd: jproj(), fetch: f, resolveTracker: spy.resolveTracker });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(spy.counts, { listBoards: 1, listSprints: 1 });
    assert.deepStrictEqual(r.out.iterations, [
      { id: 7, name: 'Sprint 7', startDate: '2026-01-01', finishDate: '2026-01-14', timeFrame: 'past' },
      { id: 8, name: 'Sprint 8', startDate: '2026-01-15', finishDate: '2026-01-28', timeFrame: 'current' },
      { id: 9, name: 'Sprint 9', startDate: null, finishDate: null, timeFrame: 'future' },
    ]);
    const g = fake2([{ match: '/board/3/sprint', json: { values: [sprints.values[1]] } }]);
    const r2 = await run(['iterations', '--timeframe', 'current'], { cwd: jproj({ board: '3' }), fetch: g });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(g.calls.map((c) => c.url), ['https://example.atlassian.net/rest/agile/1.0/board/3/sprint?state=active'], 'a numeric board needs no board lookup');
    const none = fake2([]);
    const r3 = await run(['iterations'], { cwd: jproj(), fetch: none });
    assert.strictEqual(r3.code, 2); assert.match(r3.out.error.message, /jira\.board/);
    assert.strictEqual((await run(['iterations', '--team', 'T', '--board', '3'], { cwd: jproj(), fetch: none })).code, 2);
    assert.strictEqual(none.calls.length, 0);
    const miss = fake2([{ match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values: [{ id: 3, name: 'PROJ board' }] } }]);
    const r5 = await run(['iterations', '--board', 'Nope'], { cwd: jproj(), fetch: miss });
    assert.strictEqual(r5.code, 2); assert.match(r5.out.error.message, /PROJ board/, 'lists the real boards');
  });

  await test('every new read prints exactly one JSON line and exits 0/1/2 (spawned CLI, zero network)', async () => {
    for (const argv of [['batch'], ['comments'], ['relations'], ['iterations', '--timeframe', 'someday']]) {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'tracker.js'), ...argv], { cwd: aproj(), encoding: 'utf8', env: { ...process.env } });
      assert.strictEqual(r.status, 2, `${argv[0]}: ${r.stdout}${r.stderr}`);
      const lines = r.stdout.trim().split(/\r?\n/);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(JSON.parse(lines[0]).ok, false);
    }
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
