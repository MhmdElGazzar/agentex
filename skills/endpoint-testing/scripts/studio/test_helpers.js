'use strict';
// Shared helpers for the studio's tests (server.test.js, wizard.test.js, sentinel.test.js).
// Not a test file itself. The session file goes to os.tmpdir(): every test process points
// TMPDIR at a throwaway folder before loading the server.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-studio-tmp-'));
const { createStudio, sessionFile } = require('./server.js');
let wizardMount = null;
try { wizardMount = require('./wizard.js').mount; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Everything a test opens (studios, fake services) is closed after it, pass or fail, so a
// failing assertion never leaves a server holding the process open.
const opened = [];
function harness() {
  let passed = 0; const failures = [];
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
    finally { while (opened.length) { try { opened.pop()(); } catch { /* already closed */ } } }
  }
  function done() {
    console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
    process.exitCode = failures.length ? 1 : 0;
  }
  return { test, done };
}
function proj(files, { git = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-studio-')));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
function treeOf(dir) {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(`${path.relative(dir, f)}:${fs.readFileSync(f).length}`);
    }
  };
  walk(dir);
  return out.sort();
}
function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => (b += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text: b, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function studio(dir, opts = {}) {
  const st = await createStudio({ root: dir, port: 0, mount: wizardMount, log: () => {}, ...opts });
  const page = (method, p, body) => req(st.port, method, p, { body, headers: { 'x-studio-token': st.state.pageToken } });
  const agent = (method, p, body) => req(st.port, method, p, { body, headers: { 'x-studio-control': st.state.controlToken } });
  opened.push(() => st.close());
  return { st, page, agent, close: () => st.close() };
}
function fakeService(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((q, res) => {
      seen.push({ method: q.method, url: q.url, headers: q.headers });
      if (handler) return handler(q, res);
      res.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/orders/1042')) return res.end('{"id":1042,"status":"open"}');
      res.writeHead(404); res.end('{"message":"Order not found"}');
    });
    opened.push(() => { srv.close(); srv.closeAllConnections(); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}
const SUITE_REL = 'integration/api_test_suites/orders/orders_suite.json';
const editorProject = port => proj({
  '.gitignore': '.agentex/\ntest/.auth/\n',
  'config/project.json': { defaultEnvironment: 'qc' },
  'environments/qc.json': { portalUrl: 'https://app.example.test', users: { qa_user_a: { email: 'qa_user_a@example.test' } } },
  'integration/api_test_suites/orders/orders_api.json': { name: 'orders', target: 'catalog', baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' },
    requests: [{ name: 'get-order', method: 'GET', path: '/orders/{orderId}', params: ['orderId'] }, { name: 'list-orders', method: 'GET', path: '/orders', params: ['status'], query: ['status'] }] },
  [SUITE_REL]: { name: 'orders-suite', cases: [
    { name: 'get-happy', entry: 'orders.get-order', kind: 'happy', params: { orderId: 1042 }, sources: { orderId: 'ui' }, expect: { status: 200, fields: ['id'] } },
    { name: 'get-not-found', entry: 'orders.get-order', kind: 'not-found', params: { orderId: 999999999 }, sources: { orderId: 'auto' }, expect: { status: 404, equals: { message: 'Order not found' } } },
    { name: 'list-happy', entry: 'orders.list-orders', params: { status: 'example' }, sources: { status: 'placeholder' }, expect: { status: 200 } },
    { name: 'create-happy', entry: 'orders.list-orders', skip: 'review: write operation — remove this line to enable', params: { status: 'x' }, expect: { status: 201 } },
  ] },
});
async function waitRun(page, id) {
  for (let i = 0; i < 100; i++) {
    const r = await page('GET', `/api/run/${id}`);
    if (r.json.status === 'done') return r.json;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('run did not finish');
}


module.exports = { assert, fs, http, os, path, harness, proj, treeOf, req, studio, fakeService, waitRun, editorProject, SUITE_REL, sessionFile, wizardMount };
