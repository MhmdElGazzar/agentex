'use strict';
// Tests for browser_bridge.js — capture / fill-secret / token-status, against a fake
// playwright-cli (golden/fake_playwright_cli.js, via AGENTEX_PLAYWRIGHT_CLI).
// Run: node skills/swagger-import/scripts/browser_bridge.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bridge-tmp-'));
const B = require('./browser_bridge.js');
const BRIDGE = path.join(__dirname, 'browser_bridge.js');
const SHIM = path.join(__dirname, 'golden', 'fake_playwright_cli.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack.split('\n').slice(0, 2).join(' | ')}`); }
}
const TOKEN = 'EVAL_SENTINEL_TOKEN_bridge_93c';
const PASSWORD = 'EVAL_SENTINEL_PASSWORD_bridge_17';
function proj(files, ignore = '.agentex/\ntest/.auth/\n') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bridge-')));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  return dir;
}
const CALLS = [
  { method: 'GET', url: 'https://api.example.test/v1/orders?page=1&session_id=abc123', status: 200,
    headers: { authorization: `Bearer ${TOKEN}`, cookie: 'sid=cookie-value-1', accept: 'application/json' },
    response: JSON.stringify({ items: [{ orderId: 1042, status: 'open', owner: { refreshToken: 'r-tok-1', note: `see ${TOKEN}` } }], jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2lnbmF0dXJl' }) },
  { method: 'POST', url: 'https://api.example.test/v1/orders/search', status: 200, headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ status: 'open', password: 'nope' }), response: '[]' },
];
function bridge(dir, args, env = {}) {
  return new Promise(resolve => {
    const log = path.join(dir, '..', `${path.basename(dir)}-shim.log`);
    const calls = path.join(dir, '..', `${path.basename(dir)}-calls.json`);
    fs.writeFileSync(calls, JSON.stringify(CALLS));
    const p = spawn(process.execPath, [BRIDGE, ...args, '--project', dir], { env: { ...process.env, AGENTEX_PLAYWRIGHT_CLI: SHIM, SHIM_LOG: log, SHIM_CALLS: calls, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
      resolve({ code, json, out, err, argv: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' });
    });
  });
}
const CAPTURE = ['capture', '--session', 'agentex-collect', '--api-origin', 'https://api.example.test', '--goto', 'https://app.example.test/orders', '--wait-ms', '10'];

(async () => {
  await test('redaction: secret headers dropped, secret-named keys, JWT-shaped strings and the exact token value', async () => {
    const r = B.redactCalls(CALLS, { secrets: [TOKEN] });
    const text = JSON.stringify(r);
    assert.ok(!text.includes(TOKEN) && !text.includes('cookie-value-1') && !text.includes('r-tok-1') && !text.includes('eyJhbGci') && !text.includes('abc123') && !text.includes('"nope"'));
    assert.ok(!('headers' in r[0]));
    assert.strictEqual(r[0].responseBody.items[0].orderId, 1042);
    assert.strictEqual(r[0].responseBody.items[0].owner.note, 'see [redacted]');
    assert.strictEqual(r[1].requestBody.status, 'open');
  });

  await test('single-use loopback handle: 127.0.0.1, random path, second GET 404, wrong path 404', async () => {
    const h = await B.serveOnce(PASSWORD);
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    assert.strictEqual(h.srv.address().address, '127.0.0.1');
    const get = u => new Promise(res => http.get(u, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }));
    const wrong = await get(h.url.replace(/\/[0-9a-f]+$/, '/nope'));
    const first = await get(h.url);
    const second = await get(h.url);
    h.close();
    assert.deepStrictEqual([wrong.status, first.status, first.body, second.status], [404, 200, PASSWORD, 404]);
  });

  await test('capture --store: the token is written 0600 with schemaVersion; stdout and the composed run-code never contain it', async () => {
    const dir = proj({});
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.deepStrictEqual(r.json.token, { seen: true, scheme: 'bearer', delivered: 'store', ref: 'orders-qc' });
    assert.strictEqual(r.json.callCount, 2);
    const f = path.join(dir, 'test/.auth/api-tokens/orders-qc.json');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepStrictEqual([rec.schemaVersion, rec.token, rec.user, rec.scheme], [1, TOKEN, 'qa_user_a', 'bearer']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), 'stdout/stderr leak the token');
    assert.ok(!r.argv.includes(TOKEN), 'the composed command line carries the token');
    assert.match(r.argv, /run-code/);
    assert.match(r.argv, /page\.request\.post\(sink/);
  });

  await test('capture --store refuses when test/.auth/ is not gitignored; the browser is never driven', async () => {
    const dir = proj({}, 'node_modules/\n');
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.error, 'not-ignored');
    assert.strictEqual(r.argv, '');
    assert.ok(!fs.existsSync(path.join(dir, 'test')));
  });

  await test('capture --to-studio hands the token to the open studio over loopback; nothing printed', async () => {
    const { createStudio } = require('../../endpoint-testing/scripts/studio/server.js');
    const dir = proj({ 'environments/qc.json': { users: {} } });
    const st = await createStudio({ root: dir, port: 0, mode: 'wizard', mount: require('../../endpoint-testing/scripts/studio/wizard.js').mount, log: () => {} });
    try {
      const r = await bridge(dir, [...CAPTURE, '--to-studio']);
      assert.strictEqual(r.code, 0, r.out);
      assert.deepStrictEqual(r.json.token, { seen: true, scheme: 'bearer', delivered: 'studio' });
      assert.ok(!r.out.includes(TOKEN) && !r.argv.includes(TOKEN));
      assert.strictEqual(st.studio.wizard().token.value, TOKEN);
      assert.strictEqual(st.studio.wizard().token.apiOrigin, 'https://api.example.test');
    } finally { st.close(); }
  });

  await test('capture: a failing browser step is reported, not hidden', async () => {
    const dir = proj({});
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a'], { SHIM_FAIL: '1' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.error, 'browser-failed');
  });

  await test('fill-secret: the password is served once over loopback, never on the command line or in the output', async () => {
    const dir = proj({ 'environments/qc.json': { defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { qa_user_a: { email: 'qa_user_a@example.test' } } }, '.env': `QA_PASSWORD=${PASSWORD}\n` });
    const filled = path.join(dir, '..', `${path.basename(dir)}-filled.json`);
    const second = path.join(dir, '..', `${path.basename(dir)}-second.txt`);
    const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FILLED: filled, SHIM_SECOND_GET: second });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.json, { ok: true, filled: true, submitted: true, user: 'qa_user_a' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filled, 'utf8')), { status: 200, value: PASSWORD });
    assert.strictEqual(fs.readFileSync(second, 'utf8'), '404');
    assert.ok(!r.out.includes(PASSWORD) && !r.err.includes(PASSWORD) && !r.argv.includes(PASSWORD));
    assert.match(r.argv, /button\[type=submit\]/);
  });

  await test('fill-secret: an unknown user or no password -> refused without touching the browser', async () => {
    const dir = proj({ 'environments/qc.json': { users: { qa_user_a: {} } } });
    const r = await bridge(dir, ['fill-secret', '--session', 's', '--locator', '#p', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.json.error, 'no-password');
    const u = await bridge(dir, ['fill-secret', '--session', 's', '--locator', '#p', '--env', 'qc', '--user', 'qa_user_b']);
    assert.match(u.json.message, /qa_user_b/);
    assert.strictEqual(r.argv + u.argv, '');
  });

  await test('token-status: owner and times only', async () => {
    const dir = proj({});
    await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    const r = await bridge(dir, ['token-status', '--store', 'orders', '--env', 'qc']);
    assert.strictEqual(r.json.present, true);
    assert.strictEqual(r.json.user, 'qa_user_a');
    assert.ok(!r.out.includes(TOKEN));
    const none = await bridge(dir, ['token-status', '--store', 'orders', '--env', 'uat']);
    assert.strictEqual(none.json.present, false);
  });

  await test('the composed run-code is one line and holds only loopback URLs and locators', async () => {
    const code = B.captureCode({ apiOrigin: 'https://api.example.test', sinkUrl: 'http://127.0.0.1:1/abc', goto: 'https://app.example.test/x', waitMs: 10 });
    assert.ok(!code.includes('\n'));
    assert.ok(!B.fillCode({ handleUrl: 'http://127.0.0.1:1/abc', locator: '#p' }).includes('\n'));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
