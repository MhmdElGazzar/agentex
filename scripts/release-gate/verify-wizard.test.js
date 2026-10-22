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
  // The gate persona must now answer the REQUIRED tracker select (Q12) or the
  // wizard refuses to advance; the answer itself is persisted:false in the
  // schema — its effect is the provider block, verified through the azure.*
  // answers, so the verifier checks nothing on disk for it.
  tracker: 'azure',
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

  await test('a persisted:false schema field (the tracker select) is counted but never demanded on disk', async () => {
    const dir = goodProject();
    // config/project.json carries NO `tracker` key — by design (the provider
    // block IS the selection). The verifier must not flag the answer.
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, { ...ANSWERS, tracker: 'azure' }) });
    assert.deepStrictEqual(r.findings.filter((f) => f.startsWith('tracker')), []);
    assert.strictEqual(r.ok, true);
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

  await test('.env read per line: export prefix, leading spaces, CRLF and quotes all count as present', async () => {
    const dir = goodProject();
    fs.writeFileSync(path.join(dir, '.env'), [
      'export FIGMA_TOKEN=dummy-figma-token-xyz',
      '  KB_ASK_API_KEY="dummy-kb-key-123"',
      "SQLCMDPASSWORD='dummy-db-pass-456'",
      'API_TOKEN=dummy-api-token-789',
    ].join('\r\n') + '\r\n');
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.deepStrictEqual(r.findings, []);
  });

  await test('an empty secret key never borrows the next line → finding', async () => {
    const dir = goodProject();
    // API_TOKEN is empty; the stray next line holds the expected value. The old
    // /m regex let \s* cross the newline and reported the secret as present.
    fs.writeFileSync(path.join(dir, '.env'), [
      'FIGMA_TOKEN=dummy-figma-token-xyz',
      'KB_ASK_API_KEY=dummy-kb-key-123',
      'SQLCMDPASSWORD=dummy-db-pass-456',
      'API_TOKEN=',
      'dummy-api-token-789',
    ].join('\n') + '\n');
    const r = verifyWizard({ dir, answersFile: withAnswers(dir) });
    assert.ok(r.findings.some((f) => f.startsWith('api.token') && f.includes('API_TOKEN')), r.findings.join('; '));
  });

  // ── Secret defaults.* answers (decision #6): descriptor-driven, value only in .env ──
  const PW = 'dummy-default-pass-321';
  // The project as the wizard writes a typed secret default: .env holds the value
  // under its env-var name, the environment file holds { envSecret: NAME } (or nothing).
  function secretDefaultsProject({ defaults = { password: { envSecret: 'DEFAULT_PASSWORD' }, otp: '2468' },
    envLines = [`DEFAULT_PASSWORD=${PW}`], defaultsFields } = {}) {
    const dir = goodProject();
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.defaults = defaults; });
    if (defaultsFields) editJson(path.join(dir, 'config', 'project.json'), (d) => { d.defaultsFields = defaultsFields; });
    fs.appendFileSync(path.join(dir, '.env'), envLines.join('\n') + '\n');
    return dir;
  }
  const TYPED = { ...ANSWERS, 'defaults.password': PW, 'defaults.otp': '2468' };

  await test('typed secret default (built-in descriptor) in .env, env file { envSecret } → 0 findings', async () => {
    const dir = secretDefaultsProject();
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, TYPED) });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.ok, true);
  });

  await test('typed secret default with the env file holding nothing for it (blank name slot) → 0 findings', async () => {
    const dir = secretDefaultsProject({ defaults: { otp: '2468' } });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, TYPED) });
    assert.deepStrictEqual(r.findings, []);
  });

  await test('typed secret default under a custom defaults.<key>EnvVar name → read from .env under that name', async () => {
    const dir = secretDefaultsProject({ defaults: { password: { envSecret: 'MY_PW' }, otp: '2468' }, envLines: [`MY_PW=${PW}`] });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, { ...TYPED, 'defaults.passwordEnvVar': 'MY_PW' }) });
    assert.deepStrictEqual(r.findings, []);
  });

  await test('typed secret default missing from .env → finding names the env var, never the value', async () => {
    const dir = secretDefaultsProject({ envLines: [] });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, TYPED) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.startsWith('defaults.password') && f.includes('DEFAULT_PASSWORD')), JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r.findings).includes(PW), 'secret value never echoed');
  });

  await test('typed secret default leaked into qc.json → finding without the value', async () => {
    const dir = secretDefaultsProject({ defaults: { password: PW, otp: '2468' } });
    const r = verifyWizard({ dir, answersFile: withAnswers(dir, TYPED) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.startsWith('defaults.password') && f.includes('leaked into environments/qc.json')), JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.startsWith('defaults.password') && f.includes('{ "envSecret": "DEFAULT_PASSWORD" }')), JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r.findings).includes(PW), 'secret value never echoed');
    const cli = spawnSync(process.execPath, [CLI, dir, '--answers', withAnswers(dir, TYPED)], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 1);
    assert.ok(!(cli.stdout + cli.stderr).includes(PW), 'CLI never prints the value');
  });

  await test('the secret rule follows the project\'s defaultsFields descriptors, not the key name', async () => {
    // pin is secret, password is a plain (legacy) field in this project's schema
    const fields = [{ key: 'password', label: 'P', default: 'Test@1234' }, { key: 'pin', label: 'PIN', secret: true }];
    const dir = secretDefaultsProject({ defaultsFields: fields,
      defaults: { password: 'Plain@Pass1', pin: { envSecret: 'DEFAULT_PIN' } }, envLines: ['DEFAULT_PIN=dummy-pin-9753'] });
    const answers = { ...ANSWERS, 'defaults.password': 'Plain@Pass1', 'defaults.pin': 'dummy-pin-9753' };
    let r = verifyWizard({ dir, answersFile: withAnswers(dir, answers) });
    assert.deepStrictEqual(r.findings, []);
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.defaults.pin = 'dummy-pin-9753'; });
    r = verifyWizard({ dir, answersFile: withAnswers(dir, answers) });
    assert.ok(r.findings.some((f) => f.startsWith('defaults.pin') && f.includes('leaked')), JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r.findings).includes('dummy-pin-9753'));
  });

  await test('plain defaults.otp is unchanged: verbatim in the env file, a wrong value is a finding', async () => {
    const dir = secretDefaultsProject();
    let r = verifyWizard({ dir, answersFile: withAnswers(dir, { ...ANSWERS, 'defaults.otp': '2468' }) });
    assert.deepStrictEqual(r.findings, []);
    editJson(path.join(dir, 'environments', 'qc.json'), (d) => { d.defaults.otp = '1111'; });
    r = verifyWizard({ dir, answersFile: withAnswers(dir, { ...ANSWERS, 'defaults.otp': '2468' }) });
    assert.deepStrictEqual(r.findings, ['defaults.otp: not placed at environments/qc.json → defaults.otp']);
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
