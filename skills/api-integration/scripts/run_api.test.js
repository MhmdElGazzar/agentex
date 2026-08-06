'use strict';
// Tests for run_api.js environment resolution, against a local HTTP server.
// Run: node skills/api-integration/scripts/run_api.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run_api.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-runapi-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const CATALOG = {
  name: 'sample-api',
  baseUrl: '${API_BASE_URL}',
  auth: { type: 'none' },
  requests: [{ name: 'get-thing', method: 'GET', path: '/thing', params: [] }],
};
function run(cwd, args, extraEnv = {}) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.API_BASE_URL; delete env.API_TOKEN;
    Object.assign(env, extraEnv);
    const p = spawn(process.execPath, [RUNNER, ...args], { cwd, env });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
      resolve({ code, out: JSON.parse(line) });
    });
  });
}
function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  await test('environment api.baseUrl overrides catalog ${API_BASE_URL}', async () => {
    let hit = null;
    const { srv, port } = await serve((req, res) => { hit = req.url; res.end('{"ok":true}'); });
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}` } },
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--expect-status', '200', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(hit, '/thing');
  });

  await test('environment api.token envSecret becomes the bearer header', async () => {
    let auth = null;
    const { srv, port } = await serve((req, res) => { auth = req.headers.authorization; res.end('{}'); });
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}`, token: { envSecret: 'QA_TOKEN' } } },
      '.env': 'QA_TOKEN=tok-123\n',
    });
    const { code } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0);
    assert.strictEqual(auth, 'Bearer tok-123');
  });

  await test('api.token declared but unresolvable -> BLOCKED naming the var', async () => {
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: 'http://127.0.0.1:9', token: { envSecret: 'NOPE_TOKEN' } } },
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /NOPE_TOKEN/);
  });

  await test('legacy path still works: catalog ${API_BASE_URL} from process env', async () => {
    const { srv, port } = await serve((req, res) => res.end('{}'));
    const dir = proj({ 'integration/sample_api.json': CATALOG });
    const { code } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')],
      { API_BASE_URL: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
