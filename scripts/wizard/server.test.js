'use strict';
// HTTP-level tests for the wizard server: extraction over the wire (UTF-8),
// save validation, and path-traversal refusal.
// Run: node scripts/wizard/server.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, 'server.js');
const PORT = 7391;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

let TOKEN = '';   // read from the served page, like a browser would

const post = (route, body, headers = {}) =>
  fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wizard-Token': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

(async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-srv-'));
  const child = spawn(process.execPath, [SERVER, projectDir, `--port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  await new Promise(r => {
    const t = setInterval(() => { if (stdout.includes('Wizard running')) { clearInterval(t); r(); } }, 100);
  });

  // The page carries the token; a browser on another site cannot read it.
  TOKEN = (await (await fetch(`${BASE}/setup`)).text()).match(/const TOKEN = '([a-f0-9]+)'/)[1];

  await test('an API call without the page token is refused', async () => {
    const read = await fetch(`${BASE}/api/config`);
    assert.strictEqual(read.status, 403, 'cross-site read must be refused');
    // A simple POST (text/plain needs no CORS preflight) must not write files.
    const write = await fetch(`${BASE}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        projectConfig: { name: 'evil' }, envConfig: { portalUrl: 'https://evil.example' },
        envName: 'qa', secrets: { EVIL_KEY: 'pwned' },
      }),
    });
    assert.strictEqual(write.status, 403);
    assert.ok(!fs.existsSync(path.join(projectDir, 'config', 'project.json')), 'nothing written');
  });

  await test('responses carry no wildcard CORS header', async () => {
    const r = await fetch(`${BASE}/setup`);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await test('extracts Arabic labels sent over HTTP (UTF-8, not latin1)', async () => {
    const arName = 'اسم المشروع';   // اسم المشروع
    const arUrl  = 'الرابط';                            // الرابط
    const text = `${arName}: shop-portal\n${arUrl}: https://qa.shop.local\nDB: server=shop-db.local`;
    const r = await post('/api/extract', { text });
    const data = await r.json();
    assert.strictEqual(data.name, 'shop-portal');
    assert.strictEqual(data.portalUrl, 'https://qa.shop.local');
    assert.strictEqual(data['db.server'], 'shop-db.local');
  });

  await test('passes already-structured answers through untouched', async () => {
    const r = await post('/api/extract', { name: 'from-claude', portalUrl: 'https://x.example' });
    const data = await r.json();
    assert.strictEqual(data.name, 'from-claude');
    assert.strictEqual(data.portalUrl, 'https://x.example');
  });

  await test('rejects an invalid portalUrl on save', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo' }, envConfig: { portalUrl: 'nope' }, envName: 'qa', secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /portalUrl/);
  });

  await test('refuses an envName that escapes environments/', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo' }, envConfig: { portalUrl: 'https://ok.example' },
      envName: '../../evil', secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.ok(!fs.existsSync(path.join(projectDir, '..', '..', 'evil.json')), 'no file written outside the project');
  });

  await test('saves a valid payload and writes both config files', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      envConfig: { portalUrl: 'https://ok.example', users: { valid_user: { phone: '1' } } },
      envName: 'qa', secrets: { API_TOKEN: 'tok-test' },
    });
    assert.strictEqual(r.status, 200);
    const proj = JSON.parse(fs.readFileSync(path.join(projectDir, 'config', 'project.json'), 'utf8'));
    const env = JSON.parse(fs.readFileSync(path.join(projectDir, 'environments', 'qa.json'), 'utf8'));
    const dotenv = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.strictEqual(proj.name, 'demo');
    assert.deepStrictEqual(Object.keys(env.users), ['valid_user']);
    assert.match(dotenv, /^API_TOKEN=tok-test$/m);
    assert.ok(!JSON.stringify(env).includes('tok-test'), 'secret must not land in JSON');
  });

  await test('.env upsert keeps unrelated lines intact', async () => {
    fs.appendFileSync(path.join(projectDir, '.env'), 'KEEP_ME=untouched\n');
    await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      envConfig: { portalUrl: 'https://ok.example' },
      envName: 'qa', secrets: { API_TOKEN: 'tok-updated' },
    });
    const dotenv = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.match(dotenv, /^KEEP_ME=untouched$/m);
    assert.match(dotenv, /^API_TOKEN=tok-updated$/m);
    assert.ok(!dotenv.includes('tok-test'), 'old value replaced, not duplicated');
  });

  await test('an existing but unreadable config file is reported, not ignored', async () => {
    fs.writeFileSync(path.join(projectDir, 'config', 'project.json'), '{ broken json');
    const r = await fetch(`${BASE}/api/config`, { headers: { 'X-Wizard-Token': TOKEN } });
    const data = await r.json();
    assert.strictEqual(data.projectConfig, null);
    assert.deepStrictEqual(data.unreadable, ['config/project.json']);
    // Restore for the tests that follow.
    fs.writeFileSync(path.join(projectDir, 'config', 'project.json'),
      JSON.stringify({ name: 'demo', defaultEnvironment: 'qa' }));
  });

  await test('malformed JSON is a clean 400, not a crash', async () => {
    const r = await post('/api/save', '{ not json');
    assert.strictEqual(r.status, 400);
    const alive = await fetch(`${BASE}/api/schema`, { headers: { 'X-Wizard-Token': TOKEN } });
    assert.strictEqual(alive.status, 200, 'server still serving after bad input');
  });

  await test('secrets never appear in server stdout', async () => {
    assert.ok(!stdout.includes('tok-test') && !stdout.includes('tok-updated'), 'stdout leaked a secret');
  });

  child.kill();
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
