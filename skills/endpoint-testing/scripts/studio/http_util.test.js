'use strict';
// Tests for studio/http_util.js — the loopback page-server helpers (wizard pattern, copied).
// Run: node skills/endpoint-testing/scripts/studio/http_util.test.js
const assert = require('node:assert');
const http = require('node:http');
const U = require('./http_util.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function serverWith(tokens) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const role = U.roleOf(req, tokens);
      if (req.url.startsWith('/api/') && !role) return U.forbid(res);
      U.respondJSON(res, 200, { ok: true, role });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
      let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', reject);
  });
}

(async () => {
  await test('an /api/ call without the token -> 403; page and control tokens map to their roles', async () => {
    const { srv, port } = await serverWith({ page: 'p-tok', control: 'c-tok' });
    const none = await get(port, '/api/x');
    const wrong = await get(port, '/api/x', { 'x-studio-token': 'nope' });
    const page = await get(port, '/api/x', { 'x-studio-token': 'p-tok' });
    const ctl = await get(port, '/api/x', { 'x-studio-control': 'c-tok' });
    const crossed = await get(port, '/api/x', { 'x-studio-token': 'c-tok' });
    srv.close();
    assert.strictEqual(none.status, 403);
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(JSON.parse(page.body).role, 'page');
    assert.strictEqual(JSON.parse(ctl.body).role, 'control');
    assert.strictEqual(crossed.status, 403, 'the control token is not accepted as a page token');
  });

  await test('responses carry no Access-Control-Allow-Origin and set nosniff', async () => {
    const { srv, port } = await serverWith({ page: 'p', control: 'c' });
    const r = await get(port, '/api/x', { 'x-studio-token': 'p' });
    const f = await get(port, '/api/x');
    srv.close();
    for (const res of [r, f]) {
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    }
  });

  await test('port-in-use message names the next port', async () => {
    assert.strictEqual(U.portInUseMessage(7380), '[studio] Port 7380 is in use. Try --port=7381');
  });

  await test('readBody caps the body size', async () => {
    const srv = http.createServer((req, res) => U.readBody(req, 10).then(b => U.respondJSON(res, 200, { len: b.length }), e => U.respondJSON(res, 413, { error: e.message })));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const post = body => new Promise(resolve => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve(res.statusCode)); });
      q.end(body);
    });
    assert.strictEqual(await post('12345'), 200);
    assert.strictEqual(await post('x'.repeat(50)), 413);
    srv.close();
  });

  await test('timing-safe token comparison rejects different lengths', async () => {
    assert.strictEqual(U.sameToken('abc', 'abc'), true);
    assert.strictEqual(U.sameToken('abc', 'abcd'), false);
    assert.strictEqual(U.sameToken(undefined, 'abc'), false);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
