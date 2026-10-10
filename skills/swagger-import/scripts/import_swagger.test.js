'use strict';
// Tests for import_swagger.js against local spec fixtures.
// Run: node skills/swagger-import/scripts/import_swagger.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const IMPORTER = path.join(__dirname, 'import_swagger.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-swagger-'));
function run(cwd, args) {
  const p = spawnSync(process.execPath, [IMPORTER, ...args], { cwd, encoding: 'utf8' });
  return { code: p.status, out: JSON.parse(p.stdout.trim().split('\n').pop() || '{}') };
}
const OPENAPI3 = {
  openapi: '3.0.0', info: { title: 'Pet Store' },
  servers: [{ url: 'https://api.example.com/v3' }],
  components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
  security: [{ key: [] }],
  paths: {
    '/pets/{id}': { get: { operationId: 'getPet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
    '/pets': { post: { operationId: 'addPet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 200: { description: 'ok' } } } },
  },
};
OPENAPI3.components.schemas = { Pet: { type: 'object', properties: { name: { type: 'string' }, born: { type: 'string', format: 'date-time' } } } };
const SWAGGER2 = {
  swagger: '2.0', info: { title: 'Legacy' }, host: 'legacy.example.com', basePath: '/api', schemes: ['https'],
  paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'ok' } } } } },
};
const write = (dir, name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const importOne = (spec, name = 'svc') => {
  const dir = tmp(); const f = write(dir, 'spec.json', spec);
  const r = run(dir, [f, '--name', name]);
  const base = path.join(dir, 'integration/api_test_suites', name);
  const read = (suffix) => (fs.existsSync(path.join(base, `${name}_${suffix}.json`)) ? JSON.parse(fs.readFileSync(path.join(base, `${name}_${suffix}.json`), 'utf8')) : null);
  return { ...r, dir, cat: read('api'), suite: read('suite') };
};

test('in: query params are written to the request "query" list; path params are not', () => {
  const { code, out, cat } = importOne({
    openapi: '3.0.0', info: { title: 'Q' }, servers: [{ url: 'https://q.example.com' }],
    paths: { '/pets/{id}': { get: { operationId: 'getPet', parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
    ], responses: { 200: { description: 'ok' } } } },
    '/pets': { post: { operationId: 'addPet', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'ok' } } } } },
  });
  assert.strictEqual(code, 0, JSON.stringify(out));
  const get = cat.requests.find(r => r.name === 'getpet');
  assert.deepStrictEqual(get.query, ['verbose']);
  assert.deepStrictEqual(get.params, ['id', 'verbose']);
  assert.strictEqual(cat.requests.find(r => r.name === 'addpet').query, undefined);
});

test('OpenAPI 3 -> catalog + suite written, apiKey header auth, $ref body resolved', () => {
  const dir = tmp(); const spec = write(dir, 'spec.json', OPENAPI3);
  const { code, out } = run(dir, [spec, '--name', 'petstore']);
  assert.strictEqual(code, 0, JSON.stringify(out));
  const base = path.join(dir, 'integration/api_test_suites');
  const catFile = path.join(base, 'petstore/petstore_api.json');
  assert.ok(fs.existsSync(catFile) && fs.existsSync(path.join(base, 'petstore/petstore_suite.json')));
  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  assert.strictEqual(cat.name, 'petstore');
  assert.strictEqual(cat.auth.type, 'apiKey');
  assert.strictEqual(cat.auth.headerName, 'X-API-Key');
  assert.strictEqual(cat.baseUrl, '${PETSTORE_BASE_URL}');
  assert.strictEqual(out.envVarsToSet.PETSTORE_BASE_URL, 'https://api.example.com/v3');
  const add = cat.requests.find(r => r.name === 'addPet' || /add/i.test(r.name));
  assert.strictEqual(typeof add.body, 'object');
  assert.strictEqual(typeof add.body.name, 'string');
});

test('Swagger 2.0 -> base URL built from schemes + host + basePath, kept out of the catalog', () => {
  const dir = tmp(); const spec = write(dir, 'spec.json', SWAGGER2);
  const { code, out } = run(dir, [spec, '--name', 'legacy']);
  assert.strictEqual(code, 0, JSON.stringify(out));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, 'integration/api_test_suites/legacy/legacy_api.json'), 'utf8'));
  assert.strictEqual(cat.baseUrl, '${LEGACY_BASE_URL}');
  assert.strictEqual(out.envVarsToSet.LEGACY_BASE_URL, 'https://legacy.example.com/api');
});

test('never overwrites an existing import -> BLOCKED, file untouched', () => {
  const dir = tmp(); const spec = write(dir, 'spec.json', SWAGGER2);
  assert.strictEqual(run(dir, [spec, '--name', 'legacy']).code, 0);
  const f = path.join(dir, 'integration/api_test_suites/legacy/legacy_api.json');
  fs.writeFileSync(f, '{"marker":true}');
  const second = run(dir, [spec, '--name', 'legacy']);
  assert.strictEqual(second.code, 2);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"marker":true}');
});

test('non-JSON, unrecognised spec, missing file, no args -> BLOCKED', () => {
  const dir = tmp();
  const yaml = write(dir, 'spec.yaml', 'openapi: 3.0.0\n');
  const r = run(dir, [yaml]); assert.strictEqual(r.code, 2); assert.match(r.out.reason, /JSON/);
  const other = write(dir, 'other.json', { hello: 'world' });
  assert.strictEqual(run(dir, [other]).code, 2);
  assert.strictEqual(run(dir, [path.join(dir, 'nope.json')]).code, 2);
  assert.strictEqual(run(dir, []).code, 2);
});

const WRITE_SKIP = 'review: write operation — remove this line to enable';
const CRUD = {
  openapi: '3.0.0', info: { title: 'Crud' }, servers: [{ url: 'https://c.example.com' }],
  paths: {
    '/pets/{id}': {
      get: { operationId: 'getPet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' }, 404: { description: 'nf' } } },
      delete: { operationId: 'deletePet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 204: { description: 'ok' }, 404: { description: 'nf' } } },
      put: { operationId: 'putPet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } },
    },
    '/pets': { post: { operationId: 'addPet', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'ok' } } },
      patch: { operationId: 'patchPets', responses: { 200: { description: 'ok' } } } },
  },
};

test('every generated write-method case is written disabled with the review skip line; GET cases are not', () => {
  const { code, out, suite } = importOne(CRUD);
  assert.strictEqual(code, 0, JSON.stringify(out));
  for (const c of suite.cases) {
    const isGet = c.entry.endsWith('.getpet');
    if (isGet) assert.strictEqual(c.skip, undefined, c.name);
    else assert.strictEqual(c.skip, WRITE_SKIP, c.name);
  }
  assert.ok(suite.cases.some(c => /deletepet/.test(c.name)));
});

test('review notes are written into the generated request and case objects', () => {
  const { cat, suite } = importOne(CRUD);
  const put = cat.requests.find(r => r.name === 'putpet');
  assert.ok(Array.isArray(put.review) && put.review.some(n => /request body generated/.test(n)), JSON.stringify(put));
  const err = suite.cases.find(c => c.name === 'getpet-error-case');
  assert.ok(Array.isArray(err.review) && err.review.some(n => /placeholder param value/.test(n)), JSON.stringify(err));
});

const spec3 = (extra) => ({ openapi: '3.0.0', info: { title: 'Pet Store' }, servers: [{ url: 'https://p.example.com' }], ...extra });
const getOp = (operationId, more = {}) => ({ get: { operationId, responses: { 200: { description: 'ok' } }, ...more } });

test('duplicate generated request names are de-duplicated with -2, -3 and flagged', () => {
  const { code, out, cat, suite } = importOne(spec3({ paths: {
    '/a': getOp('listThings'), '/b': getOp('listThings'), '/c': getOp('listThings'),
  } }));
  assert.strictEqual(code, 0, JSON.stringify(out));
  assert.deepStrictEqual(cat.requests.map(r => r.name), ['listthings', 'listthings-2', 'listthings-3']);
  assert.ok(cat.requests[1].review.some(n => /duplicate/i.test(n)), JSON.stringify(cat.requests[1]));
  assert.strictEqual(new Set(suite.cases.map(c => c.name)).size, suite.cases.length);
});

test('env-var prefix defaults to the service name, not API', () => {
  const dir = tmp(); const f = write(dir, 'spec.json', spec3({ paths: { '/a': getOp('a') } }));
  const { code, out } = run(dir, [f]);
  assert.strictEqual(code, 0, JSON.stringify(out));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, 'integration/api_test_suites/pet-store/pet-store_api.json'), 'utf8'));
  assert.strictEqual(cat.baseUrl, '${PET_STORE_BASE_URL}');
  assert.ok('PET_STORE_BASE_URL' in out.envVarsToSet);
});

test('auth preference is bearer > apiKey(header) > basic regardless of declaration order', () => {
  const schemes = (o) => importOne(spec3({ components: { securitySchemes: o }, paths: { '/a': getOp('a') } })).cat.auth.type;
  assert.strictEqual(schemes({ b: { type: 'http', scheme: 'basic' }, k: { type: 'apiKey', in: 'header', name: 'X-K' }, t: { type: 'http', scheme: 'bearer' } }), 'bearer');
  assert.strictEqual(schemes({ b: { type: 'http', scheme: 'basic' }, k: { type: 'apiKey', in: 'header', name: 'X-K' } }), 'apiKey');
});

test('apiKey header scheme without a header name is not used and is flagged', () => {
  const { cat, out } = importOne(spec3({ components: { securitySchemes: { k: { type: 'apiKey', in: 'header' } } }, paths: { '/a': getOp('a') } }));
  assert.strictEqual(cat.auth.type, 'none');
  assert.ok(out.review.some(n => /name/.test(n) && /k/.test(n)), JSON.stringify(out.review));
});

test('inferred happy-path param values are flagged in the case; documented examples are not', () => {
  const { suite } = importOne(spec3({ paths: { '/pets/{id}': getOp('getPet', { parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
    { name: 'tag', in: 'query', schema: { type: 'string', example: 'dog' } },
  ] }) } }));
  const happy = suite.cases.find(c => c.name === 'getpet-happy-path');
  assert.ok(happy.review && happy.review.some(n => /"id"/.test(n) && /inferred/.test(n)), JSON.stringify(happy));
  assert.ok(!happy.review.some(n => /"tag"/.test(n)), JSON.stringify(happy));
});

test('an invented expect.status 200 (no 2xx documented) is flagged in the case', () => {
  const { suite } = importOne(spec3({ paths: { '/a': { get: { operationId: 'a', responses: { default: { description: 'x' } } } } } }));
  const happy = suite.cases[0];
  assert.strictEqual(happy.expect.status, 200);
  assert.ok(happy.review && happy.review.some(n => /2xx/.test(n)), JSON.stringify(happy));
});

test('a non-JSON request body is dropped and flagged on the request', () => {
  const { cat } = importOne(spec3({ paths: { '/a': { post: { operationId: 'up', requestBody: { content: { 'application/xml': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } } } } }));
  const r = cat.requests[0];
  assert.strictEqual(r.body, undefined);
  assert.ok(r.review && r.review.some(n => /application\/xml/.test(n) && /dropped/.test(n)), JSON.stringify(r));
});

// async: the importer fetches from a local server, so it must not be spawned synchronously
(async () => {
  await new Promise(resolve => {
    const srv = http.createServer((req, res) => { res.writeHead(404); res.end(JSON.stringify(spec3({ paths: { '/a': getOp('a') } }))); });
    srv.listen(0, '127.0.0.1', () => {
      const dir = tmp();
      const p = spawn(process.execPath, [IMPORTER, `http://127.0.0.1:${srv.address().port}/spec.json`, '--name', 'x'], { cwd: dir });
      let o = '';
      p.stdout.on('data', d => (o += d));
      p.on('close', code => {
        srv.close();
        test('spec URL answering non-2xx -> BLOCKED with the status', () => {
          const out = JSON.parse(o.trim().split('\n').pop() || '{}');
          assert.strictEqual(code, 2, o);
          assert.match(out.reason, /404/);
          assert.ok(!fs.existsSync(path.join(dir, 'integration')));
        });
        resolve();
      });
    });
  });
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
