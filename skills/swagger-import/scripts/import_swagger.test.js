'use strict';
// Tests for import_swagger.js against local spec fixtures.
// Run: node skills/swagger-import/scripts/import_swagger.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
