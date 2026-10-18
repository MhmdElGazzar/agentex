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

  await test('legacy path reads .env: catalog ${API_BASE_URL} + bearer tokenEnv with nothing exported', async () => {
    let auth = null;
    const { srv, port } = await serve((req, res) => { auth = req.headers.authorization; res.end('{}'); });
    const dir = proj({
      'integration/sample_api.json': { ...CATALOG, auth: { type: 'bearer', tokenEnv: 'API_TOKEN' } },
      '.env': `API_BASE_URL=http://127.0.0.1:${port}\nAPI_TOKEN="tok-from-dotenv"\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(auth, 'Bearer tok-from-dotenv');
  });

  await test('legacy basic auth reads userEnv/passEnv from .env', async () => {
    let auth = null;
    const { srv, port } = await serve((req, res) => { auth = req.headers.authorization; res.end('{}'); });
    const dir = proj({
      'integration/sample_api.json': { ...CATALOG, auth: { type: 'basic', userEnv: 'API_USER_T', passEnv: 'API_PASS_T' } },
      '.env': `API_BASE_URL=http://127.0.0.1:${port}\nAPI_USER_T=qa\nAPI_PASS_T=pw\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(auth, 'Basic ' + Buffer.from('qa:pw').toString('base64'));
  });

  await test('legacy bearer token missing from both process env and .env -> BLOCKED naming the var', async () => {
    const dir = proj({
      'integration/sample_api.json': { ...CATALOG, auth: { type: 'bearer', tokenEnv: 'API_TOKEN' } },
      '.env': 'API_BASE_URL=http://127.0.0.1:9\n',
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /API_TOKEN/);
    assert.match(out.reason, /\.env/);
  });

  await test('apiKey auth reads tokenEnv from .env and sends it in the declared header', async () => {
    let hdr = null;
    const { srv, port } = await serve((req, res) => { hdr = req.headers['x-api-key']; res.end('{}'); });
    const dir = proj({
      'integration/sample_api.json': { ...CATALOG, auth: { type: 'apiKey', tokenEnv: 'API_KEY_T', headerName: 'X-API-Key' } },
      '.env': `API_BASE_URL=http://127.0.0.1:${port}\nAPI_KEY_T=key-from-dotenv\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(hdr, 'key-from-dotenv');
  });

  await test('apiKey missing from both process env and .env -> BLOCKED naming the var', async () => {
    const dir = proj({
      'integration/sample_api.json': { ...CATALOG, auth: { type: 'apiKey', tokenEnv: 'API_KEY_T', headerName: 'X-API-Key' } },
      '.env': 'API_BASE_URL=http://127.0.0.1:9\n',
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /API_KEY_T/);
  });

  await test('declared params not in the path are sent as query string; nested catalogs are found', async () => {
    let url = null;
    const { srv, port } = await serve((req, res) => { url = req.url; res.end('{}'); });
    const cat = { ...CATALOG, baseUrl: `http://127.0.0.1:${port}`,
      requests: [{ name: 'find', method: 'GET', path: '/pets/{id}', params: ['id', 'status'] }] };
    const dir = proj({ 'integration/api_test_suites/pets/pets_api.json': cat });
    const { code, out } = await run(dir, ['--entry', 'sample-api.find', '--param', 'id=7', '--param', 'status=sold', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(url, '/pets/7?status=sold');
  });

  // ---- catalog "target": "catalog" — an imported service keeps its own base URL and auth ----
  // The environment's api block points at a second server that must never be hit.
  const SVC = { name: 'svc', target: 'catalog', baseUrl: '${SVC_BASE_URL_T}',
    requests: [{ name: 'get-thing', method: 'GET', path: '/thing', params: [] }] };
  function envSide() {
    const seen = { hits: 0 };
    return serve((req, res) => { seen.hits++; res.end('{}'); }).then(s => ({ ...s, seen }));
  }
  function catalogSide() {
    const seen = { url: null, headers: null };
    return serve((req, res) => { seen.url = req.url; seen.headers = req.headers; res.end('{}'); }).then(s => ({ ...s, seen }));
  }
  const envFiles = (envPort, token = { envSecret: 'QA_TOKEN_T' }) => ({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${envPort}`, token } },
  });

  await test('target "catalog" + environment api block -> catalog baseUrl and apiKey header, no Bearer', async () => {
    const env = await envSide(), cat = await catalogSide();
    const dir = proj({
      ...envFiles(env.port),
      'integration/api_test_suites/svc/svc_api.json': { ...SVC, auth: { type: 'apiKey', headerName: 'X-API-Key', tokenEnv: 'SVC_KEY_T' } },
      '.env': `QA_TOKEN_T=env-tok\nSVC_BASE_URL_T=http://127.0.0.1:${cat.port}\nSVC_KEY_T=svc-key\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--expect-status', '200', '--log', path.join(dir, 'x.log')]);
    env.srv.close(); cat.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(env.seen.hits, 0, 'the environment api host was called');
    assert.strictEqual(cat.seen.url, '/thing');
    assert.strictEqual(cat.seen.headers['x-api-key'], 'svc-key');
    assert.strictEqual(cat.seen.headers.authorization, undefined);
  });

  await test('target "catalog" + environment api block -> catalog bearer and basic auth, not the environment token', async () => {
    const cases = [
      [{ type: 'bearer', tokenEnv: 'SVC_TOK_T' }, 'SVC_TOK_T=svc-tok\n', 'Bearer svc-tok'],
      [{ type: 'basic', userEnv: 'SVC_USER_T', passEnv: 'SVC_PASS_T' }, 'SVC_USER_T=qa\nSVC_PASS_T=pw\n', 'Basic ' + Buffer.from('qa:pw').toString('base64')],
    ];
    for (const [auth, envLines, expected] of cases) {
      const env = await envSide(), cat = await catalogSide();
      const dir = proj({
        ...envFiles(env.port),
        'integration/svc_api.json': { ...SVC, auth },
        '.env': `QA_TOKEN_T=env-tok\nSVC_BASE_URL_T=http://127.0.0.1:${cat.port}\n${envLines}`,
      });
      const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
      env.srv.close(); cat.srv.close();
      assert.strictEqual(code, 0, `${auth.type}: ${JSON.stringify(out)}`);
      assert.strictEqual(env.seen.hits, 0, `${auth.type}: the environment api host was called`);
      assert.strictEqual(cat.seen.headers.authorization, expected, auth.type);
    }
  });

  await test('no target, or target "environment" -> unchanged: environment baseUrl + environment Bearer', async () => {
    for (const target of [undefined, 'environment']) {
      const env = { seen: { url: null, headers: null } };
      Object.assign(env, await serve((req, res) => { env.seen.url = req.url; env.seen.headers = req.headers; res.end('{}'); }));
      const cat = await envSide();
      const catalog = { ...SVC, auth: { type: 'apiKey', headerName: 'X-API-Key', tokenEnv: 'SVC_KEY_T' } };
      if (target === undefined) delete catalog.target; else catalog.target = target;
      const dir = proj({
        ...envFiles(env.port),
        'integration/svc_api.json': catalog,
        '.env': `QA_TOKEN_T=env-tok\nSVC_BASE_URL_T=http://127.0.0.1:${cat.port}\nSVC_KEY_T=svc-key\n`,
      });
      const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
      env.srv.close(); cat.srv.close();
      assert.strictEqual(code, 0, `${target}: ${JSON.stringify(out)}`);
      assert.strictEqual(cat.seen.hits, 0, `${target}: the catalog host was called`);
      assert.strictEqual(env.seen.url, '/thing');
      assert.strictEqual(env.seen.headers.authorization, 'Bearer env-tok');
      assert.strictEqual(env.seen.headers['x-api-key'], undefined);
    }
  });

  await test('unknown target value -> BLOCKED exit 2 naming the catalog, the field and the allowed values; zero requests', async () => {
    const env = await envSide();
    const dir = proj({
      ...envFiles(env.port),
      'integration/svc_api.json': { ...SVC, target: 'bogus', baseUrl: `http://127.0.0.1:${env.port}`, auth: { type: 'none' } },
      '.env': 'QA_TOKEN_T=env-tok\n',
    });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
    env.srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.result, 'BLOCKED');
    assert.match(out.reason, /"svc"/);
    assert.match(out.reason, /"target"/);
    assert.match(out.reason, /bogus/);
    assert.match(out.reason, /"environment"/);
    assert.match(out.reason, /"catalog"/);
    assert.strictEqual(env.seen.hits, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'x.log')), 'an evidence log was written');
  });

  await test('target "catalog" with its base-URL var unset -> BLOCKED naming the var, no fallback to the environment', async () => {
    const env = await envSide();
    const dir = proj({
      ...envFiles(env.port),
      'integration/svc_api.json': { ...SVC, auth: { type: 'none' } },
      '.env': 'QA_TOKEN_T=env-tok\n',
    });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
    env.srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.match(out.reason, /SVC_BASE_URL_T/);
    assert.strictEqual(env.seen.hits, 0);
  });

  await test('target "catalog" ignores an environment token that is declared but unset', async () => {
    const env = await envSide(), cat = await catalogSide();
    const dir = proj({
      ...envFiles(env.port, { envSecret: 'NOPE_TOKEN_T' }),
      'integration/svc_api.json': { ...SVC, auth: { type: 'none' } },
      '.env': `SVC_BASE_URL_T=http://127.0.0.1:${cat.port}\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
    env.srv.close(); cat.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(cat.seen.url, '/thing');
  });

  await test('target "catalog" with an unknown --env -> still BLOCKED listing the environments (no silent fallback)', async () => {
    const dir = proj({
      ...envFiles(9),
      'integration/svc_api.json': { ...SVC, auth: { type: 'none' } },
      '.env': 'SVC_BASE_URL_T=http://127.0.0.1:9\n',
    });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--env', 'nope', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.match(out.reason, /environment "nope" not found/);
    assert.match(out.reason, /qa/);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
