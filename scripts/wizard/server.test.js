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
  const child = spawn(process.execPath, [SERVER, projectDir, `--port=${PORT}`, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  await new Promise(r => {
    const t = setInterval(() => { if (stdout.includes('Wizard running')) { clearInterval(t); r(); } }, 100);
  });

  // The page carries the token; a browser on another site cannot read it.
  TOKEN = (await (await fetch(`${BASE}/setup`)).text()).match(/const TOKEN = '([a-f0-9]+)'/)[1];

  await test('--no-open: server prints the skip notice instead of launching a browser', async () => {
    assert.ok(stdout.includes('--no-open: skipping browser launch'),
      'expected the --no-open notice in server stdout (headless test run must not open a browser)');
  });

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

  await test('rejects a binary upload honestly and leaves no temp files', async () => {
    const boundary = '----wizardtest';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake-brd.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x03]),   // %PDF + NULs
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Wizard-Token': TOKEN },
      body,
    });
    assert.strictEqual(r.status, 415, 'binary upload must be refused, not faked as success');
    const data = await r.json();
    assert.ok(data.error, 'refusal carries an error');
    const litter = fs.readdirSync(projectDir).filter(f => f.startsWith('.agentex-upload-'));
    assert.deepStrictEqual(litter, [], 'no temp upload files left behind');
  });

  await test('a text file upload still extracts fields', async () => {
    const boundary = '----wizardtest2';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n\r\nPROJECT_NAME=upload-demo\nQA_TARGET_URL=https://up.example\n\r\n--${boundary}--\r\n`;
    const r = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Wizard-Token': TOKEN },
      body,
    });
    assert.strictEqual(r.status, 200);
    const data = await r.json();
    assert.strictEqual(data.name, 'upload-demo');
    assert.strictEqual(data.portalUrl, 'https://up.example');
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
      envConfig: { portalUrl: 'https://ok.example', users: { valid_user: { phone: '1' } } },
      envName: 'qa', secrets: { API_TOKEN: 'tok-updated' },
    });
    const dotenv = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.match(dotenv, /^KEEP_ME=untouched$/m);
    assert.match(dotenv, /^API_TOKEN=tok-updated$/m);
    assert.ok(!dotenv.includes('tok-test'), 'old value replaced, not duplicated');
  });

  await test('rejects secret env var names that are not valid identifiers', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      envConfig: { portalUrl: 'https://ok.example', users: { valid_user: { phone: '1' } } },
      envName: 'qa', secrets: { 'MY BAD KEY!': 'x' },
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /env var/i);
    const dotenv = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.ok(!dotenv.includes('MY BAD KEY!'), 'garbage key must not reach .env');
  });

  await test('writes the secret under the user-chosen env var name', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      envConfig: {
        portalUrl: 'https://ok.example',
        users: { valid_user: { phone: '1' } },
        db: { server: 'db.local', port: 1433, name: '', user: '', password: { envSecret: 'MY_DB_PASS' } },
      },
      envName: 'qa', secrets: { MY_DB_PASS: 'FakeDbPass123' },
    });
    assert.strictEqual(r.status, 200);
    const dotenv = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.match(dotenv, /^MY_DB_PASS=FakeDbPass123$/m, '.env key must match the envSecret the JSON references');
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

  await test('refuses to save an empty users object (would wipe saved users)', async () => {
    const r = await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      envConfig: { portalUrl: 'https://ok.example', users: {} },
      envName: 'qa', secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /user/i);
    const env = JSON.parse(fs.readFileSync(path.join(projectDir, 'environments', 'qa.json'), 'utf8'));
    assert.ok(Object.keys(env.users).length > 0, 'saved users untouched');
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

  // ── Pristine-aware prefill + save-time reconciliation ─────────────────────
  // A second server over a freshly-scaffolded project (template config + sample
  // environment straight from templates/) — the state the wizard meets right
  // after /init-test.
  const PLUGIN = path.join(__dirname, '..', '..');
  const projectDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-srv2-'));
  fs.mkdirSync(path.join(projectDir2, 'config'), { recursive: true });
  fs.mkdirSync(path.join(projectDir2, 'environments'), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN, 'templates', 'config', 'project.json'),
                  path.join(projectDir2, 'config', 'project.json'));
  fs.copyFileSync(path.join(PLUGIN, 'templates', 'environments', 'qc.json'),
                  path.join(projectDir2, 'environments', 'qc.json'));
  const PORT2 = 7392;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const child2 = spawn(process.execPath, [SERVER, projectDir2, `--port=${PORT2}`, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout2 = '';
  child2.stdout.on('data', d => { stdout2 += d; });
  await new Promise(r => {
    const t = setInterval(() => { if (stdout2.includes('Wizard running')) { clearInterval(t); r(); } }, 100);
  });
  const TOKEN2 = (await (await fetch(`${BASE2}/setup`)).text()).match(/const TOKEN = '([a-f0-9]+)'/)[1];
  const get2 = route => fetch(`${BASE2}${route}`, { headers: { 'X-Wizard-Token': TOKEN2 } });
  const post2 = (route, body) =>
    fetch(`${BASE2}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Token': TOKEN2 },
      body: JSON.stringify(body),
    });

  await test('a fresh scaffold is reported pristine, never prefilled as user data', async () => {
    const data = await (await get2('/api/config')).json();
    assert.strictEqual(data.samplePristine, true, 'sample must be recognized as pristine');
    assert.deepStrictEqual(data.environments, {},
      'a pristine sample is scaffolding — never presented as an editable environment');
    assert.strictEqual(data.sampleName, 'qc');
    assert.strictEqual(data.defaultEnvironment, 'qc');
    assert.strictEqual(data.projectPristine, true, 'template project.json is scaffolding, not config');
    assert.deepStrictEqual(data.pristineSamples, ['qc'],
      'every pristine sample is enumerated — the review step must list ALL files a save would reconcile');
  });

  await test('a user-touched environment under the default name is prefilled and protected', async () => {
    const envPath = path.join(projectDir2, 'environments', 'qc.json');
    const touched = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    touched.portalUrl = 'https://my-real-app.example';
    fs.writeFileSync(envPath, JSON.stringify(touched, null, 2) + '\n');
    const data = await (await get2('/api/config')).json();
    assert.strictEqual(data.samplePristine, false);
    assert.strictEqual(data.environments.qc.portalUrl, 'https://my-real-app.example', 'user data prefilled exactly as before');
    // restore the pristine sample for the reconciliation tests below
    fs.copyFileSync(path.join(PLUGIN, 'templates', 'environments', 'qc.json'), envPath);
  });

  await test('saving under another name reconciles the pristine sample away, announced', async () => {
    const r = await post2('/api/save', {
      projectConfig: { name: 'demo2', defaultEnvironment: 'uat', login: { mode: 'session' } },
      envConfig: { portalUrl: 'https://uat.example', users: { u1: { phone: '1' } } },
      envName: 'uat', secrets: {},
    });
    assert.strictEqual(r.status, 200);
    const res = await r.json();
    assert.deepStrictEqual(res.reconciled, ['environments/qc.json'], 'removal echoed in the response');
    assert.ok(!fs.existsSync(path.join(projectDir2, 'environments', 'qc.json')), 'pristine sample removed');
    assert.ok(fs.existsSync(path.join(projectDir2, 'environments', 'uat.json')), 'user environment written');
    const proj = JSON.parse(fs.readFileSync(path.join(projectDir2, 'config', 'project.json'), 'utf8'));
    assert.strictEqual(proj.defaultEnvironment, 'uat', 'default names the environment that exists');
  });

  await test('save rejects a defaultEnvironment that names no post-save file', async () => {
    const r = await post2('/api/save', {
      projectConfig: { name: 'demo2', defaultEnvironment: 'ghost' },
      envConfig: { portalUrl: 'https://x.example', users: { u1: { phone: '1' } } },
      envName: 'uat3', secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /defaultEnvironment/);
    assert.ok(!fs.existsSync(path.join(projectDir2, 'environments', 'uat3.json')), 'nothing written on reject');
  });

  await test('a pristine sample under the historical qa name is reconciled too', async () => {
    fs.copyFileSync(path.join(PLUGIN, 'templates', 'environments', 'qc.json'),
                    path.join(projectDir2, 'environments', 'qa.json'));
    // /api/config enumerates it up front — the review step can announce the
    // removal BEFORE the save, by name, even under a non-default name.
    const cfg = await (await get2('/api/config')).json();
    assert.deepStrictEqual(cfg.pristineSamples, ['qa'],
      'a pristine sample under any name is listed (uat is user data, not listed)');
    const r = await post2('/api/save', {
      projectConfig: { name: 'demo2', defaultEnvironment: 'uat', login: { mode: 'session' } },
      envConfig: { portalUrl: 'https://uat.example', users: { u1: { phone: '1' } } },
      envName: 'uat', secrets: {},
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).reconciled, ['environments/qa.json']);
    assert.ok(!fs.existsSync(path.join(projectDir2, 'environments', 'qa.json')));
  });

  await test('a non-pristine environment under another name is never touched', async () => {
    const keepPath = path.join(projectDir2, 'environments', 'keep.json');
    const keepBytes = '{\n  "portalUrl": "https://keep.example",\n  "users": { "k": { "phone": "9" } }\n}\n';
    fs.writeFileSync(keepPath, keepBytes);
    const r = await post2('/api/save', {
      projectConfig: { name: 'demo2', defaultEnvironment: 'qc2' },
      envConfig: { portalUrl: 'https://qc2.example', users: { u1: { phone: '1' } } },
      envName: 'qc2', secrets: {},
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).reconciled, [], 'nothing pristine, nothing removed');
    assert.strictEqual(fs.readFileSync(keepPath, 'utf8'), keepBytes, 'user environment byte-identical');
    assert.ok(fs.existsSync(path.join(projectDir2, 'environments', 'uat.json')), 'other user environment intact');
  });

  // ── Multi-environment sessions: enumeration, batch save, confirmed ops ────
  // A third server over a project with real environments (user data), a
  // pristine leftover, and an unreadable file — the state design #3's
  // environments manager meets. Rename/delete are the wizard's FIRST
  // destructive capability: the rejection paths are first-class here.
  const projectDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-srv3-'));
  fs.mkdirSync(path.join(projectDir3, 'config'), { recursive: true });
  fs.mkdirSync(path.join(projectDir3, 'environments'), { recursive: true });
  const env3 = (name) => path.join(projectDir3, 'environments', `${name}.json`);
  fs.writeFileSync(path.join(projectDir3, 'config', 'project.json'),
    JSON.stringify({ name: 'multi', defaultEnvironment: 'qa', login: { mode: 'session' } }, null, 2) + '\n');
  fs.writeFileSync(env3('qa'),
    JSON.stringify({ portalUrl: 'https://qa.example', users: { a: { phone: '1' } } }, null, 2) + '\n');
  fs.writeFileSync(env3('uat'),
    JSON.stringify({ portalUrl: 'https://uat.example', users: { b: { phone: '2' } } }, null, 2) + '\n');
  fs.copyFileSync(path.join(PLUGIN, 'templates', 'environments', 'qc.json'), env3('qc'));
  fs.writeFileSync(env3('broken'), '{ not json');
  const PORT3 = 7393;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  const child3 = spawn(process.execPath, [SERVER, projectDir3, `--port=${PORT3}`, '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout3 = '';
  child3.stdout.on('data', d => { stdout3 += d; });
  await new Promise(r => {
    const t = setInterval(() => { if (stdout3.includes('Wizard running')) { clearInterval(t); r(); } }, 100);
  });
  const TOKEN3 = (await (await fetch(`${BASE3}/setup`)).text()).match(/const TOKEN = '([a-f0-9]+)'/)[1];
  const get3 = route => fetch(`${BASE3}${route}`, { headers: { 'X-Wizard-Token': TOKEN3 } });
  const post3 = (route, body) =>
    fetch(`${BASE3}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Token': TOKEN3 },
      body: JSON.stringify(body),
    });
  const proj3 = { name: 'multi', defaultEnvironment: 'qa', login: { mode: 'session' } };

  await test('/api/config enumerates every environment; pristine and unreadable are flagged, not editable', async () => {
    const data = await (await get3('/api/config')).json();
    assert.strictEqual(data.defaultEnvironment, 'qa');
    assert.strictEqual(data.environments.qa.portalUrl, 'https://qa.example');
    assert.strictEqual(data.environments.uat.portalUrl, 'https://uat.example');
    assert.ok(!('qc' in data.environments), 'a pristine sample is scaffolding, not an editable environment');
    assert.deepStrictEqual(data.pristineSamples, ['qc']);
    assert.strictEqual(data.environments.broken, null, 'an unreadable file is flagged, never silently editable');
    assert.deepStrictEqual(data.unreadable, ['environments/broken.json']);
    assert.strictEqual(data.samplePristine, false, 'the default names user data, not the sample');
  });

  await test('one save writes every configured environment and reconciles the pristine sample', async () => {
    const brokenBytes = fs.readFileSync(env3('broken'), 'utf8');
    const r = await post3('/api/save', {
      projectConfig: proj3,
      environments: {
        qa:  { portalUrl: 'https://qa.example',  users: { a: { phone: '1' } } },
        stg: { portalUrl: 'https://stg.example', users: { s: { phone: '3' } } },
      },
      ops: { renames: [], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 200);
    const res = await r.json();
    assert.deepStrictEqual([...res.written].sort(),
      ['config/project.json', 'environments/qa.json', 'environments/stg.json'],
      'every written file echoed');
    assert.ok(fs.existsSync(env3('stg')), 'second environment written');
    assert.deepStrictEqual(res.reconciled, ['environments/qc.json'], 'pristine sample removal echoed');
    assert.ok(!fs.existsSync(env3('qc')), 'pristine sample reconciled away');
    assert.strictEqual(fs.readFileSync(env3('broken'), 'utf8'), brokenBytes, 'unreadable file untouched');
  });

  await test('rename executes as rename-then-report when the file is not otherwise rewritten', async () => {
    const before = fs.readFileSync(env3('uat'), 'utf8');
    const r = await post3('/api/save', {
      projectConfig: proj3,
      environments: {},
      ops: { renames: [{ from: 'uat', to: 'stage', confirmed: true }], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 200);
    const res = await r.json();
    assert.deepStrictEqual(res.renamed,
      [{ from: 'environments/uat.json', to: 'environments/stage.json' }], 'rename echoed');
    assert.ok(!fs.existsSync(env3('uat')), 'old file gone');
    assert.strictEqual(fs.readFileSync(env3('stage'), 'utf8'), before, 'content byte-identical after a pure rename');
  });

  await test('renamed-and-edited: written under the new name, the old file removed by the same op', async () => {
    const r = await post3('/api/save', {
      projectConfig: proj3,
      environments: { stage2: { portalUrl: 'https://stage2.example', users: { s: { phone: '3' } } } },
      ops: { renames: [{ from: 'stage', to: 'stage2', confirmed: true }], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(env3('stage')), 'old name removed');
    const env = JSON.parse(fs.readFileSync(env3('stage2'), 'utf8'));
    assert.strictEqual(env.portalUrl, 'https://stage2.example', 'new name carries the edited content');
  });

  await test('the default follows its rename inside the same confirmed save', async () => {
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [{ from: 'qa', to: 'prod', confirmed: true }], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(env3('qa')) && fs.existsSync(env3('prod')));
    const proj = JSON.parse(fs.readFileSync(path.join(projectDir3, 'config', 'project.json'), 'utf8'));
    assert.strictEqual(proj.defaultEnvironment, 'prod', 'defaultEnvironment stays coherent with the rename');
  });

  await test('REJECTED: an un-consented rename or delete touches nothing', async () => {
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [{ from: 'stg', to: 'stg2' }], deletes: [] },   // no confirmed: true
      secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /consent/i);
    assert.ok(fs.existsSync(env3('stg')) && !fs.existsSync(env3('stg2')), 'file untouched');
    const r2 = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'stg' }] },               // no confirmed: true
      secrets: {},
    });
    assert.strictEqual(r2.status, 400);
    assert.match((await r2.json()).error, /consent/i);
    assert.ok(fs.existsSync(env3('stg')), 'file still on disk');
  });

  await test('REJECTED: ops on files the server did not enumerate', async () => {
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [{ from: 'ghost', to: 'newname', confirmed: true }], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /ghost/);
    const r2 = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'ghost', confirmed: true }] },
      secrets: {},
    });
    assert.strictEqual(r2.status, 400);
    assert.match((await r2.json()).error, /ghost/);
  });

  await test('REJECTED: deleting the default without designating a new one', async () => {
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'prod', confirmed: true }] },
      secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /defaultEnvironment/);
    assert.ok(fs.existsSync(env3('prod')), 'default environment file untouched');
  });

  await test('an explicit confirmed delete is executed and echoed', async () => {
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'stage2', confirmed: true }] },
      secrets: {},
    });
    assert.strictEqual(r.status, 200);
    const res = await r.json();
    assert.deepStrictEqual(res.deleted, ['environments/stage2.json'], 'deletion echoed in the response');
    assert.ok(!fs.existsSync(env3('stage2')), 'file deleted only as the explicit, confirmed op');
  });

  await test('REJECTED: writing over or deleting an unreadable environment file', async () => {
    const brokenBytes = fs.readFileSync(env3('broken'), 'utf8');
    const r = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: { broken: { portalUrl: 'https://b.example', users: { u: { phone: '1' } } } },
      ops: { renames: [], deletes: [] },
      secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /broken/);
    const r2 = await post3('/api/save', {
      projectConfig: { ...proj3, defaultEnvironment: 'prod' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'broken', confirmed: true }] },
      secrets: {},
    });
    assert.strictEqual(r2.status, 400);
    assert.strictEqual(fs.readFileSync(env3('broken'), 'utf8'), brokenBytes,
      'the wizard never touches what it could not read');
  });

  await test('REJECTED: deleting the last environment', async () => {
    // server 1's project has exactly one environment file (environments/qa.json)
    const r = await post('/api/save', {
      projectConfig: { name: 'demo', defaultEnvironment: 'qa' },
      environments: {},
      ops: { renames: [], deletes: [{ name: 'qa', confirmed: true }] },
      secrets: {},
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /at least one environment/i);
    assert.ok(fs.existsSync(path.join(projectDir, 'environments', 'qa.json')), 'the last environment file is untouched');
  });

  child.kill();
  child2.kill();
  child3.kill();
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
