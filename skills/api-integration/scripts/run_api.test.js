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

  // ---- the combined target rule: an explicit "target" wins; no target -> the environment's api
  // block only for a catalog whose baseUrl is absent/empty or exactly "${API_BASE_URL}" ----
  const RULE = [
    // [target, the catalog's baseUrl variable, who answers]
    [undefined, 'API_BASE_URL', 'environment'],
    [undefined, 'SVC_BASE_URL_T', 'catalog'],
    ['environment', 'SVC_BASE_URL_T', 'environment'],
    ['catalog', 'API_BASE_URL', 'catalog'],
  ];
  for (const [target, baseVar, side] of RULE) {
    const label = `target ${target === undefined ? '(none)' : `"${target}"`} + \${${baseVar}} -> ${side} baseUrl and auth`;
    await test(label, async () => {
      const env = await catalogSide(), cat = await catalogSide();
      const catalog = { name: 'svc', baseUrl: `\${${baseVar}}`, auth: { type: 'apiKey', headerName: 'X-API-Key', tokenEnv: 'SVC_KEY_T' },
        requests: SVC.requests };
      if (target !== undefined) catalog.target = target;
      const dir = proj({
        ...envFiles(env.port),
        'integration/svc_api.json': catalog,
        '.env': `QA_TOKEN_T=env-tok\n${baseVar}=http://127.0.0.1:${cat.port}\nSVC_KEY_T=svc-key\n`,
      });
      const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
      env.srv.close(); cat.srv.close();
      assert.strictEqual(code, 0, JSON.stringify(out));
      const [hit, missed] = side === 'environment' ? [env, cat] : [cat, env];
      assert.strictEqual(missed.seen.url, null, `the ${side === 'environment' ? 'catalog' : 'environment'} host was called`);
      assert.strictEqual(hit.seen.url, '/thing');
      if (side === 'environment') {
        assert.strictEqual(hit.seen.headers.authorization, 'Bearer env-tok');
        assert.strictEqual(hit.seen.headers['x-api-key'], undefined);
      } else {
        assert.strictEqual(hit.seen.headers['x-api-key'], 'svc-key');
        assert.strictEqual(hit.seen.headers.authorization, undefined, 'the environment token was sent to the catalog host');
      }
    });
  }

  await test('unknown --env -> BLOCKED listing the environments, whatever the target or baseUrl; zero requests', async () => {
    for (const [target, baseVar] of RULE) {
      const env = await envSide(), cat = await envSide();
      const catalog = { name: 'svc', baseUrl: `\${${baseVar}}`, auth: { type: 'none' }, requests: SVC.requests };
      if (target !== undefined) catalog.target = target;
      const dir = proj({
        ...envFiles(env.port),
        'integration/svc_api.json': catalog,
        '.env': `QA_TOKEN_T=env-tok\n${baseVar}=http://127.0.0.1:${cat.port}\n`,
      });
      const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--env', 'nope', '--log', path.join(dir, 'x.log')]);
      env.srv.close(); cat.srv.close();
      const label = `${target} + ${baseVar}`;
      assert.strictEqual(code, 2, `${label}: ${JSON.stringify(out)}`);
      assert.match(out.reason, /environment "nope" not found/, label);
      assert.strictEqual(env.seen.hits + cat.seen.hits, 0, label);
    }
  });

  await test('no target + an unset non-default base-URL var -> BLOCKED naming the var, no fallback to the environment', async () => {
    const env = await envSide();
    const catalog = { name: 'svc', baseUrl: '${SVC_BASE_URL_T}', auth: { type: 'none' }, requests: SVC.requests };
    const dir = proj({ ...envFiles(env.port), 'integration/svc_api.json': catalog, '.env': 'QA_TOKEN_T=env-tok\n' });
    const { code, out } = await run(dir, ['--entry', 'svc.get-thing', '--log', path.join(dir, 'x.log')]);
    env.srv.close();
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.match(out.reason, /SVC_BASE_URL_T/);
    assert.strictEqual(env.seen.hits, 0);
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

  await test('POST param used only in the body is NOT sent as a query param (pre-#25 behavior)', async () => {
    let url = null, body = '';
    const { srv, port } = await serve((req, res) => { url = req.url; req.on('data', d => (body += d)); req.on('end', () => res.end('{}')); });
    const cat = { ...CATALOG, baseUrl: `http://127.0.0.1:${port}`,
      requests: [{ name: 'create-todo', method: 'POST', path: '/todos', params: ['title'], body: { title: '{title}', completed: false } }] };
    const dir = proj({ 'integration/sample_api.json': cat });
    const { code, out } = await run(dir, ['--entry', 'sample-api.create-todo', '--param', 'title=Buy milk & eggs', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(url, '/todos');
    assert.strictEqual(JSON.parse(body).title, 'Buy milk & eggs');
  });

  await test('legacy {name} body placeholder: backslash, newline, tab, quote, U+2028, emoji arrive byte-for-byte', async () => {
    const values = ['C:\\new\\test', 'line1\nline2', 'a\tb', 'ends with \\', 'say "hi"', 'a\u2028b', 'smile \u{1F600}', 'Buy milk & eggs'];
    for (const value of values) {
      let body = '';
      const { srv, port } = await serve((req, res) => { req.on('data', d => (body += d)); req.on('end', () => res.end('{}')); });
      const cat = { ...CATALOG, baseUrl: `http://127.0.0.1:${port}`,
        requests: [{ name: 'create-todo', method: 'POST', path: '/todos', params: ['title'], body: { title: 'x {title} y', completed: false } }] };
      const dir = proj({ 'integration/sample_api.json': cat });
      const { code, out } = await run(dir, ['--entry', 'sample-api.create-todo', '--param', `title=${value}`, '--log', path.join(dir, 'x.log')]);
      srv.close();
      assert.strictEqual(code, 0, JSON.stringify(value) + ' ' + JSON.stringify(out));
      assert.strictEqual(JSON.parse(body).title, `x ${value} y`, JSON.stringify(value));
    }
  });

  await test('params listed in req.query go to the query string, even when also used in the body', async () => {
    let url = null;
    const { srv, port } = await serve((req, res) => { url = req.url; res.end('{}'); });
    const cat = { ...CATALOG, baseUrl: `http://127.0.0.1:${port}`,
      requests: [{ name: 'tag', method: 'POST', path: '/pets/{id}', params: ['id', 'dryRun', 'name'], query: ['dryRun'],
        body: { name: '{name}', dry: '{dryRun}' } }] };
    const dir = proj({ 'integration/sample_api.json': cat });
    const { code, out } = await run(dir, ['--entry', 'sample-api.tag', '--param', 'id=3', '--param', 'dryRun=true', '--param', 'name=rex', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(url, '/pets/3?dryRun=true');
  });

  await test('req.query naming an undeclared param -> BLOCKED', async () => {
    const cat = { ...CATALOG, baseUrl: 'http://127.0.0.1:9',
      requests: [{ name: 'list', method: 'GET', path: '/pets', params: [], query: ['status'] }] };
    const dir = proj({ 'integration/sample_api.json': cat });
    const { code, out } = await run(dir, ['--entry', 'sample-api.list', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /status/);
  });

  await test('catalog with its own baseUrl ignores the environment api block and token', async () => {
    let envHit = false, hit = null;
    const envSrv = await serve((req, res) => { envHit = true; res.end('{}'); });
    const own = await serve((req, res) => { hit = { url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'] }; res.end('{}'); });
    const dir = proj({
      'integration/api_test_suites/pets/pets_api.json': { name: 'petstore', baseUrl: '${PETSTORE_BASE_URL}',
        auth: { type: 'apiKey', headerName: 'X-API-Key', tokenEnv: 'PETSTORE_TOKEN' },
        requests: [{ name: 'inv', method: 'GET', path: '/inv', params: [] }] },
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${envSrv.port}`, token: { envSecret: 'QA_TOKEN' } } },
      '.env': `QA_TOKEN=app-secret\nPETSTORE_BASE_URL=http://127.0.0.1:${own.port}\nPETSTORE_TOKEN=pet-key\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'petstore.inv', '--log', path.join(dir, 'x.log')]);
    envSrv.srv.close(); own.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(envHit, false, 'environment api host must not be called');
    assert.strictEqual(hit.url, '/inv');
    assert.strictEqual(hit.key, 'pet-key');
    assert.strictEqual(hit.auth, undefined, 'environment bearer token must not be sent');
  });

  await test('catalog with no baseUrl uses the environment api block', async () => {
    let auth = null;
    const { srv, port } = await serve((req, res) => { auth = req.headers.authorization; res.end('{}'); });
    const { baseUrl, ...noBase } = CATALOG;
    const dir = proj({
      'integration/sample_api.json': noBase,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}`, token: { envSecret: 'QA_TOKEN' } } },
      '.env': 'QA_TOKEN=tok-9\n',
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(auth, 'Bearer tok-9');
  });

  await test('catalog with its own baseUrl does not need the environment token to be set', async () => {
    const own = await serve((req, res) => res.end('{}'));
    const dir = proj({
      'integration/other_api.json': { name: 'other', baseUrl: `http://127.0.0.1:${own.port}`, auth: { type: 'none' },
        requests: [{ name: 'ping', method: 'GET', path: '/ping', params: [] }] },
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: 'http://127.0.0.1:9', token: { envSecret: 'NOPE_TOKEN' } } },
    });
    const { code, out } = await run(dir, ['--entry', 'other.ping', '--log', path.join(dir, 'x.log')]);
    own.srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
  });

  await test('two catalogs with the same "name" -> BLOCKED listing both files', async () => {
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'integration/api_test_suites/sample/sample_api.json': CATALOG,
      '.env': 'API_BASE_URL=http://127.0.0.1:9\n',
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.match(out.reason, /integration[\\/]sample_api\.json/);
    assert.match(out.reason, /api_test_suites[\\/]sample[\\/]sample_api\.json/);
  });

  await test('catalog walk skips node_modules and dot-directories', async () => {
    const { srv, port } = await serve((req, res) => res.end('{}'));
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'integration/node_modules/pkg/sample_api.json': CATALOG,
      'integration/.cache/sample_api.json': '{not json',
      '.env': `API_BASE_URL=http://127.0.0.1:${port}\n`,
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
  });

  // ---- swagger-suite-wizard runner gaps: --no-auth, --expect-contains, --omit, $param, tokenStore,
  // credential redaction, ms ----
  function runRaw(cwd, args, extraEnv = {}) {
    return new Promise(resolve => {
      const env = { ...process.env };
      delete env.API_BASE_URL; delete env.API_TOKEN;
      Object.assign(env, extraEnv);
      const p = spawn(process.execPath, [RUNNER, ...args], { cwd, env });
      let out = '', err = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (err += d));
      p.on('close', code => {
        const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
        resolve({ code, out: JSON.parse(line), raw: out + err });
      });
    });
  }
  const svc = (port, extra = {}) => ({
    name: 'orders', target: 'catalog', baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' },
    requests: [
      { name: 'get-order', method: 'GET', path: '/orders/{orderId}', params: ['orderId', 'status'], query: ['status'] },
      { name: 'list-orders', method: 'GET', path: '/orders', params: ['status', 'page'], query: ['status', 'page'] },
      { name: 'create-order', method: 'POST', path: '/orders', params: ['qty', 'price', 'rush', 'note', 'meta', 'tag'],
        body: { qty: { $param: 'qty', type: 'integer' }, price: { $param: 'price', type: 'number' }, rush: { $param: 'rush', type: 'boolean' },
          note: { $param: 'note', type: 'string' }, meta: { $param: 'meta', type: 'json' }, tags: ['fixed', { $param: 'tag', type: 'string' }] } },
      { name: 'legacy-create', method: 'POST', path: '/orders', params: ['title'], body: { title: '{title}' } },
    ],
    ...extra,
  });
  function recorder(respond) {
    const seen = [];
    return serve((req, res) => {
      let b = '';
      req.on('data', d => (b += d));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: b });
        if (respond) respond(req, res, b); else { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"message":"Order status is invalid"}'); }
      });
    }).then(s => ({ ...s, seen }));
  }
  const log = dir => path.join(dir, 'x.log');
  const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = exp => `${b64url({ alg: 'none' })}.${b64url({ sub: 'qa_user_a', exp })}.sig`;

  await test('no-auth drops the environment Bearer token', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}`, token: { envSecret: 'QA_TOKEN' } } },
      '.env': 'QA_TOKEN=tok-123\n',
    });
    const { code, out } = await run(dir, ['--entry', 'sample-api.get-thing', '--no-auth', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(seen[0].headers.authorization, undefined);
  });

  for (const [label, auth, env] of [
    ['bearer', { type: 'bearer', tokenEnv: 'ORD_TOKEN' }, 'ORD_TOKEN=t-1\n'],
    ['basic', { type: 'basic', userEnv: 'ORD_USER', passEnv: 'ORD_PASS' }, 'ORD_USER=u\nORD_PASS=p\n'],
    ['apiKey', { type: 'apiKey', tokenEnv: 'ORD_TOKEN', headerName: 'X-API-Key' }, 'ORD_TOKEN=k-1\n'],
  ]) {
    await test(`no-auth drops the catalog ${label} credential`, async () => {
      const { srv, port, seen } = await recorder();
      const dir = proj({ 'integration/orders_api.json': svc(port, { auth }), '.env': env });
      const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--no-auth', '--log', log(dir)]);
      srv.close();
      assert.strictEqual(code, 0, JSON.stringify(out));
      assert.strictEqual(seen[0].headers.authorization, undefined);
      assert.strictEqual(seen[0].headers['x-api-key'], undefined);
    });
  }

  await test('no-auth does not BLOCK on an unset token var', async () => {
    const { srv, port, seen } = await recorder((req, res) => { res.writeHead(401); res.end('{"message":"token required"}'); });
    const dir = proj({ 'integration/orders_api.json': svc(port, { auth: { type: 'bearer', tokenEnv: 'NEVER_SET_TOKEN' } }) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--no-auth', '--expect-status', '401', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(seen.length, 1);
  });

  await test('expect-contains passes when the message includes the text', async () => {
    const { srv, port } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--expect-contains', 'message=status', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
  });

  await test('expect-contains fails when the text is absent', async () => {
    const { srv, port } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--expect-contains', 'message=quantity', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 1, JSON.stringify(out));
    assert.match(out.failures.join(' '), /message/);
  });

  await test('expect-contains on a non-JSON body -> FAIL', async () => {
    const { srv, port } = await recorder((req, res) => res.end('plain text status'));
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--expect-contains', 'message=status', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 1, JSON.stringify(out));
    assert.match(out.failures.join(' '), /not valid JSON/);
  });

  await test('omit: an omitted query param is absent from the URL', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'page=1', '--omit', 'status', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(seen[0].url, '/orders?page=1');
  });

  await test('omit: a path param -> BLOCKED', async () => {
    const dir = proj({ 'integration/orders_api.json': svc(9) });
    const { code, out } = await run(dir, ['--entry', 'orders.get-order', '--param', 'status=open', '--omit', 'orderId', '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reason, 'cannot omit "orderId": it is a path parameter');
  });

  await test('omit: an undeclared param -> BLOCKED', async () => {
    const dir = proj({ 'integration/orders_api.json': svc(9) });
    const { code, out } = await run(dir, ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1', '--omit', 'nope', '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /"nope" is not declared/);
  });

  await test('omit: a param used in a legacy body string template -> BLOCKED', async () => {
    const dir = proj({ 'integration/orders_api.json': svc(9) });
    const { code, out } = await run(dir, ['--entry', 'orders.legacy-create', '--omit', 'title', '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reason, 'cannot omit "title": it is used inside a body string template');
  });

  const createArgs = ['--entry', 'orders.create-order', '--param', 'qty=3', '--param', 'price=9.5', '--param', 'rush=true',
    '--param', 'note=hello "x"', '--param', 'meta={"a":[1,2]}', '--param', 'tag=t1'];

  await test('$param nodes are coerced to integer / number / boolean / string / json', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code, out } = await run(dir, [...createArgs, '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(JSON.parse(seen[0].body), { qty: 3, price: 9.5, rush: true, note: 'hello "x"', meta: { a: [1, 2] }, tags: ['fixed', 't1'] });
  });

  await test('$param: a bad integer -> BLOCKED naming the value and the type', async () => {
    const dir = proj({ 'integration/orders_api.json': svc(9) });
    const args = createArgs.map(a => (a === 'qty=3' ? 'qty=three' : a));
    const { code, out } = await run(dir, [...args, '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reason, 'param "qty" = "three" is not a valid integer');
  });

  await test('$param: an omitted param removes its key (object) and its element (array)', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const args = createArgs.filter(a => a !== 'qty=3' && a !== 'tag=t1');
    const clean = [];
    for (let i = 0; i < args.length; i++) { if (args[i] === '--param' && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) continue; clean.push(args[i]); }
    const { code, out } = await run(dir, [...clean, '--omit', 'qty', '--omit', 'tag', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    const body = JSON.parse(seen[0].body);
    assert.ok(!('qty' in body));
    assert.deepStrictEqual(body.tags, ['fixed']);
  });

  await test('$param params are never sent in the query string', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const { code } = await run(dir, [...createArgs, '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0);
    assert.strictEqual(seen[0].url, '/orders');
  });

  const storeCat = (port, auth) => svc(port, { auth: { type: 'bearer', tokenEnv: 'ORDERS_TOKEN', tokenStore: 'orders', ...auth } });
  const tokenFile = (env, token, extra = {}) => ({ [`test/.auth/api-tokens/orders-${env}.json`]: { schemaVersion: 1, store: 'orders', environment: env, user: 'qa_user_a', scheme: 'bearer', headerName: 'Authorization', token, capturedAt: '2026-10-22T10:00:00Z', ...extra } });
  const listArgs = ['--entry', 'orders.list-orders', '--param', 'status=open', '--param', 'page=1'];

  await test('tokenStore: a tokenEnv value set in .env wins over the captured file', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': storeCat(port), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {}, '.env': 'ORDERS_TOKEN=from-env\n', ...tokenFile('qc', 'from-file') });
    const { code, out } = await run(dir, [...listArgs, '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(seen[0].headers.authorization, 'Bearer from-env');
  });

  await test('tokenStore: the file for the resolved environment is used', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': storeCat(port), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {}, 'environments/uat.json': {}, ...tokenFile('qc', 'qc-tok'), ...tokenFile('uat', 'uat-tok') });
    const a = await run(dir, [...listArgs, '--log', log(dir)]);
    const b = await run(dir, [...listArgs, '--env', 'uat', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(a.code, 0, JSON.stringify(a.out));
    assert.strictEqual(b.code, 0, JSON.stringify(b.out));
    assert.strictEqual(seen[0].headers.authorization, 'Bearer qc-tok');
    assert.strictEqual(seen[1].headers.authorization, 'Bearer uat-tok');
  });

  await test('tokenStore: a missing token file -> BLOCKED token-missing, zero requests', async () => {
    const { srv, port, seen } = await recorder();
    const dir = proj({ 'integration/orders_api.json': storeCat(port), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {} });
    const { code, out } = await run(dir, [...listArgs, '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reasonCode, 'token-missing');
    assert.strictEqual(out.reason, 'no token for orders on "qc": set ORDERS_TOKEN in .env, or ask the agent in chat to capture the token again');
    assert.strictEqual(seen.length, 0);
  });

  await test('tokenStore: an expired JWT -> BLOCKED token-expired, the token never printed', async () => {
    const { srv, port, seen } = await recorder();
    const tok = jwt(Math.floor(Date.now() / 1000) - 60);
    const dir = proj({ 'integration/orders_api.json': storeCat(port), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {}, ...tokenFile('qc', tok) });
    const { code, out, raw } = await runRaw(dir, [...listArgs, '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reasonCode, 'token-expired');
    assert.match(out.reason, /^captured token for orders on "qc" expired at \d{4}-\d\d-\d\dT.* — ask the agent in chat to capture it again, or set ORDERS_TOKEN in \.env$/);
    assert.ok(!raw.includes(tok) && !raw.includes(tok.split('.')[1]));
    assert.strictEqual(seen.length, 0);
  });

  await test('tokenStore: expiresAt in the past -> BLOCKED token-expired', async () => {
    const dir = proj({ 'integration/orders_api.json': storeCat(9), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {}, ...tokenFile('qc', 'opaque', { expiresAt: '2000-01-01T00:00:00Z' }) });
    const { code, out } = await run(dir, [...listArgs, '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reasonCode, 'token-expired');
  });

  await test('tokenStore on a basic-auth catalog -> BLOCKED bad-auth-field naming the field', async () => {
    const dir = proj({ 'integration/orders_api.json': svc(9, { auth: { type: 'basic', userEnv: 'U', passEnv: 'P', tokenStore: 'orders' } }), '.env': 'U=u\nP=p\n' });
    const { code, out } = await run(dir, [...listArgs, '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reasonCode, 'bad-auth-field');
    assert.match(out.reason, /auth\.tokenStore/);
  });

  await test('tokenStore with no resolvable environment -> BLOCKED', async () => {
    const dir = proj({ 'integration/orders_api.json': storeCat(9) });
    const { code, out } = await run(dir, [...listArgs, '--log', log(dir)]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.reason, 'catalog "orders" uses a captured token, which needs an environment — pass --env or set defaultEnvironment');
  });

  await test('an echoed token is redacted from the log and stdout', async () => {
    const SECRET = 'EVAL_SENTINEL_TOKEN_runapi_7c1';
    const { srv, port } = await recorder((req, res) => { res.setHeader('x-echo', req.headers.authorization || ''); res.end(JSON.stringify({ message: `you sent ${req.headers.authorization}` })); });
    const dir = proj({ 'integration/orders_api.json': storeCat(port), 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': {}, ...tokenFile('qc', SECRET) });
    const { code, out, raw } = await runRaw(dir, [...listArgs, '--expect-equals', 'message=nope', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(code, 1, JSON.stringify(out));
    const logText = fs.readFileSync(log(dir), 'utf8');
    assert.ok(!logText.includes(SECRET), 'log leaks the token');
    assert.ok(!raw.includes(SECRET), 'stdout leaks the token');
    assert.match(logText, /\[redacted\]/);
  });

  await test('ms timing is present on PASS and FAIL', async () => {
    const { srv, port } = await recorder();
    const dir = proj({ 'integration/orders_api.json': svc(port) });
    const a = await run(dir, [...listArgs, '--expect-status', '200', '--log', log(dir)]);
    const b = await run(dir, [...listArgs, '--expect-status', '201', '--log', log(dir)]);
    srv.close();
    assert.strictEqual(typeof a.out.ms, 'number');
    assert.strictEqual(typeof b.out.ms, 'number');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
