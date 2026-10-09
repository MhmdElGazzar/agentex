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
      'integration/api_test_suites/svc/svc_suite.json': { cases: [{ name: '../../escape', entry: 'svc.ok' }] },
    });
    const runDir = path.join(dir, 'run');
    await run(dir, ['--run-dir', runDir]);
    srv.close();
    assert.ok(!fs.existsSync(path.join(dir, 'escape.log')));
    assert.ok(fs.readdirSync(path.join(runDir, 'logs')).length === 1);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
