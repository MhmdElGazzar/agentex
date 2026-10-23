'use strict';
// Tests for studio/server.js — the loopback studio: token gate, session file, editor Save/Run.
// Wizard steps and the agent channel are in wizard.test.js.
// Run: node skills/endpoint-testing/scripts/studio/server.test.js
const { assert, fs, os, path, harness, req, studio, fakeService, waitRun, editorProject, SUITE_REL, sessionFile } = require('../golden/studio_helpers.js');
const { test, done } = harness();

(async () => {
  await test('S-4: the studio run-folder name equals init_run.js\'s for the same instant', async () => {
    const { stamp } = require('./server.js');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-stamp-'));
    const before = stamp();
    const out = require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'test-execution', 'scripts', 'init_run.js')], { cwd, encoding: 'utf8' });
    const after = stamp();
    const name = path.basename(JSON.parse(out.trim().split('\n').pop()).runDir);
    assert.ok([`execu_${before}`, `execu_${after}`].includes(name), `${name} vs ${before}/${after}`);
  });

  await test('every /api/* route answers 403 without the token; binds 127.0.0.1', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    assert.strictEqual(s.st.server.address().address, '127.0.0.1');
    const routes = [['GET', '/api/strings'], ['GET', '/api/envs'], ['GET', '/api/suites'], ['GET', `/api/suite?path=${SUITE_REL}`], ['POST', '/api/suite/save'], ['POST', '/api/run'], ['GET', '/api/run/run-1'], ['GET', '/api/collected?suite=x'], ['GET', '/api/log?path=x'], ['GET', '/api/done'],
      ['POST', '/api/wizard/spec'], ['POST', '/api/wizard/select'], ['POST', '/api/wizard/collect'], ['POST', '/api/wizard/collect-again'], ['POST', '/api/wizard/cancel'], ['POST', '/api/wizard/gate-cleared'], ['POST', '/api/wizard/value'], ['POST', '/api/wizard/consent'], ['GET', '/api/wizard/state'], ['GET', '/api/wizard/preview'], ['POST', '/api/wizard/approve'],
      ['GET', '/api/agent/next?timeout=10'], ['POST', '/api/agent/event'], ['POST', '/api/agent/token']];
    for (const [m, p] of routes) {
      const r = await req(s.st.port, m, p, { body: m === 'POST' ? {} : undefined, headers: { 'x-studio-token': 'wrong' } });
      assert.strictEqual(r.status, 403, `${m} ${p}`);
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
    }
    // the agent's control token is not a page token, and the page token is not a control token
    assert.strictEqual((await s.agent('GET', '/api/suites')).status, 403);
    assert.ok([403, 404].includes((await s.page('GET', '/api/agent/next?timeout=10')).status));
    s.close();
  });

  await test('a Host other than 127.0.0.1:<port> / localhost:<port> gets 403 on every route; a foreign Origin on /api/* gets 403 (N12)', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const port = s.st.port;
    const tok = { 'x-studio-token': s.st.state.pageToken };
    const evil = { host: `rebind.example:${port}` };
    for (const p of ['/', '/editor', '/wizard', '/favicon.ico', '/nope']) {
      const r = await req(port, 'GET', p, { headers: evil });
      assert.strictEqual(r.status, 403, p);
      assert.ok(!r.text.includes(s.st.state.pageToken), `${p} leaks the page token`);
    }
    assert.strictEqual((await req(port, 'GET', '/api/suites', { headers: { ...tok, ...evil } })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/api/agent/next?timeout=10', { headers: { 'x-studio-control': s.st.state.controlToken, ...evil } })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/editor', { headers: { host: `127.0.0.1:${port + 1}` } })).status, 403);
    // the loopback names on the right port are served
    assert.strictEqual((await req(port, 'GET', '/editor', { headers: { host: `localhost:${port}` } })).status, 200);
    assert.strictEqual((await req(port, 'GET', '/api/suites', { headers: { ...tok, host: `localhost:${port}` } })).status, 200);
    // Origin on /api/*: absent or the same loopback origin only
    assert.strictEqual((await req(port, 'GET', '/api/suites', { headers: { ...tok, origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.strictEqual((await req(port, 'GET', '/api/suites', { headers: { ...tok, origin: 'http://evil.example' } })).status, 403);
    assert.strictEqual((await req(port, 'POST', '/api/suite/save', { body: {}, headers: { ...tok, origin: 'null' } })).status, 403);
    s.close();
  });

  await test('the session file sits in the OS temp dir, mode 0600, never under the project; removed on close', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const f = sessionFile(dir);
    assert.ok(f.startsWith(path.join(os.tmpdir(), 'agentex-studio')));
    assert.ok(!f.startsWith(dir));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(rec.port, s.st.port);
    s.close();
    assert.ok(!fs.existsSync(f));
  });

  await test('the editor page is served with the per-run token, Arabic by default, --lang=en honoured', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const ar = await req(s.st.port, 'GET', '/editor');
    assert.match(ar.text, /<html lang="ar" dir="rtl">/);
    assert.ok(ar.text.includes(s.st.state.pageToken));
    assert.ok(!ar.text.includes(s.st.state.controlToken));
    const en = await req(s.st.port, 'GET', '/editor?lang=en');
    assert.match(en.text, /<html lang="en" dir="ltr">/);
    s.close();
  });

  await test('suites list and suite load: counts, endpoints from the catalog, etag', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const list = (await s.page('GET', '/api/suites')).json;
    assert.strictEqual(list.defaultEnvironment, 'qc');
    assert.deepStrictEqual(list.suites.map(x => [x.path, x.endpoints, x.cases, x.needsReview]), [[SUITE_REL, 2, 4, 1]]);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    assert.strictEqual(one.endpoints['orders.get-order'].path, '/orders/{orderId}');
    assert.deepStrictEqual(one.endpoints['orders.get-order'].pathParams, ['orderId']);
    assert.match(one.etag, /^[0-9a-f]{64}$/);
    s.close();
  });

  await test('save: ok, then a stale etag -> 409 conflict with the file unchanged; catalogs are refused', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const ok = await s.page('POST', '/api/suite/save', { path: SUITE_REL, etag: one.etag, edits: [{ op: 'update', index: 3, case: { params: { status: 'open' }, sources: { status: 'manual' } } }] });
    assert.strictEqual(ok.status, 200, ok.text);
    const before = fs.readFileSync(path.join(dir, SUITE_REL));
    const stale = await s.page('POST', '/api/suite/save', { path: SUITE_REL, etag: one.etag, edits: [{ op: 'delete', index: 1 }] });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error, 'conflict');
    assert.ok(fs.readFileSync(path.join(dir, SUITE_REL)).equals(before));
    const cat = await s.page('POST', '/api/suite/save', { path: 'integration/api_test_suites/orders/orders_api.json', etag: 'x', edits: [] });
    assert.strictEqual(cat.status, 400);
    s.close();
  });

  await test('run refused with unsaved edits and with a stale etag; nothing spawned', async () => {
    const dir = editorProject(9);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const dirty = await s.page('POST', '/api/run', { suite: SUITE_REL, etag: one.etag, dirty: true });
    assert.strictEqual(dirty.status, 409);
    assert.strictEqual(dirty.json.error, 'unsaved');
    const stale = await s.page('POST', '/api/run', { suite: SUITE_REL, etag: 'old', dirty: false });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error, 'stale');
    assert.ok(!fs.existsSync(path.join(dir, 'executions')));
    s.close();
  });

  await test('Run all spawns run_suite --suite --env: evidence (logs, suite-result.json, result.md) in executions/', async () => {
    const svc = await fakeService();
    const dir = editorProject(svc.port);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const r = await s.page('POST', '/api/run', { suite: SUITE_REL, etag: one.etag, env: 'qc' });
    assert.strictEqual(r.status, 200, r.text);
    const done = await waitRun(s.page, r.json.id);
    svc.srv.close();
    assert.strictEqual(done.result.suite, SUITE_REL);
    assert.strictEqual(done.result.env, 'qc');
    assert.deepStrictEqual(done.result.cases.map(c => c.result), ['PASS', 'PASS', 'BLOCKED', 'BLOCKED']);
    assert.strictEqual(done.result.cases[2].reasonCode, 'placeholder');
    const runDir = path.join(dir, r.json.runDir);
    // S-4: the folder is named like init_run.js names /test-endpoints runs — local time, no "T"/"Z"
    assert.match(path.basename(path.dirname(r.json.runDir)), /^execu_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$/);
    const m = /execu_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(r.json.runDir);
    const named = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    assert.ok(Math.abs(Date.now() - named) < 60000, 'the folder name is the local time of the run');
    assert.ok(fs.existsSync(path.join(runDir, 'suite-result.json')));
    assert.match(fs.readFileSync(path.join(runDir, 'result.md'), 'utf8'), /Severity: not rated \(run from the editor/);
    assert.strictEqual(fs.readdirSync(path.join(runDir, 'logs')).length, 2);
    assert.strictEqual(svc.seen.length, 2, 'skipped and placeholder cases are never sent');
    // the editor's last result reads the newest suite-result.json
    const again = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    assert.strictEqual(again.last[1].result, 'PASS');
    s.close();
  });

  await test('Run this case spawns run_suite --case n: one request only', async () => {
    const svc = await fakeService();
    const dir = editorProject(svc.port);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const r = await s.page('POST', '/api/run', { suite: SUITE_REL, case: 2, etag: one.etag, env: 'qc' });
    const done = await waitRun(s.page, r.json.id);
    svc.srv.close();
    assert.strictEqual(done.result.case, 2);
    assert.deepStrictEqual(done.result.cases.map(c => [c.name, c.index]), [['get-not-found', 2]]);
    assert.strictEqual(svc.seen.length, 1);
    s.close();
  });

  await test('nothing runnable -> says so, no executions folder, zero requests', async () => {
    const svc = await fakeService();
    const dir = editorProject(svc.port);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const r3 = await s.page('POST', '/api/run', { suite: SUITE_REL, case: 3, etag: one.etag, env: 'qc' });
    const r4 = await s.page('POST', '/api/run', { suite: SUITE_REL, case: 4, etag: one.etag, env: 'qc' });
    svc.srv.close();
    assert.deepStrictEqual([r3.json.nothing, r3.json.review, r3.json.skipped], [true, 1, 0]);
    assert.deepStrictEqual([r4.json.nothing, r4.json.review, r4.json.skipped], [true, 0, 1]);
    assert.ok(!fs.existsSync(path.join(dir, 'executions')));
    assert.strictEqual(svc.seen.length, 0);
    s.close();
  });

  await test('an unknown environment comes back BLOCKED from the runner and is shown as it is', async () => {
    const svc = await fakeService();
    const dir = editorProject(svc.port);
    const s = await studio(dir);
    const one = (await s.page('GET', `/api/suite?path=${SUITE_REL}`)).json;
    const r = await s.page('POST', '/api/run', { suite: SUITE_REL, case: 1, etag: one.etag, env: 'nowhere' });
    const done = await waitRun(s.page, r.json.id);
    svc.srv.close();
    assert.strictEqual(done.result.cases[0].result, 'BLOCKED');
    assert.match(done.result.cases[0].reason, /environment "nowhere" not found/);
    assert.strictEqual(svc.seen.length, 0);
    s.close();
  });

  await test('the evidence log route serves only executions/**/*.log', async () => {
    const dir = editorProject(9);
    fs.mkdirSync(path.join(dir, 'executions/execu_x/api-tests/logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'executions/execu_x/api-tests/logs/a.log'), 'GET /x\n\nHTTP_STATUS:200\n');
    const s = await studio(dir);
    assert.strictEqual((await s.page('GET', '/api/log?path=executions/execu_x/api-tests/logs/a.log')).json.text, 'GET /x\n\nHTTP_STATUS:200\n');
    assert.strictEqual((await s.page('GET', '/api/log?path=.env')).status, 400);
    assert.strictEqual((await s.page('GET', '/api/log?path=executions/../.env.log')).status, 400);
    s.close();
  });

  await test('--spec and --suite reach the page script as data: a quote, </script>, U+2028/9, a backslash, a newline and $& run nothing', async () => {
    const vm = require('node:vm');
    const hostile = ["x';globalThis.__pwn=1;//", '</script><script>globalThis.__pwn=2</script>', 'a\u2028b\u2029c', 'back\\slash\\', 'line\nbreak', "$&$'$`", 'https://api.example.com/v1/swagger.json'];
    const tpl = fs.readFileSync(path.join(__dirname, 'studio.html'), 'utf8');
    for (const value of hostile) {
      const s = await studio(editorProject(9), { spec: value, suite: value });
      const html = (await req(s.st.port, 'GET', '/editor')).text;
      s.close();
      assert.strictEqual(html.split('</script>').length, tpl.split('</script>').length, `no extra script end for ${JSON.stringify(value)}`);
      const line = html.split('\n').find(l => l.startsWith('const STUDIO = '));
      const ctx = vm.createContext({});
      const got = vm.runInContext(line + '\n;STUDIO', ctx);
      assert.strictEqual(ctx.__pwn, undefined, `ran injected code for ${JSON.stringify(value)}`);
      assert.strictEqual(got.spec, value);
      assert.strictEqual(got.suite, value);
    }
  });

  done();
})();
