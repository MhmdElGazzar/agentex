'use strict';
// Unit tests for the Jira Cloud REST v3 adapter. Run: node scripts/lib/tracker/adapters/jira.test.js
// Fully offline: fetch is INJECTED (never monkey-patched) — a scripted fake with
// call recording. No network, no Jira site, no CLI anywhere.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapter, TrackerError, jqlQuote, CRED_ENV_NAMES } = require('./jira.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_TOKEN = 'SENTINEL-JIRA-TOKEN-a1b2c3d4e5f60718293a4b5c';
const SENTINEL_EMAIL = 'sentinel.qa@example.com';
const SENTINEL_B64 = Buffer.from(`${SENTINEL_EMAIL}:${SENTINEL_TOKEN}`).toString('base64');

// The tests own the credential environment — real values must not leak in.
for (const n of ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'AGENTEX_CI']) delete process.env[n];

// Throwaway consumer project with a jira block + sentinel credentials in .env.
function proj({ site = 'example', project = 'PROJ', envLines, jiraExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-jira-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ jira: { site, project, ...jiraExtra } }));
  fs.writeFileSync(path.join(dir, '.env'),
    envLines !== undefined ? envLines : `JIRA_EMAIL=${SENTINEL_EMAIL}\nJIRA_API_TOKEN=${SENTINEL_TOKEN}\n`);
  return dir;
}

// Scripted fake fetch: matches [method + url substring (+ body substring)], records every call.
function fakeFetch(routes = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    for (const r of routes) {
      if ((r.method || 'GET') !== (opts.method || 'GET')) continue;
      if (!String(url).includes(r.match)) continue;
      if (r.bodyMatch && !(typeof opts.body === 'string' && opts.body.includes(r.bodyMatch))) continue;
      const status = r.status || 200;
      const json = typeof r.json === 'function' ? r.json(calls[calls.length - 1]) : r.json;
      const text = r.text !== undefined ? r.text : JSON.stringify(json !== undefined ? json : {});
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

const BASE = 'https://example.atlassian.net';

// createmeta fixtures: issue types + per-type field screens.
const ISSUE_TYPES = {
  issueTypes: [
    { id: '10001', name: 'Story', subtask: false },
    { id: '10002', name: 'Sub-task', subtask: true },
    { id: '10003', name: 'Bug', subtask: false },
  ],
};
const SUBTASK_FIELDS = {
  startAt: 0, maxResults: 50, total: 3,
  fields: [
    { fieldId: 'summary', name: 'Summary', required: true },
    { fieldId: 'timetracking', name: 'Time tracking', required: false },
    { fieldId: 'priority', name: 'Priority', required: false, allowedValues: [{ name: 'High' }, { name: 'Low' }] },
  ],
};

(async () => {
  // ── config resolution & site normalization ─────────────────────────────────
  await test('a bare site name is normalized to https://<name>.atlassian.net', async () => {
    const f = fakeFetch([]);
    await createAdapter({ cwd: proj(), fetch: f }).getWorkItem('PROJ-1');
    assert.ok(f.calls[0].url.startsWith(`${BASE}/rest/api/3/issue/PROJ-1?`), f.calls[0].url);
  });

  await test('a full site URL is used as-is (trailing slash stripped)', async () => {
    const f = fakeFetch([]);
    await createAdapter({ cwd: proj({ site: 'https://jira.example.com/' }), fetch: f }).getWorkItem('PROJ-1');
    assert.ok(f.calls[0].url.startsWith('https://jira.example.com/rest/api/3/issue/PROJ-1?'), f.calls[0].url);
  });

  await test('missing jira.site / jira.project: exit-2 error naming the keys (invariant 10), no .env fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-jira-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({ jira: { site: 'x' } }));
    // Decoy .env lines must NOT back non-secrets (secrets-only convention).
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_PROJECT=DECOY\n');
    assert.throws(() => createAdapter({ cwd: dir, fetch: fakeFetch([]) }), (e) => {
      assert.strictEqual(e.exitCode, 2);
      assert.match(e.message, /jira\.project/);
      assert.match(e.message, /config\/project\.json/);
      assert.ok(!e.message.includes('DECOY'));
      return true;
    });
  });

  // ── credentials: Authorization header ONLY ─────────────────────────────────
  await test('auth header is Basic base64(email:token) — resolved lazily from .env', async () => {
    const f = fakeFetch([]);
    await createAdapter({ cwd: proj(), fetch: f }).getWorkItem('PROJ-1');
    assert.strictEqual(f.calls[0].headers.Authorization, `Basic ${SENTINEL_B64}`);
  });

  await test('missing credentials: exit-2 error naming BOTH env names and .env/the wizard', async () => {
    for (const envLines of ['', `JIRA_EMAIL=${SENTINEL_EMAIL}\n`, `JIRA_API_TOKEN=${SENTINEL_TOKEN}\n`]) {
      const a = createAdapter({ cwd: proj({ envLines }), fetch: fakeFetch([]) });
      await assert.rejects(() => a.getWorkItem('PROJ-1'), (e) => {
        assert.strictEqual(e.exitCode, 2);
        for (const n of ['JIRA_EMAIL', 'JIRA_API_TOKEN']) assert.ok(e.message.includes(n), n);
        assert.match(e.message, /\.env/);
        assert.match(e.message, /wizard|init-test/i);
        assert.ok(!e.message.includes(SENTINEL_TOKEN));
        return true;
      });
    }
    assert.deepStrictEqual(CRED_ENV_NAMES, ['JIRA_EMAIL', 'JIRA_API_TOKEN']);
  });

  await test('401 carries credentialHint with env-var NAMES only — never a value or the email', async () => {
    const f = fakeFetch([{ match: '/rest/api/3/issue/PROJ-1', status: 401, text: '' }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(() => a.getWorkItem('PROJ-1'), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.deepStrictEqual(e.credentialHint.tried, ['JIRA_API_TOKEN']);
      assert.strictEqual(e.credentialHint.resolved, 'JIRA_API_TOKEN');
      assert.strictEqual(e.credentialHint.emailVar, 'JIRA_EMAIL');
      const s = JSON.stringify(e.credentialHint);
      assert.ok(!s.includes(SENTINEL_TOKEN) && !s.includes(SENTINEL_EMAIL), 'names only, never values');
      return true;
    });
  });

  // ── reads ───────────────────────────────────────────────────────────────────
  await test('getWorkItem always requests expand=renderedFields,names (the read-path ADF answer)', async () => {
    const f = fakeFetch([{ match: '/rest/api/3/issue/PROJ-7', json: { key: 'PROJ-7', fields: {}, renderedFields: {} } }]);
    const wi = await createAdapter({ cwd: proj(), fetch: f }).getWorkItem('PROJ-7');
    assert.match(f.calls[0].url, /expand=renderedFields%2Cnames|expand=renderedFields,names/);
    assert.strictEqual(wi.key, 'PROJ-7');
  });

  await test('query POSTs /rest/api/3/search/jql with an explicit fields array — the removed legacy /search is never called', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 't' } }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const res = await a.query('project = "PROJ"', { fields: ['summary', 'status'] });
    assert.deepStrictEqual(res.issues.map((i) => i.key), ['PROJ-1']);
    const call = f.calls[0];
    assert.strictEqual(call.method, 'POST');
    const body = JSON.parse(call.body);
    assert.strictEqual(body.jql, 'project = "PROJ"');
    assert.deepStrictEqual(body.fields, ['summary', 'status']);
    assert.ok(body.maxResults >= 1);
    for (const c of f.calls) {
      assert.ok(!/\/rest\/api\/3\/search(\?|$)/.test(c.url), `legacy /search called: ${c.url}`);
    }
  });

  await test('query paginates via nextPageToken to the 10-page hard cap; consumers never see tokens', async () => {
    let calls = 0;
    const f = fakeFetch([{
      method: 'POST', match: '/search/jql',
      json: () => { calls++; return { issues: [{ key: `PROJ-${calls}` }], nextPageToken: `tok-${calls}` }; },
    }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const res = await a.query('project = "PROJ"');
    assert.strictEqual(calls, 10, 'hard cap of 10 pages');
    assert.strictEqual(res.issues.length, 10);
    assert.strictEqual(res.truncated, true, 'the cap is visible, never silent');
    assert.ok(!('nextPageToken' in res));
    // token travels in the request body from page 2 on
    assert.ok(JSON.parse(f.calls[1].body).nextPageToken === 'tok-1');
    // a short result (no token) stops immediately
    const f2 = fakeFetch([{ method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-9' }] } }]);
    const res2 = await createAdapter({ cwd: proj(), fetch: f2 }).query('x');
    assert.strictEqual(f2.calls.length, 1);
    assert.ok(!res2.truncated);
  });

  await test('jqlQuote escapes backslash then quote and always double-quotes (adapter-owned escaping)', async () => {
    assert.strictEqual(jqlQuote('plain'), '"plain"');
    assert.strictEqual(jqlQuote('with "quotes"'), '"with \\"quotes\\""');
    assert.strictEqual(jqlQuote('back\\slash'), '"back\\\\slash"');
    assert.strictEqual(jqlQuote('both \\" mixed'), '"both \\\\\\" mixed"');
    assert.strictEqual(jqlQuote('order by'), '"order by"', 'reserved words are inert inside quotes');
  });

  await test('findByTitle composes escaped JQL and filters EXACT summary equality client-side (a ~-matched near-title is NOT returned)', async () => {
    const f = fakeFetch([{
      method: 'POST', match: '/search/jql',
      json: {
        issues: [
          { key: 'PROJ-11', fields: { summary: 'Login "fails" on submit' } },
          { key: 'PROJ-12', fields: { summary: 'Login "fails" on submit sometimes' } },
        ],
      },
    }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const keys = await a.findByTitle('Bug', 'Login "fails" on submit');
    assert.deepStrictEqual(keys, ['PROJ-11'], 'exact-equality filter applied');
    const body = JSON.parse(f.calls[0].body);
    assert.ok(body.jql.includes('project = "PROJ"'), body.jql);
    assert.ok(body.jql.includes('issuetype = "Bug"'), body.jql);
    assert.ok(body.jql.includes('summary ~ "Login \\"fails\\" on submit"'), body.jql);
    assert.deepStrictEqual(body.fields, ['summary']);
  });

  // ── createmeta: listFields / listIssueTypes ─────────────────────────────────
  await test('listFields resolves type name→id via per-issuetype createmeta (deprecated monolithic route never called) and normalizes to the cache descriptor shape', async () => {
    const f = fakeFetch([
      { match: '/rest/api/3/issue/createmeta/PROJ/issuetypes/10002', json: SUBTASK_FIELDS },
      { match: '/rest/api/3/issue/createmeta/PROJ/issuetypes', json: ISSUE_TYPES },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const fields = await a.listFields('Sub-task');
    assert.deepStrictEqual(fields, [
      { referenceName: 'summary', name: 'Summary', alwaysRequired: true },
      { referenceName: 'timetracking', name: 'Time tracking', alwaysRequired: false },
      { referenceName: 'priority', name: 'Priority', alwaysRequired: false, allowedValues: ['High', 'Low'] },
    ]);
    assert.ok(f.calls.some((c) => c.url.includes('/issue/createmeta/PROJ/issuetypes?')), 'name→id resolution route');
    assert.ok(f.calls.some((c) => c.url.includes('/issue/createmeta/PROJ/issuetypes/10002')), 'per-type fields route');
    for (const c of f.calls) {
      assert.ok(!/\/rest\/api\/3\/issue\/createmeta(\?|$)/.test(c.url), `deprecated monolithic createmeta called: ${c.url}`);
    }
    // The cache builder consumes the shape unchanged (O4).
    const cache = require('../cache.js');
    const map = cache.toFieldMap(fields);
    assert.deepStrictEqual(map.priority, { allowedValues: ['High', 'Low'], required: false });
    assert.deepStrictEqual(map.summary, { required: true });
  });

  await test('listFields memoizes the issue-type list per adapter instance; unknown type fails closed listing the real types', async () => {
    const f = fakeFetch([
      { match: '/issuetypes/10002', json: SUBTASK_FIELDS },
      { match: '/issuetypes/10003', json: { fields: [{ fieldId: 'summary', name: 'Summary', required: true }] } },
      { match: '/issuetypes', json: ISSUE_TYPES },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.listFields('Sub-task');
    await a.listFields('Bug');
    const typeListCalls = f.calls.filter((c) => /\/issuetypes\?/.test(c.url));
    assert.strictEqual(typeListCalls.length, 1, 'issue-type list fetched once');
    await assert.rejects(() => a.listFields('Test Case'), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.match(e.serverMessage, /Story/);
      assert.match(e.serverMessage, /Sub-task/);
      assert.match(e.serverMessage, /Bug/);
      return true;
    });
  });

  await test('listIssueTypes surfaces names + ids + subtask flags (feeds the Q11 artifact options)', async () => {
    const f = fakeFetch([{ match: '/issuetypes', json: ISSUE_TYPES }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    assert.deepStrictEqual(await a.listIssueTypes(), [
      { id: '10001', name: 'Story', subtask: false },
      { id: '10002', name: 'Sub-task', subtask: true },
      { id: '10003', name: 'Bug', subtask: false },
    ]);
  });

  // ── other new reads ────────────────────────────────────────────────────────
  await test('listAllFields / findUser / listLinkTypes / listBoards / listSprints hit their pinned routes', async () => {
    const f = fakeFetch([
      { match: '/rest/api/3/field', json: [{ id: 'customfield_10016', name: 'Story Points' }] },
      { match: '/rest/api/3/user/search?query=', json: [{ accountId: 'acc-1', emailAddress: 'qa@example.com' }] },
      { match: '/rest/api/3/issueLinkType', json: { issueLinkTypes: [{ id: '1', name: 'Relates' }] } },
      { match: '/rest/agile/1.0/board/42/sprint', json: { values: [{ id: 7, name: 'Sprint 7', state: 'active' }] } },
      { match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values: [{ id: 42, name: 'PROJ board' }] } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    assert.deepStrictEqual(await a.listAllFields(), [{ id: 'customfield_10016', name: 'Story Points' }]);
    assert.deepStrictEqual(await a.findUser('qa@example.com'), [{ accountId: 'acc-1', emailAddress: 'qa@example.com' }]);
    assert.deepStrictEqual(await a.listLinkTypes(), [{ id: '1', name: 'Relates' }]);
    assert.deepStrictEqual(await a.listBoards(), [{ id: 42, name: 'PROJ board' }]);
    assert.deepStrictEqual(await a.listSprints(42, { state: 'active' }), [{ id: 7, name: 'Sprint 7', state: 'active' }]);
    assert.ok(f.calls.some((c) => c.url.includes(`${BASE}/rest/agile/1.0/board?projectKeyOrId=PROJ`)));
    assert.ok(f.calls.some((c) => c.url.includes(`${BASE}/rest/agile/1.0/board/42/sprint?state=active`)));
    assert.ok(f.calls.some((c) => c.url.includes('query=qa%40example.com')));
  });

  await test('listEditFields normalizes editmeta (per-issue update validation route; never cached)', async () => {
    const f = fakeFetch([{
      match: '/rest/api/3/issue/PROJ-4/editmeta',
      json: { fields: { priority: { fieldId: 'priority', name: 'Priority', required: false, allowedValues: [{ name: 'High' }] } } },
    }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    assert.deepStrictEqual(await a.listEditFields('PROJ-4'), [
      { referenceName: 'priority', name: 'Priority', alwaysRequired: false, allowedValues: ['High'] },
    ]);
  });

  // ── writes: the json dialect ────────────────────────────────────────────────
  await test('createWorkItem sends plain-JSON fields with project/issuetype added; parent relation folds into fields.parent (atomic)', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue', json: { id: '10101', key: 'PROJ-101' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.createWorkItem('Sub-task', {
      fields: { summary: '[Testing] Test Creation', labels: ['testing'] },
      relations: [{ rel: 'parent', targetId: 'PROJ-9' }],
    }, { execute: true });
    assert.deepStrictEqual(r, { id: 'PROJ-101', url: `${BASE}/browse/PROJ-101` });
    const call = f.calls[0];
    assert.ok(call.url.startsWith(`${BASE}/rest/api/3/issue?`) || call.url === `${BASE}/rest/api/3/issue`, call.url);
    assert.strictEqual(call.headers['Content-Type'], 'application/json');
    const body = JSON.parse(call.body);
    assert.deepStrictEqual(body.fields.project, { key: 'PROJ' });
    assert.deepStrictEqual(body.fields.issuetype, { name: 'Sub-task' });
    assert.deepStrictEqual(body.fields.parent, { key: 'PROJ-9' });
    assert.strictEqual(body.fields.summary, '[Testing] Test Creation');
    assert.deepStrictEqual(body.fields.labels, ['testing']);
  });

  await test('a non-parent relation at create is an explicit error naming addRelation — never silently dropped', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    await assert.rejects(
      () => a.createWorkItem('Bug', { fields: { summary: 't' }, relations: [{ rel: 'Relates', targetId: 'PROJ-1' }] }, { execute: true }),
      (e) => {
        assert.match(e.message, /addRelation/);
        assert.match(e.message, /Relates/);
        return true;
      });
  });

  await test('validateOnly:true throws an explicit error naming capabilities.validateOnly:false (never silently ignored)', async () => {
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(
      () => a.createWorkItem('Bug', { fields: { summary: 't' } }, { validateOnly: true, execute: true }),
      (e) => /validateOnly/.test(e.message) && /false/.test(e.message));
    assert.strictEqual(f.calls.length, 0, 'nothing was sent');
  });

  await test('a plain-string description/environment is wrapped via toAdf (dialect seam); prebuilt ADF passes through', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue', json: { key: 'PROJ-77' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.createWorkItem('Bug', {
      fields: { summary: 't', description: 'line one\nline two', environment: 'QA env' },
    }, { execute: true });
    const b1 = JSON.parse(f.calls[0].body);
    assert.strictEqual(b1.fields.description.type, 'doc');
    assert.strictEqual(b1.fields.description.version, 1);
    assert.deepStrictEqual(b1.fields.description.content[0].content[1], { type: 'hardBreak' });
    assert.strictEqual(b1.fields.environment.type, 'doc');
    const prebuilt = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
    await a.createWorkItem('Bug', { fields: { summary: 't', description: prebuilt } }, { execute: true });
    assert.deepStrictEqual(JSON.parse(f.calls[1].body).fields.description, prebuilt);
  });

  await test('updateWorkItem PUTs {fields}; addRelations parent folds into fields.parent; other rels are the explicit error', async () => {
    const f = fakeFetch([{ method: 'PUT', match: '/rest/api/3/issue/PROJ-5', status: 204, text: '' }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.updateWorkItem('PROJ-5', {
      fields: { summary: 'new title' },
      addRelations: [{ rel: 'parent', targetId: 'PROJ-2' }],
    }, { execute: true });
    assert.deepStrictEqual(r, { id: 'PROJ-5', url: `${BASE}/browse/PROJ-5` });
    const body = JSON.parse(f.calls[0].body);
    assert.strictEqual(body.fields.summary, 'new title');
    assert.deepStrictEqual(body.fields.parent, { key: 'PROJ-2' });
    await assert.rejects(
      () => a.updateWorkItem('PROJ-5', { addRelations: [{ rel: 'Blocks', targetId: 'PROJ-3' }] }, { execute: true }),
      /addRelation/);
  });

  await test('addRelation: parent → PUT fields.parent; other types → POST issueLink, acting item OUTWARD by default, attributes.direction overrides', async () => {
    const f = fakeFetch([
      { method: 'PUT', match: '/rest/api/3/issue/PROJ-8', status: 204, text: '' },
      { method: 'POST', match: '/rest/api/3/issueLink', status: 201, text: '' },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.addRelation('PROJ-8', 'parent', 'PROJ-2', { execute: true });
    assert.deepStrictEqual(JSON.parse(f.calls[0].body).fields.parent, { key: 'PROJ-2' });
    await a.addRelation('PROJ-30', 'Relates', 'PROJ-9', { execute: true });
    const link = JSON.parse(f.calls[1].body);
    assert.deepStrictEqual(link, {
      type: { name: 'Relates' },
      outwardIssue: { key: 'PROJ-30' },
      inwardIssue: { key: 'PROJ-9' },
    });
    await a.addRelation('PROJ-30', 'Blocks', 'PROJ-9', { execute: true, attributes: { direction: 'inward' } });
    const link2 = JSON.parse(f.calls[2].body);
    assert.deepStrictEqual(link2.inwardIssue, { key: 'PROJ-30' });
    assert.deepStrictEqual(link2.outwardIssue, { key: 'PROJ-9' });
  });

  // ── attachments: built-in FormData/Blob multipart ───────────────────────────
  await test('uploadAttachment POSTs built-in FormData with X-Atlassian-Token: no-check and NO manual Content-Type', async () => {
    const dir = proj();
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue/PROJ-44/attachments', json: [{ id: '9001', filename: 'shot.png', content: `${BASE}/rest/api/3/attachment/content/9001` }] }]);
    const r = await createAdapter({ cwd: dir, fetch: f }).uploadAttachment(png, { issueId: 'PROJ-44', execute: true });
    assert.deepStrictEqual(r, { name: 'shot.png', id: '9001', url: `${BASE}/rest/api/3/attachment/content/9001` });
    const call = f.calls[0];
    assert.ok(call.url.startsWith(`${BASE}/rest/api/3/issue/PROJ-44/attachments`), call.url);
    assert.ok(call.body instanceof FormData, 'built-in FormData travels as the body');
    const file = call.body.get('file');
    assert.ok(file && typeof file.arrayBuffer === 'function', 'a Blob rides the form');
    assert.strictEqual(Buffer.compare(Buffer.from(await file.arrayBuffer()), fs.readFileSync(png)), 0, 'raw bytes intact');
    assert.strictEqual(call.headers['X-Atlassian-Token'], 'no-check');
    const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('content-type'), 'fetch composes the multipart boundary itself');
  });

  await test('uploadAttachment without opts.issueId is a named exit-2 error (Jira has no unparented upload)', async () => {
    const dir = proj();
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.alloc(10));
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: dir, fetch: f });
    await assert.rejects(() => a.uploadAttachment(png, { execute: true }), (e) => {
      assert.strictEqual(e.exitCode, 2);
      assert.match(e.message, /issueId/);
      return true;
    });
    await assert.rejects(() => a.uploadAttachment(png, { execute: false }), /issueId/);
    assert.strictEqual(f.calls.length, 0);
  });

  // ── transition ──────────────────────────────────────────────────────────────
  await test('transition resolves by id or case-insensitive name, POSTs {transition:{id}}; dry run reads but sends no write', async () => {
    const TRANSITIONS = { transitions: [
      { id: '11', name: 'To Do', to: { name: 'To Do' } },
      { id: '31', name: 'Done', to: { name: 'Done' } },
    ] };
    const f = fakeFetch([
      { method: 'GET', match: '/rest/api/3/issue/PROJ-12/transitions', json: TRANSITIONS },
      { method: 'POST', match: '/rest/api/3/issue/PROJ-12/transitions', status: 204, text: '' },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const d = await a.transition('PROJ-12', 'done', { execute: false });
    assert.strictEqual(d.method, 'POST');
    assert.deepStrictEqual(d.body, { transition: { id: '31' } });
    assert.strictEqual(d.transition.name, 'Done', 'the descriptor carries the resolved transition');
    assert.strictEqual(f.calls.filter((c) => c.method === 'POST').length, 0, 'dry run sends no write');
    const r = await a.transition('PROJ-12', '31', { execute: true });
    assert.strictEqual(r.id, 'PROJ-12');
    assert.strictEqual(r.transition.id, '31');
    const post = f.calls.find((c) => c.method === 'POST');
    assert.deepStrictEqual(JSON.parse(post.body), { transition: { id: '31' } });
  });

  await test('transition with no match fails CLOSED listing the REAL available transitions (never guessed)', async () => {
    const f = fakeFetch([{ method: 'GET', match: '/transitions', json: { transitions: [{ id: '11', name: 'To Do' }, { id: '21', name: 'In Progress' }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(() => a.transition('PROJ-12', 'Done', { execute: true }), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.match(e.serverMessage, /To Do/);
      assert.match(e.serverMessage, /In Progress/);
      return true;
    });
    assert.strictEqual(f.calls.filter((c) => c.method === 'POST').length, 0);
  });

  // ── comments ────────────────────────────────────────────────────────────────
  await test('addComment wraps a plain string via toAdf; a prebuilt ADF doc passes through', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue/PROJ-3/comment', json: { id: '5001' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.addComment('PROJ-3', 'retested — fixed', { execute: true });
    assert.strictEqual(r.id, '5001');
    const body = JSON.parse(f.calls[0].body);
    assert.strictEqual(body.body.type, 'doc');
    assert.strictEqual(body.body.content[0].content[0].text, 'retested — fixed');
    const prebuilt = { type: 'doc', version: 1, content: [] };
    await a.addComment('PROJ-3', prebuilt, { execute: true });
    assert.deepStrictEqual(JSON.parse(f.calls[1].body).body, prebuilt);
    const d = await a.addComment('PROJ-3', 'dry', { execute: false });
    assert.strictEqual(d.method, 'POST');
    assert.strictEqual(f.calls.length, 2, 'dry run sent nothing');
  });

  // ── capability flags + honest gaps ─────────────────────────────────────────
  await test('capability flags exactly as designed (dialect json, query jql, every gap declared)', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    assert.strictEqual(a.name, 'jira');
    assert.deepStrictEqual(a.capabilities, {
      validateOnly: false,
      attachments: true,
      testPlans: false,
      testRuns: false,
      relations: { parent: true, testedBy: false, attachedFile: false },
      dialect: 'json',
      query: 'jql',
      deleteWorkItem: false,
      transitions: true,
      comments: true,
      sprints: true,
    });
  });

  await test('test-plan/run ops throw TrackerErrors naming their capability flag (backstops behind flag branching)', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    for (const [op, args, flag] of [
      ['listSuites', [3], 'testPlans'],
      ['listSuiteCases', [3, 4], 'testPlans'],
      ['getPoint', [3, 4, 5], 'testPlans'],
      ['addCaseToSuite', [3, 4, 5, {}], 'testPlans'],
      ['listRunResults', [55], 'testRuns'],
      ['createRun', [{}, {}], 'testRuns'],
      ['updateRunResults', [55, [], {}], 'testRuns'],
      ['updateRun', [55, {}, {}], 'testRuns'],
    ]) {
      await assert.rejects(() => a[op](...args), (e) => {
        assert.ok(e instanceof TrackerError, `${op} throws TrackerError`);
        assert.ok(e.message.includes(flag), `${op} names ${flag}: ${e.message}`);
        return true;
      });
    }
  });

  await test('deleteWorkItem is never offered: it throws naming the permanent-only delete and the flag', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    await assert.rejects(() => a.deleteWorkItem('PROJ-1', { execute: true }), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.match(e.message, /permanent/i);
      assert.match(e.message, /deleteWorkItem/);
      return true;
    });
  });

  await test('webUrl is exposed: {base}/browse/{key}', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    assert.strictEqual(a.webUrl('PROJ-12'), `${BASE}/browse/PROJ-12`);
  });

  // ── dry run: execute:false sends NOTHING, descriptors are redacted ─────────
  await test('every write with execute:false sends nothing and returns a redacted descriptor', async () => {
    const dir = proj({ envLines: '' }); // no credentials on purpose: a dry run must not even need them
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.alloc(10));
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: dir, fetch: f });
    const descriptors = [
      await a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: false }),
      await a.updateWorkItem('PROJ-5', { fields: { summary: 't' } }, { execute: false }),
      await a.addRelation('PROJ-5', 'Relates', 'PROJ-9', { execute: false }),
      await a.uploadAttachment(png, { issueId: 'PROJ-5', execute: false }),
      await a.addComment('PROJ-5', 'note', { execute: false }),
    ];
    assert.strictEqual(f.calls.length, 0, 'zero requests sent');
    for (const d of descriptors) {
      assert.ok(d.method && d.url, 'descriptor carries method + url');
      assert.strictEqual(d.headers.authorization, '<Basic ***, not printed>');
      assert.ok(!JSON.stringify(d).includes(SENTINEL_TOKEN));
    }
    assert.strictEqual(descriptors[3].headers['x-atlassian-token'], 'no-check');
    assert.match(JSON.stringify(descriptors[3].body), /shot\.png/);
  });

  // ── error contract ──────────────────────────────────────────────────────────
  await test('non-2xx: TrackerError joins errorMessages[] + errors{} into serverMessage, body capped at 500 chars', async () => {
    const errBody = JSON.stringify({
      errorMessages: ['Field \'priority\' is required.'],
      errors: { assignee: 'User does not exist.' },
      pad: 'x'.repeat(2000),
    });
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue', status: 400, text: errBody }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(() => a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: true }), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.strictEqual(e.op, 'createWorkItem');
      assert.strictEqual(e.status, 400);
      assert.match(e.serverMessage, /priority.*required/);
      assert.match(e.serverMessage, /assignee: User does not exist/);
      assert.ok(e.body.length <= 500);
      return true;
    });
  });

  await test('a timeout aborts cleanly into a TrackerError (never a raw fetch error)', async () => {
    const keepAlive = setTimeout(() => {}, 5000);
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    const a = createAdapter({ cwd: proj(), fetch: hanging, timeoutMs: 25 });
    try {
      await assert.rejects(() => a.getWorkItem('PROJ-1'), (e) => {
        assert.ok(e instanceof TrackerError);
        assert.match(e.serverMessage, /timed out after 25ms/);
        return true;
      });
    } finally { clearTimeout(keepAlive); }
  });

  await test('a network-level failure is wrapped, not rethrown raw', async () => {
    const dead = async () => { throw new Error('getaddrinfo ENOTFOUND example.atlassian.net'); };
    const a = createAdapter({ cwd: proj(), fetch: dead });
    await assert.rejects(() => a.getWorkItem('PROJ-1'), (e) => e instanceof TrackerError && /ENOTFOUND/.test(e.serverMessage));
  });

  // ── structural: nothing in the lib can spawn a process ─────────────────────
  await test('no child_process anywhere in scripts/lib/tracker/ (structural source read)', async () => {
    const root = path.join(__dirname, '..');
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
          const src = fs.readFileSync(full, 'utf8');
          if (/child_process|spawnSync|execSync/.test(src)) offenders.push(entry.name);
        }
      }
    })(root);
    assert.deepStrictEqual(offenders, [], 'the tracker lib must never compose a command line');
  });

  // ── sentinel sweep: credentials appear in ZERO bytes of anything returned ──
  await test('sentinel token/email absent from every return value and every error of a full op sweep', async () => {
    const f = fakeFetch([
      { match: '/rest/api/3/issue/PROJ-1', json: { key: 'PROJ-1', fields: {} } },
      { method: 'POST', match: '/search/jql', json: { issues: [] } },
      { method: 'POST', match: '/rest/api/3/issue', json: { key: 'PROJ-2' } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const outputs = [];
    outputs.push(await a.getWorkItem('PROJ-1'));
    outputs.push(await a.findByTitle('Bug', 't'));
    outputs.push(await a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: true }));
    try { await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/rest/api/3/issue/PROJ-1', status: 500, text: 'boom' }]) }).getWorkItem('PROJ-1'); }
    catch (e) { outputs.push({ msg: e.message, own: { ...e } }); }
    const all = JSON.stringify(outputs);
    assert.ok(!all.includes(SENTINEL_TOKEN), 'raw token leaked');
    assert.ok(!all.includes(SENTINEL_B64), 'base64 auth pair leaked');
    assert.ok(!all.includes(SENTINEL_EMAIL), 'the email is credential material too');
  });

  // ── CI guard (invariant 4 / ci-quality-gate): no tracker writes in CI mode ──
  // Exact parity with the ADO adapter's choke-point guard (same refusal, same
  // wording/shape; reads and dry-run descriptors unaffected).
  await test('under AGENTEX_CI=1 every write with execute:true is refused (exit-2 error, ci-mode, ZERO requests)', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const dir = proj();
      const png = path.join(dir, 'shot.png');
      fs.writeFileSync(png, Buffer.alloc(4096));
      const f = fakeFetch([]);
      const a = createAdapter({ cwd: dir, fetch: f });
      const writes = [
        () => a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: true }),
        () => a.updateWorkItem('PROJ-42', { fields: { summary: 'y' } }, { execute: true }),
        () => a.addRelation('PROJ-42', 'Relates', 'PROJ-9', { execute: true }),
        () => a.addRelation('PROJ-42', 'parent', 'PROJ-9', { execute: true }),
        () => a.uploadAttachment(png, { issueId: 'PROJ-42', execute: true }),
        () => a.transition('PROJ-42', 'Done', { execute: true }),
        () => a.addComment('PROJ-42', 'note', { execute: true }),
      ];
      for (const w of writes) {
        await assert.rejects(w, (e) => {
          assert.match(e.message, /ci-mode: tracker writes are disabled in CI/);
          assert.strictEqual(e.exitCode, 2, 'the refusal is environment-class (2), never a product failure (1)');
          return true;
        });
      }
      assert.strictEqual(f.calls.length, 0, 'the guard refuses BEFORE any request leaves the machine');
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('under AGENTEX_CI=1 execute:false descriptors and reads are UNAFFECTED', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const f = fakeFetch([
        { match: '/rest/api/3/issue/PROJ-1', json: { key: 'PROJ-1', fields: {} } },
        { method: 'POST', match: '/search/jql', json: { issues: [] } },
      ]);
      const a = createAdapter({ cwd: proj(), fetch: f });
      assert.strictEqual((await a.getWorkItem('PROJ-1')).key, 'PROJ-1', 'reads still work');
      assert.deepStrictEqual(await a.findByTitle('Bug', 't'), [], 'query reads still work');
      const d = await a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: false });
      assert.strictEqual(d.method, 'POST', 'the dry-run descriptor path is untouched');
      assert.strictEqual(f.calls.filter((c) => c.method !== 'GET' && !c.url.includes('/search/jql')).length, 0, 'still zero writes');
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('without AGENTEX_CI the same writes go through (the guard keys on the env var alone)', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/rest/api/3/issue', json: { key: 'PROJ-77' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.createWorkItem('Bug', { fields: { summary: 't' } }, { execute: true });
    assert.strictEqual(r.id, 'PROJ-77');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
