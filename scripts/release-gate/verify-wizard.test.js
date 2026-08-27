'use strict';
// Unit tests for the release-gate wizard-placement verifier.
// Run: node scripts/release-gate/verify-wizard.test.js — fully offline, dummy values only.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyWizard } = require('./verify-wizard.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CLI = path.join(__dirname, 'verify-wizard.js');

const ANSWERS = {
  name: 'gate-sample',
  'login.mode': 'session',
  'figma.fileKey': 'FileKey123',
  'figma.tokenEnvVar': 'FIGMA_TOKEN',
  'figma.token': 'dummy-figma-token-xyz',
  'kb.baseUrl': 'http://localhost:3000',
  'kb.project': 'sample-kb',
  'kb.key': 'dummy-kb-key-123',
  envName: 'qc',
  portalUrl: 'https://practice.example.com',
  'db.server': 'localhost',
  'db.port': 1433,
  'db.name': 'SampleDb',
  'db.user': 'qa_user',
  'db.passwordEnvVar': 'SQLCMDPASSWORD',
  'db.password': 'dummy-db-pass-456',
  'api.baseUrl': 'https://api.practice.example.com',
  'api.tokenEnvVar': 'API_TOKEN',
  'api.token': 'dummy-api-token-789',
  users: [{ handle: 'valid_user', phone: '0550000001', role: 'customer' }],
};

// A throwaway project exactly as the wizard would have written it for ANSWERS.
function goodProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-vw-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'environments'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    name: 'gate-sample',
    defaultEnvironment: 'qc',
    kb: { baseUrl: 'http://localhost:3000', project: 'sample-kb' },
    login: { mode: 'session' },
    figma: { fileKey: 'FileKey123', token: { envSecret: 'FIGMA_TOKEN' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'environments', 'qc.json'), JSON.stringify({
    portalUrl: 'https://practice.example.com',
    defaults: { password: 'Test@1234', otp: '0000' },
    users: { valid_user: { phone: '0550000001', role: 'customer' } },
    db: { server: 'localhost', port: 1433, name: 'SampleDb', user: 'qa_user', password: { envSecret: 'SQLCMDPASSWORD' } },
    api: { baseUrl: 'https://api.practice.example.com', token: { envSecret: 'API_TOKEN' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, '.env'), [
    'FIGMA_TOKEN=dummy-figma-token-xyz',
    'KB_ASK_API_KEY=dummy-kb-key-123',
    'SQLCMDPASSWORD=dummy-db-pass-456',
    'API_TOKEN=dummy-api-token-789',
  ].join('\n') + '\n');
  return dir;
}

function withAnswers(dir, answers = ANSWERS) {
  const f = path.join(dir, 'answers.json');
  fs.writeFileSync(f, JSON.stringify(answers));
  return f;
}

function editJson(file, fn) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

(async () => {
  await test('happy path: every answer in its documented home, secrets only in .env → ok', async () => {
    const dir = goodProject();
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.ok, true);
    assert.ok(r.checked >= 15, `checked ${r.checked} placements`);
  });

  await test('a secret value leaked into a JSON config file → finding names the key, never the value', async () => {
    const dir = goodProject();
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.leak = 'dummy-db-pass-456'; });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    const hit = r.findings.find((f) => f.includes('db.password'));
    assert.ok(hit, JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r.findings).includes('dummy-db-pass-456'), 'secret value never echoed');
  });

  await test('a secret missing from .env → finding (env var name only)', async () => {
    const dir = goodProject();
    fs.writeFileSync(path.join(dir, '.env'), 'FIGMA_TOKEN=dummy-figma-token-xyz\n');
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('SQLCMDPASSWORD')), JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r.findings).includes('dummy-db-pass-456'));
  });

  await test('a project answer missing from config/project.json → finding', async () => {
    const dir = goodProject();
    editJson(path.join(dir, 'config', 'project.json'), (d) => { delete d.kb.project; });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('kb.project')), JSON.stringify(r.findings));
  });

  await test('an env answer with the wrong value → finding', async () => {
    const dir = goodProject();
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.portalUrl = 'https://other.example.com'; });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('portalUrl')), JSON.stringify(r.findings));
  });

  await test('an EnvVar answer must land as { envSecret: NAME } — wrong name is a finding', async () => {
    const dir = goodProject();
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.db.password = { envSecret: 'WRONG_NAME' }; });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('db.passwordEnvVar')), JSON.stringify(r.findings));
  });

  await test('a test user answer missing from the users object → finding', async () => {
    const dir = goodProject();
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { delete d.users.valid_user; });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('valid_user')), JSON.stringify(r.findings));
  });

  await test('CLI: exit 0 on clean, 1 on findings, one JSON line on stdout', async () => {
    const clean = goodProject();
    let r = spawnSync(process.execPath, [CLI, clean, '--answers', withAnswers(clean)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, true);
    const broken = goodProject();
    editJson(path.join(broken, 'config', 'project.json'), (d) => { delete d.name; });
    r = spawnSync(process.execPath, [CLI, broken, '--answers', withAnswers(broken)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, false);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
