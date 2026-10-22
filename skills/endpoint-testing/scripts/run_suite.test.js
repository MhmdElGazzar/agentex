'use strict';
// Tests for run_suite.js against a local HTTP server.
// Run: node skills/endpoint-testing/scripts/run_suite.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run_suite.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-runsuite-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
function run(cwd, args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [RUNNER, ...args], { cwd });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => resolve({ code, out: JSON.parse(out.trim().split('\n').pop() || '{}') }));
  });
}
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/ok') { res.writeHead(200); res.end('{"title":"x"}'); }
      else { res.writeHead(404); res.end('{}'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const catalog = port => ({
  name: 'svc', baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' },
  requests: [{ name: 'ok', method: 'GET', path: '/ok', params: [] }, { name: 'missing', method: 'GET', path: '/nope', params: [] }],
});

(async () => {
  await test('all cases pass -> PASS, exit 0', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'ok-200', entry: 'svc.ok', expect: { status: 200, fields: ['title'] } },
        { name: 'missing-404', entry: 'svc.missing', expect: { status: 404 } },
      ] },
    });
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.result, 'PASS');
    assert.strictEqual(out.passed, 2);
  });

  await test('one failing case -> FAIL, exit 1', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'wrong-status', entry: 'svc.ok', expect: { status: 201 } },
        { name: 'fine', entry: 'svc.ok', expect: { status: 200 } },
      ] },
    });
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 1);
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(out.passed, 1);
  });

  await test('unknown entry / case without name -> BLOCKED, exit 2', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'ghost', entry: 'svc.does-not-exist' }, { entry: 'svc.ok' },
      ] },
    });
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.blocked, 2);
  });

  await test('missing suites folder, empty suites, bad JSON, no --run-dir -> BLOCKED', async () => {
    const empty = proj({ 'integration/.keep': '' });
    assert.strictEqual((await run(empty, ['--run-dir', path.join(empty, 'r')])).code, 2);
    const bad = proj({ 'integration/api_test_suites/x_suite.json': '{not json' });
    const r = await run(bad, ['--run-dir', path.join(bad, 'r')]);
    assert.strictEqual(r.code, 2); assert.match(r.out.reason, /invalid JSON/);
    assert.strictEqual((await run(bad, [])).code, 2);
  });

  await test('hostile case name cannot escape the logs folder', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [{ name: '../../escape', entry: 'svc.ok', expect: { status: 200 } }] },
    });
    const runDir = path.join(dir, 'run');
    await run(dir, ['--run-dir', runDir]);
    srv.close();
    assert.ok(!fs.existsSync(path.join(dir, 'escape.log')));
    assert.ok(fs.readdirSync(path.join(runDir, 'logs')).length === 1);
  });

  // ---- --env: passed through to every run_api.js call; absent -> run_api's default resolution ----
  // qc and uat each point their api block at their own server; the default is uat. The catalog is
  // the project's own API ("${API_BASE_URL}", no target), so the environment's api block targets it.
  function counting() {
    const seen = { hits: 0 };
    return new Promise(resolve => {
      const srv = http.createServer((req, res) => { seen.hits++; res.writeHead(200); res.end('{"title":"x"}'); });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
    });
  }
  const twoEnvProject = (qcPort, uatPort) => proj({
    'config/project.json': { defaultEnvironment: 'uat' },
    'environments/qc.json': { api: { baseUrl: `http://127.0.0.1:${qcPort}` } },
    'environments/uat.json': { api: { baseUrl: `http://127.0.0.1:${uatPort}` } },
    'integration/api_test_suites/svc/svc_api.json': { name: 'svc', baseUrl: '${API_BASE_URL}', auth: { type: 'none' },
      requests: [{ name: 'ok', method: 'GET', path: '/ok', params: [] }] },
    'integration/api_test_suites/svc/svc_suite.json': { cases: [
      { name: 'one', entry: 'svc.ok', expect: { status: 200 } },
      { name: 'two', entry: 'svc.ok', expect: { status: 200 } },
    ] },
  });

  await test('--env qc is passed to every run_api.js call', async () => {
    const qc = await counting(), uat = await counting();
    const dir = twoEnvProject(qc.port, uat.port);
    const { code, out } = await run(dir, ['--env', 'qc', '--run-dir', path.join(dir, 'run')]);
    qc.srv.close(); uat.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.passed, 2);
    assert.strictEqual(qc.seen.hits, 2);
    assert.strictEqual(uat.seen.hits, 0);
  });

  await test('no --env -> not passed; run_api.js resolves the default environment', async () => {
    const qc = await counting(), uat = await counting();
    const dir = twoEnvProject(qc.port, uat.port);
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    qc.srv.close(); uat.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(uat.seen.hits, 2);
    assert.strictEqual(qc.seen.hits, 0);
  });

  await test('unknown --env -> every case BLOCKED with the environment resolution error', async () => {
    const qc = await counting(), uat = await counting();
    const dir = twoEnvProject(qc.port, uat.port);
    const { code, out } = await run(dir, ['--env', 'nope', '--run-dir', path.join(dir, 'run')]);
    qc.srv.close(); uat.srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.blocked, 2);
    for (const c of out.cases) assert.match(c.reason, /environment "nope" not found — available: qc, uat/);
    assert.strictEqual(qc.seen.hits + uat.seen.hits, 0);
  });

  await test('a case with a skip string is BLOCKED quoting the reason and never executed', async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => { hits++; res.end('{}'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'del', entry: 'svc.ok', skip: 'review: write operation — remove this line to enable', expect: { status: 200 } },
      ] },
    });
    const runDir = path.join(dir, 'run');
    const { code, out } = await run(dir, ['--run-dir', runDir]);
    srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.blocked, 1);
    assert.strictEqual(out.cases[0].result, 'BLOCKED');
    assert.match(out.cases[0].reason, /"review: write operation — remove this line to enable"/);
    assert.strictEqual(hits, 0);
  });

  await test('a case with no expect (or an empty one) is BLOCKED, never PASS, and not executed', async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => { hits++; res.end('{}'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(srv.address().port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'no-expect', entry: 'svc.ok' }, { name: 'empty-expect', entry: 'svc.ok', expect: {} },
      ] },
    });
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.blocked, 2);
    for (const c of out.cases) assert.match(c.reason, /case has no expect/);
    assert.strictEqual(hits, 0);
  });

  await test('cases with the same name get distinct log files', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/api_test_suites/svc/svc_api.json': catalog(port),
      'integration/api_test_suites/svc/svc_suite.json': { cases: [
        { name: 'dup', entry: 'svc.ok', expect: { status: 200 } }, { name: 'dup', entry: 'svc.missing', expect: { status: 404 } },
      ] },
      'integration/api_test_suites/other/svc_suite.json': { cases: [{ name: 'dup', entry: 'svc.ok', expect: { status: 200 } }] },
    });
    const runDir = path.join(dir, 'run');
    const { code, out } = await run(dir, ['--run-dir', runDir]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    const logs = out.cases.map(c => c.log);
    assert.strictEqual(new Set(logs).size, 3, logs.join(', '));
    assert.strictEqual(fs.readdirSync(path.join(runDir, 'logs')).length, 3);
    assert.ok(logs.every(l => /__\d+-dup\.log$/.test(l)), logs.join(', '));
  });

  await test('--env is passed through to run_api.js', async () => {
    const { srv, port } = await serve();
    const dir = proj({
      'integration/sample_api.json': { name: 'app', baseUrl: '${API_BASE_URL}', auth: { type: 'none' }, requests: [{ name: 'ok', method: 'GET', path: '/ok', params: [] }] },
      'integration/api_test_suites/app/app_suite.json': { cases: [{ name: 'ok', entry: 'app.ok', expect: { status: 200 } }] },
      'environments/uat.json': { api: { baseUrl: `http://127.0.0.1:${port}` } },
    });
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run'), '--env', 'uat']);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
  });

  // ---- swagger-suite-wizard: case auth / contains / omit / sources, subset runs, suite-result.json ----
  function recorder(respond) {
    const seen = [];
    return new Promise(resolve => {
      const srv = http.createServer((req, res) => {
        let b = '';
        req.on('data', d => (b += d));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
          if (respond) return respond(req, res, b);
          res.setHeader('content-type', 'application/json');
          if (!req.headers.authorization) { res.writeHead(401); res.end('{"message":"a token is required"}'); return; }
          res.end('{"id":1,"message":"status must be one of open, closed"}');
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
    });
  }
  const ordersCat = port => ({
    name: 'orders', target: 'catalog', baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'bearer', tokenEnv: 'ORDERS_TOKEN' },
    requests: [
      { name: 'list', method: 'GET', path: '/orders', params: ['status', 'page'], query: ['status', 'page'] },
      { name: 'create', method: 'POST', path: '/orders', params: ['item'], body: { item: { $param: 'item', type: 'json' } } },
    ],
  });
  const S = 'integration/api_test_suites/orders/orders_suite.json';
  const ordersProj = (port, cases, extra = {}) => proj({
    'integration/api_test_suites/orders/orders_api.json': ordersCat(port),
    [S]: { cases },
    '.env': 'ORDERS_TOKEN=tok-suite\n',
    ...extra,
  });

  await test('case auth "none" -> run_api.js --no-auth: no credential sent, 401 can pass', async () => {
    const { srv, port, seen } = await recorder();
    const dir = ordersProj(port, [{ name: 'no-token', entry: 'orders.list', auth: 'none', params: { status: 'open', page: 1 }, expect: { status: 401 } }]);
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(seen[0].headers.authorization, undefined);
  });

  await test('case auth with any other value -> BLOCKED naming the case and the value, not sent', async () => {
    const { srv, port, seen } = await recorder();
    const dir = ordersProj(port, [{ name: 'weird', entry: 'orders.list', auth: 'user-b', params: { status: 'open', page: 1 }, expect: { status: 200 } }]);
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(out.cases[0].result, 'BLOCKED');
    assert.strictEqual(out.cases[0].reason, 'case "weird": "auth" must be "none" or absent (got "user-b")');
    assert.strictEqual(seen.length, 0);
  });

  await test('expect.contains is forwarded and counts as an expectation', async () => {
    const { srv, port } = await recorder();
    const dir = ordersProj(port, [
      { name: 'contains-pass', entry: 'orders.list', params: { status: 'x', page: 1 }, expect: { contains: { message: 'status' } } },
      { name: 'contains-fail', entry: 'orders.list', params: { status: 'x', page: 1 }, expect: { contains: { message: 'quantity' } } },
    ]);
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.deepStrictEqual(out.cases.map(c => c.result), ['PASS', 'FAIL']);
  });

  await test('omit is forwarded: the param is left out of the request', async () => {
    const { srv, port, seen } = await recorder();
    const dir = ordersProj(port, [{ name: 'missing-status', entry: 'orders.list', omit: ['status'], params: { status: 'open', page: 1 }, expect: { status: 200 } }]);
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(out.cases[0].result, 'PASS', JSON.stringify(out));
    assert.strictEqual(seen[0].url, '/orders?page=1');
  });

  await test('a placeholder source -> BLOCKED reasonCode placeholder, zero requests at the server', async () => {
    const { srv, port, seen } = await recorder();
    const dir = ordersProj(port, [{ name: 'happy', entry: 'orders.list', params: { status: 'example', page: 1 }, sources: { status: 'placeholder', page: 'manual' }, expect: { status: 200 } }]);
    const { code, out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.cases[0].result, 'BLOCKED');
    assert.strictEqual(out.cases[0].reasonCode, 'placeholder');
    assert.strictEqual(out.cases[0].reason, 'needs a real value: param "status" is still a placeholder — set it in the editor or the suite file');
    assert.strictEqual(seen.length, 0);
  });

  const twoSuites = port => ordersProj(port, [
    { name: 'a', entry: 'orders.list', params: { status: 'open', page: 1 }, expect: { status: 200 } },
    { name: 'b', entry: 'orders.list', params: { status: 'open', page: 2 }, expect: { status: 200 } },
    { name: 'c', entry: 'orders.list', params: { status: 'open', page: 3 }, expect: { status: 200 } },
  ], { 'integration/api_test_suites/other/other_suite.json': { cases: [{ name: 'z', entry: 'orders.list', params: { status: 'z', page: 9 }, expect: { status: 200 } }] } });

  await test('--suite runs only that suite file', async () => {
    const { srv, port, seen } = await recorder();
    const dir = twoSuites(port);
    const { code, out } = await run(dir, ['--suite', S, '--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.cases.map(c => c.name), ['a', 'b', 'c']);
    assert.strictEqual(seen.length, 3);
  });

  await test('--suite outside --suites -> BLOCKED, nothing sent', async () => {
    const { srv, port, seen } = await recorder();
    const dir = twoSuites(port);
    fs.writeFileSync(path.join(dir, 'stray_suite.json'), JSON.stringify({ cases: [{ name: 'x', entry: 'orders.list', params: { status: 'a', page: 1 }, expect: { status: 200 } }] }));
    const { code, out } = await run(dir, ['--suite', 'stray_suite.json', '--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.result, 'BLOCKED');
    assert.match(out.reason, /not under/);
    assert.strictEqual(seen.length, 0);
  });

  await test('--case n runs only the nth case of the suite', async () => {
    const { srv, port, seen } = await recorder();
    const dir = twoSuites(port);
    const { code, out } = await run(dir, ['--suite', S, '--case', '2', '--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.cases.map(c => [c.name, c.index]), [['b', 2]]);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, '/orders?status=open&page=2');
  });

  await test('--case without --suite -> BLOCKED', async () => {
    const dir = twoSuites(9);
    const { code, out } = await run(dir, ['--case', '1', '--run-dir', path.join(dir, 'run')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /--case needs --suite/);
  });

  await test('--case out of range -> BLOCKED naming the case count', async () => {
    const dir = twoSuites(9);
    const { code, out } = await run(dir, ['--suite', S, '--case', '4', '--run-dir', path.join(dir, 'run')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /has 3 cases/);
  });

  await test('suite-result.json equals the stdout summary plus schemaVersion and run metadata', async () => {
    const { srv, port } = await recorder();
    const dir = twoSuites(port);
    const runDir = path.join(dir, 'run');
    const { out } = await run(dir, ['--suite', S, '--case', '1', '--env', 'qc', '--run-dir', runDir].filter(a => a !== '--env' && a !== 'qc'));
    srv.close();
    const file = JSON.parse(fs.readFileSync(path.join(runDir, 'suite-result.json'), 'utf8'));
    assert.strictEqual(file.schemaVersion, 1);
    assert.strictEqual(file.suite, S);
    assert.strictEqual(file.case, 1);
    assert.ok(!Number.isNaN(Date.parse(file.startedAt)));
    const { schemaVersion, suite, case: c, env, startedAt, ...rest } = file;
    assert.deepStrictEqual(rest, out);
  });

  await test('every case result carries suite (relative path) and index (1-based)', async () => {
    const { srv, port } = await recorder();
    const dir = twoSuites(port);
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    const byName = Object.fromEntries(out.cases.map(c => [c.name, c]));
    assert.strictEqual(byName.c.suite, S);
    assert.strictEqual(byName.c.index, 3);
    assert.strictEqual(byName.z.suite, 'integration/api_test_suites/other/other_suite.json');
    assert.strictEqual(byName.z.index, 1);
    assert.strictEqual(typeof byName.a.ms, 'number');
  });

  await test('an object param is passed as JSON text', async () => {
    const { srv, port, seen } = await recorder();
    const dir = ordersProj(port, [{ name: 'create', entry: 'orders.create', params: { item: { sku: 'A-1', qty: 2 } }, expect: { status: 200 } }]);
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.strictEqual(out.cases[0].result, 'PASS', JSON.stringify(out));
    assert.deepStrictEqual(JSON.parse(seen[0].body), { item: { sku: 'A-1', qty: 2 } });
  });

  await test('legacy suite: per-case outcome identical to the snapshot taken on main', async () => {
    const fx = require('./golden/legacy_suite_fixture.js');
    const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'legacy-suite-snapshot.json'), 'utf8'));
    const srv = http.createServer(fx.handler);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const dir = proj(fx.files(srv.address().port));
    const { out } = await run(dir, ['--run-dir', path.join(dir, 'run')]);
    srv.close();
    assert.deepStrictEqual(fx.outcome(out), snapshot);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
