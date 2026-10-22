'use strict';
// Tests for the /update-agentex migration engine (scripts/migrate.js + scripts/migrations/).
// Run: node scripts/migrate.test.js
// Era fixtures follow the CHANGELOG convention timeline: 0.2 (specs + minimal .env),
// 0.6 (integrations/ + catalog connection block), 0.8 (agentex.config.json KB keys),
// 0.10 (full keys-only .env), current (fresh init.js scaffold).
const assert = require('node:assert');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MIGRATE = path.join(__dirname, 'migrate.js');
const INIT = path.join(__dirname, 'init.js');
const INSTALLED = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

// Sentinel secret values — a final test asserts none of them ever reaches stdout/stderr.
const SENTINELS = {
  pat: 'SENTINEL_PAT_9f4x', dbpw: 'SENTINEL_DBPW_3k8v',
  token: 'SENTINEL_TOKEN_7q2m', kbkey: 'SENTINEL_KBKEY_5x1z',
};
const ALL_OUTPUT = [];

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── fixture helpers ───────────────────────────────────────────────────────────
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mig-'));
  addFiles(dir, files);
  return dir;
}
function addFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
}
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
}
function gitInit(dir) { git(dir, 'init', '-q'); commitAll(dir); }
function commitAll(dir) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fixture', '--allow-empty'); }
function repo(files = {}) { const dir = proj(files); gitInit(dir); return dir; }

function run(dir, ...extraArgs) {
  try {
    const out = execFileSync(process.execPath, [MIGRATE, dir, ...extraArgs], { encoding: 'utf8' });
    ALL_OUTPUT.push(out);
    return { code: 0, out };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    ALL_OUTPUT.push(out);
    return { code: e.status, out };
  }
}
function runInit(dir) { ALL_OUTPUT.push(execFileSync(process.execPath, [INIT, dir], { encoding: 'utf8' })); }

function readJson(dir, rel) { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); }
function readText(dir, rel) { return fs.readFileSync(path.join(dir, rel), 'utf8'); }
function exists(dir, rel) { return fs.existsSync(path.join(dir, rel)); }

// Full-tree snapshot (path → size:mtime:sha1), .git excluded — proves zero writes.
function snapshot(dir) {
  const map = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        const hash = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
        map[path.relative(dir, full).split(path.sep).join('/')] = `${st.size}:${st.mtimeMs}:${hash}`;
      }
    }
  })(dir);
  return map;
}
// Snapshot restricted to paths under a prefix — byte-identity assertions.
function subset(snap, prefix) {
  return Object.fromEntries(Object.entries(snap).filter(([p]) => p.startsWith(prefix)));
}

// ── era fixture builders ──────────────────────────────────────────────────────
const SPEC_02 = '# Spec: smoke\n\n1. Open the portal; expect the dashboard.\n';
const EXEC_OLD = 'run 2025-01-01 — PASSED (legacy layout)\n';

function fixture010() {
  return repo({
    'test/suite1/login.md': '# Spec: login\n\n1. Login as valid_user; expect dashboard.\n',
    'executions/execu_20250101_1200/report.md': EXEC_OLD,
    'integration/shop_db.json': {
      name: 'shop-db', engine: 'sqlserver',
      connection: { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME', userEnv: 'DB_USER' },
      queries: [],
    },
    '.gitignore': 'node_modules/\n.env\n',
    'CLAUDE.md': '# My project\n\nSome user guidance.\n',
    '.env': [
      'QA_TARGET_URL=https://qa.example.test/ar',
      'PROJECT_NAME=demo-shop',
      'AZURE_URL=https://dev.azure.com/exampleorg',
      'AZURE_PROJECT=DemoShop',
      'AZURE_TEAM=QA Team',
      'DB_SERVER=db01.internal.test',
      'DB_PORT=1434',
      'DB_NAME=DemoDb',
      'DB_USER=qa_runner',
      'API_BASE_URL=https://api.qa.example.test',
      'KB_ASK_BASE_URL=https://kb.example.test',
      'KB_PROJECT=demo-kb',
      `AZURE_PAT=${SENTINELS.pat}`,
      `SQLCMDPASSWORD=${SENTINELS.dbpw}`,
      `API_TOKEN=${SENTINELS.token}`,
      `KB_ASK_API_KEY=${SENTINELS.kbkey}`,
      'CUSTOM_UNRELATED=keepme',
      '',
    ].join('\n'),
  });
}

// ── guards ────────────────────────────────────────────────────────────────────
test('guard: refuses to run inside the plugin root itself', () => {
  const r = run(PLUGIN_ROOT);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /plugin/i);
});

test('guard: refuses outside a git repository', () => {
  const dir = proj({ '.env': 'QA_TARGET_URL=https://x.test\n' });
  const r = run(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /git/i);
});

test('guard: dirty tracked file aborts, project untouched', () => {
  const dir = repo({ 'test/suite1/a.md': SPEC_02, '.env': 'QA_TARGET_URL=https://x.test\n' });
  fs.appendFileSync(path.join(dir, 'test/suite1/a.md'), 'edited\n');
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /commit first/i);
  assert.deepStrictEqual(snapshot(dir), before);
});

test('guard: untracked file in a migration-owned path aborts', () => {
  const dir = repo({ 'test/suite1/a.md': SPEC_02 });
  addFiles(dir, { 'config/half-done.json': '{}\n' });   // untracked collision
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /untracked/i);
  assert.deepStrictEqual(snapshot(dir), before);
});

test('guard: untracked executions/ noise does NOT block', () => {
  const dir = repo({ 'test/suite1/a.md': SPEC_02, '.env': 'QA_TARGET_URL=https://x.test\nAZURE_PAT=' + SENTINELS.pat + '\n' });
  addFiles(dir, { 'executions/execu_999/log.txt': 'noise\n' });
  const r = run(dir);
  assert.strictEqual(r.code, 0);
});

test('guard: stamp newer than installed plugin aborts', () => {
  const dir = repo({ '.agentex/version.json': { version: '99.0.0' }, 'test/suite1/a.md': SPEC_02 });
  const r = run(dir);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /newer/i);
});

// ── 0.10-style era fixture — the full keys-only .env migration ────────────────
test('0.10 era: values land in their JSON homes, secrets stay in .env', () => {
  const dir = fixture010();
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] env-split/);

  const project = readJson(dir, 'config/project.json');
  assert.strictEqual(project.name, 'demo-shop');
  assert.strictEqual(project.azure.org, 'https://dev.azure.com/exampleorg');
  assert.strictEqual(project.azure.project, 'DemoShop');
  assert.strictEqual(project.azure.team, 'QA Team');
  assert.strictEqual(project.kb.baseUrl, 'https://kb.example.test');
  assert.strictEqual(project.kb.project, 'demo-kb');

  const env = readJson(dir, 'environments/qc.json');
  assert.strictEqual(env.portalUrl, 'https://qa.example.test/ar');
  assert.strictEqual(env.db.server, 'db01.internal.test');
  assert.strictEqual(env.db.port, 1434);
  assert.strictEqual(env.db.name, 'DemoDb');
  assert.strictEqual(env.db.user, 'qa_runner');
  assert.deepStrictEqual(env.db.password, { envSecret: 'SQLCMDPASSWORD' });
  assert.strictEqual(env.api.baseUrl, 'https://api.qa.example.test');

  const envFile = readText(dir, '.env');
  for (const gone of ['QA_TARGET_URL', 'PROJECT_NAME', 'AZURE_URL', 'AZURE_PROJECT', 'AZURE_TEAM',
    'DB_SERVER', 'DB_PORT', 'DB_NAME', 'DB_USER', 'API_BASE_URL', 'KB_ASK_BASE_URL', 'KB_PROJECT']) {
    assert.ok(!new RegExp(`^${gone}=`, 'm').test(envFile), `${gone} should be removed from .env`);
  }
  assert.match(envFile, new RegExp(`^AZURE_PAT=${SENTINELS.pat}$`, 'm'));
  assert.match(envFile, new RegExp(`^SQLCMDPASSWORD=${SENTINELS.dbpw}$`, 'm'));
  assert.match(envFile, new RegExp(`^API_TOKEN=${SENTINELS.token}$`, 'm'));
  assert.match(envFile, new RegExp(`^KB_ASK_API_KEY=${SENTINELS.kbkey}$`, 'm'));
  assert.match(envFile, /^CUSTOM_UNRELATED=keepme$/m, 'unrecognized keys must survive');

  // user data byte-identical
  const after = snapshot(dir);
  assert.deepStrictEqual(subset(after, 'test/'), subset(before, 'test/'));
  assert.deepStrictEqual(subset(after, 'executions/'), subset(before, 'executions/'));
  assert.deepStrictEqual(subset(after, 'integration/'), subset(before, 'integration/'),
    'user-filled catalog is only flagged, never rewritten');

  // stamp
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED);
  // CLAUDE.md bullet appended, user lines intact
  const claude = readText(dir, 'CLAUDE.md');
  assert.match(claude, /Some user guidance\./);
  assert.match(claude, /test-run artifacts/);
});

test('0.10 era: structure and schemas match a fresh init.js scaffold', () => {
  const dir = fixture010();
  assert.strictEqual(run(dir).code, 0);
  const fresh = proj();
  runInit(fresh);
  for (const p of ['config/project.json', 'environments/qc.json', '.agentex/version.json', '.gitignore', 'CLAUDE.md']) {
    assert.ok(exists(dir, p), `migrated project should have ${p}`);
    assert.ok(exists(fresh, p), `fresh scaffold should have ${p}`);
  }
  assert.ok(fs.statSync(path.join(dir, 'executions')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'integration')).isDirectory());
  const migratedKeys = Object.keys(readJson(dir, 'config/project.json')).sort();
  const freshKeys = Object.keys(readJson(fresh, 'config/project.json')).sort();
  // A fresh scaffold no longer pre-seeds a provider block (Q12: an unconditional
  // ADO placeholder is a silent default — the wizard writes the CHOSEN
  // provider's block). The MIGRATED legacy project keeps its azure block,
  // carried from its own .env AZURE_* lines by m02/m03 — the template change
  // must never strand it.
  assert.deepStrictEqual(migratedKeys.filter(k => k !== 'azure'), freshKeys, 'project.json schema');
  assert.ok(migratedKeys.includes('azure'), 'the legacy AZURE_* carry survives the template change');
  assert.deepStrictEqual(
    Object.keys(readJson(dir, 'environments/qc.json')).sort(),
    Object.keys(readJson(fresh, 'environments/qc.json')).sort(), 'environment schema');
});

// ── 0.2-style era fixture ─────────────────────────────────────────────────────
test('0.2 era: gaps filled, user specs kept, sample specs NOT copied in', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    'executions/execu_1/log.txt': EXEC_OLD,
    '.env': `QA_TARGET_URL=https://old.example.test\nAZURE_PAT=${SENTINELS.pat}\n`,
  });
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(readJson(dir, 'environments/qc.json').portalUrl, 'https://old.example.test');
  assert.ok(exists(dir, 'config/project.json'));
  assert.ok(exists(dir, 'integration/sample_api.json'));
  assert.ok(exists(dir, '.gitignore'));
  assert.match(readText(dir, '.gitignore'), /^\.env$/m);
  assert.match(readText(dir, 'CLAUDE.md'), /test-run artifacts/);
  assert.ok(!exists(dir, 'test/suite1/product-search.md'), 'bundled samples must not land next to user specs');
  const after = snapshot(dir);
  assert.deepStrictEqual(subset(after, 'test/'), subset(before, 'test/'));
  assert.deepStrictEqual(subset(after, 'executions/'), subset(before, 'executions/'));
  assert.ok(!/^QA_TARGET_URL=/m.test(readText(dir, '.env')));
  assert.match(readText(dir, '.env'), new RegExp(`^AZURE_PAT=${SENTINELS.pat}$`, 'm'));
});

// m07 fill-gaps must not inject a sample environment into a project that already
// has environments — the sample would survive as a phantom under a name the user
// never chose (the same bug the scaffold had; both share scaffoldProject).
test('m07: legacy project with its own environment gets NO sample env injected', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    'config/project.json': { name: 'p', defaultEnvironment: 'uat', login: { mode: 'session' } },
    'environments/uat.json': { portalUrl: 'https://uat.example.test', defaults: {}, users: { u1: { phone: '1' } } },
    '.gitignore': '.env\n',
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!exists(dir, 'environments/qc.json'), 'no sample beside the user environment');
  assert.ok(!exists(dir, 'environments/qa.json'), 'no legacy-named sample either');
  assert.strictEqual(readJson(dir, 'environments/uat.json').portalUrl, 'https://uat.example.test');
});

// ── 0.6-style era fixture ─────────────────────────────────────────────────────
test('0.6 era: integrations/ renamed, contents intact, spec drift flagged', () => {
  const catalog = {
    name: 'shop-db', engine: 'sqlserver',
    connection: { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME', userEnv: 'DB_USER' },
    queries: [{ name: 'order-by-id', params: ['id'], query: "SELECT * FROM Orders WHERE Id = '{id}'" }],
  };
  const dir = repo({
    'test/suite1/checkout.md':
      '# Spec: checkout\n\n1. db: shop-db.order-by-id(id=1) — catalog in integrations/shop_db.json\n2. Set QA_TARGET_URL before running.\n',
    'integrations/shop_db.json': catalog,
    'integrations/shop_api.json': { name: 'shop-api', baseUrl: 'https://api.test', requests: [] },
    '.gitignore': '.env\n',
    '.env': `QA_TARGET_URL=https://qa6.example.test\nDB_SERVER=db6.test\nDB_NAME=Shop6\nDB_USER=qa6\nSQLCMDPASSWORD=${SENTINELS.dbpw}\n`,
  });
  const catalogBytes = readText(dir, 'integrations/shop_db.json');
  const specBytes = readText(dir, 'test/suite1/checkout.md');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!exists(dir, 'integrations'), 'integrations/ should be renamed away');
  assert.strictEqual(readText(dir, 'integration/shop_db.json'), catalogBytes, 'catalog byte-identical after rename');
  assert.ok(exists(dir, 'integration/shop_api.json'));
  assert.ok(!exists(dir, 'integration/sample_db.json'), 'rename must run before gap-fill (no samples beside user catalog)');
  const env = readJson(dir, 'environments/qc.json');
  assert.strictEqual(env.db.server, 'db6.test');
  assert.strictEqual(env.db.name, 'Shop6');
  // spec drift flagged, spec untouched
  assert.match(r.out, /\[flag\].*checkout\.md.*integrations\//);
  assert.match(r.out, /\[flag\].*checkout\.md.*QA_TARGET_URL/);
  assert.strictEqual(readText(dir, 'test/suite1/checkout.md'), specBytes, 'spec byte-identical');
});

test('m01: both integrations/ and integration/ present → [manual], nothing moved', () => {
  const dir = repo({
    'integrations/a_db.json': { name: 'a' },
    'integration/b_db.json': { name: 'b' },
    'test/suite1/a.md': SPEC_02,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[manual\].*integrations\//);
  assert.ok(exists(dir, 'integrations/a_db.json'));
  assert.ok(exists(dir, 'integration/b_db.json'));
});

// ── 0.8-style era fixture ─────────────────────────────────────────────────────
test('0.8 era: agentex.config.json kb.* absorbed into config/project.json, file removed', () => {
  const dir = repo({
    'agentex.config.json': { kb: { baseUrl: 'https://kb8.example.test', project: 'kb8' } },
    'test/suite1/a.md': SPEC_02,
    '.env': `KB_ASK_API_KEY=${SENTINELS.kbkey}\n`,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] absorb-agentex-config/);
  assert.ok(!exists(dir, 'agentex.config.json'), 'legacy file deleted');
  const project = readJson(dir, 'config/project.json');
  assert.strictEqual(project.kb.baseUrl, 'https://kb8.example.test');
  assert.strictEqual(project.kb.project, 'kb8');
});

test('m02: unparseable agentex.config.json → [manual], stamp WITHHELD, re-run absorbs after fix', () => {
  const dir = repo({
    'agentex.config.json': '{ broken',   // invalid JSON — m02 must not delete it
    'test/suite1/a.md': SPEC_02,
  });
  const r1 = run(dir);
  assert.strictEqual(r1.code, 0, r1.out);
  assert.match(r1.out, /\[manual\].*agentex\.config\.json/);
  assert.ok(exists(dir, 'agentex.config.json'), 'unreadable legacy file left in place');
  // The honest stamp: stamp == "project matches installed conventions". With an
  // unabsorbed legacy config it does not — stamping here would dead-end the
  // advertised re-run on the version-gate fast path.
  assert.ok(!exists(dir, '.agentex/version.json'), 'stamp must be withheld while [manual] items remain');
  // user fixes the file and commits (run-1 outputs included), then simply re-runs
  addFiles(dir, { 'agentex.config.json': { kb: { baseUrl: 'https://kb.fix.test', project: 'fixed' } } });
  commitAll(dir);
  const r2 = run(dir);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.match(r2.out, /\[migrated\] absorb-agentex-config/, 're-run must re-enter the pipeline, not fast-path');
  assert.ok(!exists(dir, 'agentex.config.json'), 'fixed legacy file absorbed and removed');
  assert.strictEqual(readJson(dir, 'config/project.json').kb.baseUrl, 'https://kb.fix.test');
  assert.strictEqual(readJson(dir, 'config/project.json').kb.project, 'fixed');
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED, 'stamp written once manual items are gone');
});

// ── m04: catalog connection block → environment db block ─────────────────────
test('m04: catalog connection resolved into env db block; catalog only flagged', () => {
  const dir = repo({
    'config/project.json': { name: 'p', defaultEnvironment: 'qa', login: { mode: 'session' } },
    'environments/qa.json': { portalUrl: 'https://real.example.test', defaults: { otp: '1111', password: 'Pw' }, users: { u1: { phone: '1' } } },
    'integration/shop_db.json': {
      name: 'shop-db', engine: 'sqlserver',
      connection: { serverEnv: 'SHOP_DB_HOST', portEnv: 'SHOP_DB_PORT', databaseEnv: 'SHOP_DB_NAME', userEnv: 'SHOP_DB_USER' },
      queries: [],
    },
    'test/suite1/a.md': SPEC_02,
    '.gitignore': '.env\n',
    '.env': `SHOP_DB_HOST=dbx.test\nSHOP_DB_PORT=1435\nSHOP_DB_NAME=ShopDb\nSHOP_DB_USER=shopqa\nSQLCMDPASSWORD=${SENTINELS.dbpw}\n`,
  });
  const catalogBytes = readText(dir, 'integration/shop_db.json');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] catalog-db-connection/);
  assert.match(r.out, /\[flag\].*shop_db\.json.*connection/);
  const db = readJson(dir, 'environments/qa.json').db;
  assert.strictEqual(db.server, 'dbx.test');
  assert.strictEqual(db.port, 1435);
  assert.strictEqual(db.name, 'ShopDb');
  assert.strictEqual(db.user, 'shopqa');
  assert.deepStrictEqual(db.password, { envSecret: 'SQLCMDPASSWORD' });
  assert.strictEqual(readText(dir, 'integration/shop_db.json'), catalogBytes, 'catalog never rewritten');
  assert.match(readText(dir, '.env'), /^SHOP_DB_HOST=dbx\.test$/m, 'unrecognized env keys stay');
  // untouched existing env values
  const env = readJson(dir, 'environments/qa.json');
  assert.strictEqual(env.portalUrl, 'https://real.example.test');
  assert.strictEqual(env.defaults.otp, '1111');
});

// ── merge semantics: JSON wins over .env ──────────────────────────────────────
test('m03: a filled JSON field wins over a different .env value ([ok] kept existing)', () => {
  const dir = repo({
    'config/project.json': {
      name: 'p', defaultEnvironment: 'qa',
      azure: { org: 'https://dev.azure.com/realorg', project: 'RealProj', team: '', assignee: '' },
      login: { mode: 'session' },
    },
    'environments/qa.json': { portalUrl: 'https://real.example.test', defaults: { otp: '1111', password: 'Pw' }, users: { u1: { phone: '1' } } },
    'test/suite1/a.md': SPEC_02,
    '.gitignore': '.env\n',
    '.env': `AZURE_URL=https://dev.azure.com/otherorg\nQA_TARGET_URL=https://other.example.test\nAZURE_PAT=${SENTINELS.pat}\n`,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[ok\].*kept existing/);
  assert.strictEqual(readJson(dir, 'config/project.json').azure.org, 'https://dev.azure.com/realorg');
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://real.example.test');
  const envFile = readText(dir, '.env');
  assert.ok(!/^AZURE_URL=/m.test(envFile), 'carried-by-precedence key still removed');
  assert.ok(!/^QA_TARGET_URL=/m.test(envFile));
  assert.match(envFile, new RegExp(`^AZURE_PAT=${SENTINELS.pat}$`, 'm'));
});

// ── alias collisions: two legacy names for one field ──────────────────────────
// QA_TARGET_URL / APP_URL / UAT_URL are all portalUrl. When they disagree and the
// JSON field is unset there is no correct guess, and the old per-entry loop made
// one anyway: first line in the file won, the second was reported as "JSON wins"
// and deleted from .env.
function aliasFixture(envLines) {
  return repo({
    'config/project.json': {
      name: 'p', defaultEnvironment: 'qa',
      azure: { org: '', project: '', team: '', assignee: '' },
      login: { mode: 'session' },
    },
    'environments/qa.json': { portalUrl: '', defaults: { otp: '', password: 'Pw' }, users: { u1: { phone: '1' } } },
    'test/suite1/a.md': SPEC_02,
    '.gitignore': '.env\ntest/.auth/\n.playwright-cli/\n',
    '.env': envLines,
  });
}

test('m03: two legacy names disagreeing about one field is a [manual] item, not a coin flip', () => {
  const dir = aliasFixture(
    `QA_TARGET_URL=https://first.example.test\nAPP_URL=https://second.example.test\nAZURE_PAT=${SENTINELS.pat}\n`);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[manual\].*QA_TARGET_URL and APP_URL/);
  assert.match(r.out, /\[stamp\] withheld/, 'an unresolved ambiguity must not be stamped as current');
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, '', 'no value guessed');
  const envFile = readText(dir, '.env');
  assert.match(envFile, /^QA_TARGET_URL=https:\/\/first\.example\.test$/m, 'nothing deleted');
  assert.match(envFile, /^APP_URL=https:\/\/second\.example\.test$/m);
  // Report convention: key names, never values.
  assert.ok(!r.out.includes('first.example.test'), 'the report names keys, not values');
});

test('m03: aliases agreeing on one value are carried once and both lines removed', () => {
  const dir = aliasFixture(`DB_NAME=Shop\nDB_DATABASE=Shop\nQA_TARGET_URL=https://one.example.test\n`);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!/\[manual\]/.test(r.out), 'agreement is not an ambiguity');
  assert.strictEqual(readJson(dir, 'environments/qa.json').db.name, 'Shop');
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://one.example.test');
  const envFile = readText(dir, '.env');
  assert.ok(!/^DB_NAME=/m.test(envFile) && !/^DB_DATABASE=/m.test(envFile), 'both aliases removed');
});

test('m03: once the user resolves the ambiguity, the re-run finishes and stamps', () => {
  const dir = aliasFixture(
    `QA_TARGET_URL=https://first.example.test\nAPP_URL=https://second.example.test\nAZURE_PAT=${SENTINELS.pat}\n`);
  assert.strictEqual(run(dir).code, 0);
  // The user picks: sets the field themselves, exactly as the [manual] item says.
  const env = readJson(dir, 'environments/qa.json');
  env.portalUrl = 'https://second.example.test';
  addFiles(dir, { 'environments/qa.json': env });
  commitAll(dir);
  const r2 = run(dir);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.match(r2.out, /\[ok\].*JSON wins over \.env QA_TARGET_URL, APP_URL/);
  assert.ok(!/\[manual\]/.test(r2.out), 'resolved');
  assert.match(r2.out, /\[stamp\] \.agentex/);
  const envFile = readText(dir, '.env');
  assert.ok(!/^QA_TARGET_URL=/m.test(envFile) && !/^APP_URL=/m.test(envFile), 'both now carried by precedence');
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://second.example.test');
  assert.match(envFile, new RegExp(`^AZURE_PAT=${SENTINELS.pat}$`, 'm'), 'the secret is untouched');
});

// ── idempotence / resumability ────────────────────────────────────────────────
test('double run: second invocation is a zero-write "already up to date" no-op', () => {
  const dir = fixture010();
  assert.strictEqual(run(dir).code, 0);
  const mid = snapshot(dir);
  const r2 = run(dir);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.match(r2.out, /already up to date/i);
  assert.deepStrictEqual(snapshot(dir), mid, 'second run must write nothing');
});

test('interrupted run (JSON written, .env not yet rewritten) converges on re-run', () => {
  // Simulates a kill between m03's JSON writes and its .env rewrite, committed as-is.
  const dir = repo({
    'config/project.json': {
      name: 'demo-shop', defaultEnvironment: 'qa',
      azure: { org: 'https://dev.azure.com/exampleorg', project: 'DemoShop', team: '', assignee: '' },
      kb: { baseUrl: '', project: '' }, login: { mode: 'session' },
    },
    'environments/qa.json': {
      portalUrl: 'https://qa.example.test/ar', defaults: { otp: '0000', password: 'Test@1234' },
      users: { valid_user: { phone: '0550000001', role: 'customer' } },
    },
    'test/suite1/a.md': SPEC_02,
    '.gitignore': '.env\n',
    '.env': `QA_TARGET_URL=https://qa.example.test/ar\nAZURE_URL=https://dev.azure.com/exampleorg\nAZURE_PROJECT=DemoShop\nAZURE_PAT=${SENTINELS.pat}\n`,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  const envFile = readText(dir, '.env');
  assert.ok(!/^QA_TARGET_URL=/m.test(envFile), '.env rewrite completes on re-run');
  assert.ok(!/^AZURE_URL=/m.test(envFile));
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://qa.example.test/ar', 'value survives');
  assert.strictEqual(readJson(dir, 'config/project.json').azure.org, 'https://dev.azure.com/exampleorg');
});

// ── up-to-date paths ──────────────────────────────────────────────────────────
test('current project (fresh scaffold, stamped): "already up to date", zero writes', () => {
  const dir = proj();
  runInit(dir);
  gitInit(dir);
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /already up to date/i);
  assert.deepStrictEqual(snapshot(dir), before);
});

test('older stamp but current conventions: "no migrations needed", stamp refreshed', () => {
  const dir = proj();
  runInit(dir);
  fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.11.0' }, null, 2) + '\n');
  gitInit(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no migrations needed/i);
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED);
  const r2 = run(dir);
  assert.match(r2.out, /already up to date/i);
});

// ── init.js side of the stamp AC ──────────────────────────────────────────────
test('init.js writes the stamp at scaffold time and never moves an existing one', () => {
  const dir = proj();
  runInit(dir);
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED);
  fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.2.0' }, null, 2) + '\n');
  runInit(dir);
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, '0.2.0', 'init must not stamp over an older version');
});

test('init.js withholds the stamp on a legacy project; /update-agentex then migrates and stamps', () => {
  // Legacy signals present (agentex.config.json + legacy .env keys): stamping at
  // scaffold time would make the migrator fast-path the project as up to date.
  const dir = proj({
    'test/suite1/smoke.md': SPEC_02,
    'agentex.config.json': { kb: { baseUrl: 'https://kb.legacy.test', project: 'legacy-kb' } },
    '.gitignore': '.env\n',
    '.env': `QA_TARGET_URL=https://legacy.example.test\nAZURE_PAT=${SENTINELS.pat}\n`,
  });
  runInit(dir);
  assert.ok(!exists(dir, '.agentex/version.json'), 'init must NOT stamp a project with legacy signals');
  gitInit(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] absorb-agentex-config/);
  assert.match(r.out, /\[migrated\] env-split/);
  assert.strictEqual(readJson(dir, 'config/project.json').kb.baseUrl, 'https://kb.legacy.test');
  assert.strictEqual(readJson(dir, 'environments/qc.json').portalUrl, 'https://legacy.example.test');
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED, 'migration stamps at the end');
});

test('init.js stamp gate: each legacy signal alone withholds the stamp', () => {
  const signalFixtures = [
    { '.env': 'DB_SERVER=legacy-db.test\n' },              // legacy ENV_KEY_MAP key in .env
    { 'integrations/a_db.json': { name: 'a', queries: [] } }, // pre-rename catalog folder
    { 'agentex.config.json': { kb: { baseUrl: 'https://kb.x.test' } } }, // KB-era config
  ];
  for (const files of signalFixtures) {
    const dir = proj(files);
    runInit(dir);
    assert.ok(!exists(dir, '.agentex/version.json'),
      `stamp must be withheld for legacy signal: ${Object.keys(files)[0]}`);
  }
});

// ── m09 figma-config — additive scaffold-convention carry ─────────────────────
test('m09: pre-figma project gains the empty figma block and the FIGMA_TOKEN key', () => {
  // A project scaffolded by a pre-0.15 plugin: full current layout, minus figma.
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': { name: 'pre-figma', defaultEnvironment: 'qa', login: { mode: 'session' } },
    'environments/qa.json': { portalUrl: 'https://x.test', defaults: {}, users: { u: {} } },
    '.gitignore': '.env\n',
    '.env': `AZURE_PAT=${SENTINELS.pat}\nSQLCMDPASSWORD=${SENTINELS.dbpw}\n`,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] figma-config/);
  assert.deepStrictEqual(readJson(dir, 'config/project.json').figma,
    { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } });
  const env = readText(dir, '.env');
  assert.match(env, /^FIGMA_TOKEN=$/m, 'FIGMA_TOKEN key appended to .env');
  assert.match(env, new RegExp(`^AZURE_PAT=${SENTINELS.pat}$`, 'm'), 'existing secrets untouched');
});

test('m09: existing figma config and FIGMA_TOKEN value are never rewritten', () => {
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'has-figma', defaultEnvironment: 'qa', login: { mode: 'session' },
      figma: { fileKey: 'MYKEY', token: { envSecret: 'MY_FIGMA_VAR' } },
    },
    'environments/qa.json': { portalUrl: 'https://x.test', defaults: {}, users: { u: {} } },
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=keep-this-value\n',
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(readJson(dir, 'config/project.json').figma,
    { fileKey: 'MYKEY', token: { envSecret: 'MY_FIGMA_VAR' } }, 'user figma block untouched');
  const env = readText(dir, '.env');
  assert.strictEqual(env.match(/^FIGMA_TOKEN=/gm).length, 1, 'no duplicate FIGMA_TOKEN key');
  assert.match(env, /^FIGMA_TOKEN=keep-this-value$/m, 'existing value untouched');
});

test('m09 + init: fresh scaffold carries the figma block and the FIGMA_TOKEN key', () => {
  const dir = proj();
  runInit(dir);
  assert.deepStrictEqual(readJson(dir, 'config/project.json').figma,
    { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } });
  assert.match(readText(dir, '.env'), /^FIGMA_TOKEN=$/m, '.env scaffold keeps the key, blanks the value');
});

// ── m10 phantom-sample-env — consent-gated removal of pristine leftovers ─────
const SAMPLE_ENV = JSON.parse(fs.readFileSync(
  path.join(PLUGIN_ROOT, 'templates', 'environments', 'qc.json'), 'utf8'));

function phantomFixture() {
  return repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'p', defaultEnvironment: 'uat', login: { mode: 'session' },
      figma: { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } },
    },
    'environments/uat.json': { portalUrl: 'https://uat.example.test', defaults: {}, users: { u: { phone: '1' } } },
    'environments/qa.json': SAMPLE_ENV,   // the old scaffold's leftover, historical name
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=\n',
  });
}

test('m10: pristine phantom sample → [manual] offer, file kept, stamp withheld', () => {
  const dir = phantomFixture();
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[manual\].*environments\/qa\.json/);
  assert.match(r.out, /--remove-phantom-sample/, 'the consent instruction is in the message');
  assert.ok(exists(dir, 'environments/qa.json'), 'never deleted without explicit consent');
  assert.ok(!exists(dir, '.agentex/version.json'), 'stamp withheld while the phantom remains');
});

test('m10: consented re-run with --remove-phantom-sample deletes the phantom and stamps', () => {
  const dir = phantomFixture();
  run(dir);                    // [manual] offer
  commitAll(dir);              // clean-tree guard: commit run-1 output first
  const r = run(dir, '--remove-phantom-sample');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] phantom-sample-env/);
  assert.ok(!exists(dir, 'environments/qa.json'), 'phantom removed on consent');
  assert.strictEqual(readJson(dir, 'environments/uat.json').portalUrl, 'https://uat.example.test',
    'the user environment is untouched');
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED, 'stamped once resolved');
});

test('m10: a lone pristine sample on an unconfigured project is legitimate scaffolding', () => {
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'my-project', defaultEnvironment: 'qc', login: { mode: 'session' },
      figma: { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } },
    },
    'environments/qc.json': SAMPLE_ENV,
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=\n',
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!r.out.includes('phantom-sample-env'), 'not flagged');
  assert.ok(exists(dir, 'environments/qc.json'), 'sample kept');
});

test('m10: a claimed file (any value changed) is the user\'s — never flagged', () => {
  const dir = phantomFixture();
  const claimed = JSON.parse(JSON.stringify(SAMPLE_ENV));
  claimed.portalUrl = 'https://claimed.example.test';
  addFiles(dir, { 'environments/qa.json': claimed });
  commitAll(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!r.out.includes('phantom-sample-env'), 'user-touched file is not a phantom');
  assert.ok(exists(dir, 'environments/qa.json'));
});

// ── m11 user-field-schema — additive built-ins backfill (design #4) ──────────
const TPL_PROJECT = JSON.parse(fs.readFileSync(
  path.join(PLUGIN_ROOT, 'templates', 'config', 'project.json'), 'utf8'));
const { LEGACY_DEFAULTS_FIELDS } = require('./wizard/engine.js');

test('m11: pre-field-schema project gains the built-in arrays; environment files byte-identical', () => {
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'pre-fields', defaultEnvironment: 'qa', login: { mode: 'session' },
      figma: { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } },
    },
    'environments/qa.json': {
      portalUrl: 'https://x.test', defaults: { otp: '1111', password: 'Pw' },
      users: { u: { phone: '1', custom: 'hand-added' } },
    },
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=\n',
  });
  const before = snapshot(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] user-field-schema/);
  const proj = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(proj.userFields, TPL_PROJECT.userFields,
    'built-in userFields backfilled from the template — semantics-preserving');
  // Decision A-2: the template's password descriptor is secret now, but this
  // project's environment holds the plain literal the old wizard wrote — m11
  // backfills the FROZEN legacy plain set, never the current template.
  assert.deepStrictEqual(proj.defaultsFields, LEGACY_DEFAULTS_FIELDS);
  assert.ok(!proj.defaultsFields.find(f => f.key === 'password').secret, 'the legacy plain descriptor');
  assert.strictEqual(proj.name, 'pre-fields', 'existing config values untouched');
  const after = snapshot(dir);
  assert.deepStrictEqual(subset(after, 'environments/'), subset(before, 'environments/'),
    'm11 never touches environment files or values');
});

test('m11: existing field arrays are never rewritten (customized schema wins)', () => {
  const customUsers = [{ key: 'userId', label: 'User ID', type: 'text' }];
  const customDefaults = [{ key: 'password', label: 'pw', default: 'X' }];
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'customized', defaultEnvironment: 'qa', login: { mode: 'session' },
      figma: { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } },
      userFields: customUsers, defaultsFields: customDefaults,
    },
    'environments/qa.json': { portalUrl: 'https://x.test', defaults: {}, users: { u: { userId: 'U-1' } } },
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=\n',
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!r.out.includes('[migrated] user-field-schema'), 'nothing to backfill — not detected');
  const proj = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(proj.userFields, customUsers, 'user-customized schema untouched');
  assert.deepStrictEqual(proj.defaultsFields, customDefaults);
});

test('m11: only the missing array is added when one is already present', () => {
  const customUsers = [{ key: 'userId', label: 'User ID' }];
  const dir = repo({
    'test/suite1/a.md': SPEC_02,
    'config/project.json': {
      name: 'half', defaultEnvironment: 'qa', login: { mode: 'session' },
      figma: { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } },
      userFields: customUsers,
    },
    'environments/qa.json': { portalUrl: 'https://x.test', defaults: {}, users: { u: { userId: '1' } } },
    '.gitignore': '.env\n',
    '.env': 'FIGMA_TOKEN=\n',
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] user-field-schema/);
  const proj = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(proj.userFields, customUsers, 'the present array is never rewritten');
  assert.deepStrictEqual(proj.defaultsFields, LEGACY_DEFAULTS_FIELDS, 'the missing one is backfilled (frozen legacy set, A-2)');
});

test('m11 + init: fresh scaffold carries the field arrays from the template', () => {
  const dir = proj();
  runInit(dir);
  const projCfg = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(projCfg.userFields, TPL_PROJECT.userFields);
  assert.deepStrictEqual(projCfg.defaultsFields, TPL_PROJECT.defaultsFields);
});

// ── m05 gitignore-secrets ─────────────────────────────────────────────────────
// A saved optimize-login session (test/.auth/<app>-<env>-state.json) and the
// playwright-cli scratch profile both hold a live session, and the docs called
// test/.auth/ "gitignored by convention" while nothing ever wrote the entry.
const AUTH_STATE = 'test/.auth/demo-qc-state.json';

test('m05: a project ignoring only .env gains the session and scratch entries', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    '.gitignore': 'node_modules/\n.env\n',
    '.env': `AZURE_PAT=${SENTINELS.pat}\n`,
  });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] gitignore-secrets/);
  const gi = readText(dir, '.gitignore');
  assert.match(gi, /^test\/\.auth\/$/m, 'saved sessions ignored');
  assert.match(gi, /^\.playwright-cli\/$/m, 'browser scratch ignored');
  assert.match(gi, /^node_modules\/$/m, 'the project\'s own entries are kept');
  assert.strictEqual(gi.match(/^\.env$/gm).length, 1, '.env not duplicated');
});

test('m05: a project with no .gitignore gets one covering all three', () => {
  const dir = repo({ 'test/suite1/smoke.md': SPEC_02, '.env': 'AZURE_PAT=\n' });
  assert.ok(!exists(dir, '.gitignore'));
  assert.strictEqual(run(dir).code, 0);
  const gi = readText(dir, '.gitignore');
  for (const line of ['.env', 'test/.auth/', '.playwright-cli/', 'test/.ui-baselines/', '.agentex/cache/']) {
    assert.match(gi, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(gi, /^# AgenTeX/m, 'the block says why these lines are there');
  assert.match(gi, /^# and this one is only a cache/m, 'the cache line is not filed under credentials');
});

test('m05: entries already covered under another spelling are not rewritten', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    '.gitignore': '*.env\n.auth/\n.playwright-cli\n.ui-baselines/\n.agentex/\n',
    '.env': 'AZURE_PAT=\n',
  });
  const before = readText(dir, '.gitignore');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!/\[migrated\] gitignore-secrets/.test(r.out), 'nothing to migrate');
  assert.strictEqual(readText(dir, '.gitignore'), before, 'byte-identical');
});

test('m05: the documented commit opt-in (!.agentex/cache/) is never re-ignored over', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    '.gitignore': '.env\ntest/.auth/\n.playwright-cli/\ntest/.ui-baselines/\n!.agentex/cache/\n.agentex/scratch/\n',
    '.env': 'AZURE_PAT=\n',
  });
  const before = readText(dir, '.gitignore');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!/\[migrated\] gitignore-secrets/.test(r.out), 'the opt-in counts as covered');
  assert.strictEqual(readText(dir, '.gitignore'), before, 'the user\'s opt-in line survives untouched');
});

test('m05: re-running adds nothing — and an ignored session file stays untracked', () => {
  const dir = repo({
    'test/suite1/smoke.md': SPEC_02,
    '.gitignore': '.env\n',
    '.env': 'AZURE_PAT=\n',
  });
  assert.strictEqual(run(dir).code, 0);
  commitAll(dir);
  const once = readText(dir, '.gitignore');
  assert.strictEqual(run(dir).code, 0);
  assert.strictEqual(readText(dir, '.gitignore'), once, 'idempotent — no duplicate entries');
  // The point of the entry: git must not see a saved session as a file to commit.
  addFiles(dir, { [AUTH_STATE]: '{"cookies":[{"name":"auth","value":"live-token"}]}\n' });
  assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '', 'saved session is ignored by git');
});

test('m05 + init: fresh scaffold gitignores sessions and scratch, not just .env', () => {
  const dir = proj();
  runInit(dir);
  const gi = readText(dir, '.gitignore');
  assert.match(gi, /^\.env$/m);
  assert.match(gi, /^test\/\.auth\/$/m);
  assert.match(gi, /^\.playwright-cli\/$/m);
});

// ── m12 qa-records-and-workflow — the plugin-owned config blocks (R6) ────────
// A 0.22/0.23-shaped project: today's full scaffold, but config/project.json
// predates the two plugin blocks and its provider block has no workflow.
// Every expectation reads STRUCTURED_DEFAULTS — the default QA watchlist paths
// live only in that constant.
const { STRUCTURED_DEFAULTS: SD, withPluginConfigBlocks } = require('./lib/project_config.js');
const M12 = require('./migrations/12-qa-records-and-workflow.js');
const PLUGIN_BLOCKS = ['testDesign', 'qaRecords'];
const QA_FOLDER = path.posix.dirname(SD.qaRecords.pendingQuestions);
const AZ_BLOCK = { org: 'https://dev.azure.com/exampleorg', project: 'Sample Project', team: 'QA Team', assignee: '' };
const JI_BLOCK = { site: 'example', project: 'PROJ', board: '42', assignee: '' };

function preOneZero(configExtra = {}, { omit = PLUGIN_BLOCKS } = {}) {
  const dir = proj();
  runInit(dir);
  const cfg = readJson(dir, 'config/project.json');
  for (const k of omit) delete cfg[k];
  Object.assign(cfg, configExtra);
  addFiles(dir, {
    'config/project.json': cfg,
    // the user's own environment (not the pristine sample), and their spec
    'environments/qc.json': { ...readJson(dir, 'environments/qc.json'), portalUrl: 'https://app.example.test' },
    'test/suite1/mine.md': SPEC_02,
    '.agentex/version.json': { version: '0.22.1' },
    '.env': `${readText(dir, '.env')}AZURE_PAT=${SENTINELS.pat}\n`,
  });
  gitInit(dir);
  return dir;
}
function m12ctx(dir) {
  const lines = [];
  return {
    projectRoot: dir, pluginRoot: PLUGIN_ROOT, lines,
    templates: { project: TPL_PROJECT },
    saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); },
    report: {
      migrated: (id, d) => lines.push(`[migrated] ${id} — ${d}`),
      flag: (m) => lines.push(`[flag] ${m}`), ok: (m) => lines.push(`[ok] ${m}`), manual: (m) => lines.push(`[manual] ${m}`),
    },
  };
}

test('m12: a pre-1.0 ADO project gains the two blocks and azure.workflow; only config/project.json changes; no watchlist file', () => {
  const dir = preOneZero({ azure: { ...AZ_BLOCK } });
  const beforeCfg = readJson(dir, 'config/project.json');
  const before = snapshot(dir);
  assert.strictEqual(M12.detect(m12ctx(dir)), true, 'detect is true on a pre-1.0 config');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^\[migrated\] qa-records-and-workflow — /m);
  const cfg = readJson(dir, 'config/project.json');
  for (const k of PLUGIN_BLOCKS) assert.deepStrictEqual(cfg[k], SD[k], `${k} added from the defaults`);
  assert.ok(!('testingTasks' in cfg) && !('estimation' in cfg), 'decision #13: no task list or estimation paths in project.json');
  assert.deepStrictEqual(cfg.azure, { ...AZ_BLOCK, workflow: SD.workflow }, 'azure keeps its keys and gains the EMPTY workflow');
  assert.ok(!('jira' in cfg), 'never creates a provider block');
  assert.ok(!('reproSummaryRow' in cfg.azure), 'reproSummaryRow is never written');
  assert.deepStrictEqual(Object.keys(cfg), [...Object.keys(beforeCfg), ...PLUGIN_BLOCKS], 'key order kept; new blocks appended');
  for (const k of Object.keys(beforeCfg)) if (k !== 'azure') assert.deepStrictEqual(cfg[k], beforeCfg[k], `${k} untouched`);
  const after = snapshot(dir);
  const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f]).sort();
  assert.deepStrictEqual(changed, ['.agentex/version.json', 'config/project.json'], 'environments, specs and .env are never touched');
  assert.ok(!exists(dir, QA_FOLDER), 'no QA watchlist folder or file is created (lazy)');
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED);
  assert.strictEqual(M12.detect(m12ctx(dir)), false, 'a second detect is false');
});

test('m12: a second run is a zero-write no-op', () => {
  const dir = preOneZero({ azure: { ...AZ_BLOCK } });
  assert.strictEqual(run(dir).code, 0);
  commitAll(dir);
  fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.22.1' }, null, 2) + '\n');
  commitAll(dir);
  const mid = snapshot(dir);
  const r2 = run(dir);
  assert.strictEqual(r2.code, 0, r2.out);
  assert.ok(!r2.out.includes('[migrated]'), `nothing left to migrate:\n${r2.out}`);
  assert.match(r2.out, /no migrations needed/i);
  const after = snapshot(dir);
  assert.deepStrictEqual(subset(after, 'config/'), subset(mid, 'config/'), 'config byte-identical on the second run');
});

test('m12: customized blocks are preserved; only the missing ones are added', () => {
  const custom = {
    azure: { ...AZ_BLOCK, areaPath: 'Sample Project\\QA', workflow: { inTestState: 'In QA', devDoneStates: ['Dev Complete'], closeOut: { state: 'Accepted' } } },
    testDesign: { approval: 'per-story' },
  };
  const dir = preOneZero(JSON.parse(JSON.stringify(custom)));
  const beforeCfg = readJson(dir, 'config/project.json');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] qa-records-and-workflow/);
  const cfg = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(cfg.azure, custom.azure, 'a customized workflow is never rewritten');
  assert.deepStrictEqual(cfg.testDesign, custom.testDesign, 'a customized testDesign is never rewritten');
  assert.deepStrictEqual(cfg.qaRecords, SD.qaRecords, 'the missing block is added');
  assert.deepStrictEqual(Object.keys(cfg), [...Object.keys(beforeCfg), 'qaRecords'], 'key order kept');
  for (const k of Object.keys(beforeCfg)) assert.deepStrictEqual(cfg[k], beforeCfg[k], `pre-existing ${k} parsed-equal`);
});

test('m12: a Jira project gets jira.workflow and no azure key', () => {
  const dir = preOneZero({ jira: { ...JI_BLOCK } });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  const cfg = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(cfg.jira, { ...JI_BLOCK, workflow: SD.workflow });
  assert.ok(!('azure' in cfg), 'no azure block, so no azure.workflow');
  for (const k of PLUGIN_BLOCKS) assert.deepStrictEqual(cfg[k], SD[k]);
});

test('m12: a tracker-less project gets the two blocks and no provider key', () => {
  const dir = preOneZero({});
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] qa-records-and-workflow/);
  const cfg = readJson(dir, 'config/project.json');
  assert.ok(!('azure' in cfg) && !('jira' in cfg), 'no provider block is created');
  for (const k of PLUGIN_BLOCKS) assert.deepStrictEqual(cfg[k], SD[k]);
  const all = preOneZero({}, { omit: [] });
  assert.strictEqual(M12.detect(m12ctx(all)), false, 'both present + no tracker: nothing to do');
});

test('m12: two provider blocks are left alone and flagged; the top-level blocks are still added', () => {
  const dir = preOneZero({ azure: { ...AZ_BLOCK }, jira: { ...JI_BLOCK } });
  const ctx = m12ctx(dir);
  assert.strictEqual(M12.detect(ctx), true);
  M12.apply(ctx);
  const cfg = readJson(dir, 'config/project.json');
  assert.deepStrictEqual(cfg.azure, AZ_BLOCK, 'azure untouched');
  assert.deepStrictEqual(cfg.jira, JI_BLOCK, 'jira untouched');
  for (const k of PLUGIN_BLOCKS) assert.deepStrictEqual(cfg[k], SD[k]);
  assert.ok(ctx.lines.some((l) => /^\[flag\] .*more than one tracker block.*wizard/i.test(l)), ctx.lines.join('\n'));
  assert.ok(ctx.lines.some((l) => l.startsWith('[migrated] qa-records-and-workflow')));
  assert.strictEqual(M12.detect(m12ctx(dir)), false, 'nothing more m12 may do — two blocks are the wizard\'s to fix');
});

test('m12: an unreadable or absent config/project.json is not this migration\'s business', () => {
  const dir = proj({ 'config/project.json': '{ "name": "broken", ' });
  const ctx = m12ctx(dir);
  assert.strictEqual(M12.detect(ctx), false);
  assert.strictEqual(readText(dir, 'config/project.json'), '{ "name": "broken", ');
  assert.strictEqual(M12.detect(m12ctx(proj())), false, 'absent: m07 scaffolds it from the template');
});

test('m12: detect is true when only the provider block lacks workflow', () => {
  const dir = preOneZero({ azure: { ...AZ_BLOCK } }, { omit: [] });
  const ctx = m12ctx(dir);
  assert.strictEqual(M12.detect(ctx), true);
  M12.apply(ctx);
  assert.deepStrictEqual(readJson(dir, 'config/project.json').azure.workflow, SD.workflow);
  assert.ok(ctx.lines.some((l) => /azure\.workflow/.test(l)), ctx.lines.join('\n'));
  assert.strictEqual(M12.detect(m12ctx(dir)), false);
});

test('m12 uses the ONE shared function: apply == withPluginConfigBlocks on the parsed config', () => {
  for (const extra of [{ azure: { ...AZ_BLOCK } }, { jira: { ...JI_BLOCK } }, {}, { azure: { ...AZ_BLOCK }, jira: { ...JI_BLOCK } }]) {
    const dir = preOneZero(extra);
    const want = withPluginConfigBlocks(readJson(dir, 'config/project.json'));
    M12.apply(m12ctx(dir));
    assert.deepStrictEqual(readJson(dir, 'config/project.json'), want, JSON.stringify(Object.keys(extra)));
  }
});

test('migrations 01→12 chain on a 0.10-era project: m12 applies after m11, the stamp moves, a second run is a no-op', () => {
  const dir = fixture010();
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  const ids = [...r.out.matchAll(/^\[migrated\] ([\w-]+)/gm)].map((m) => m[1]);
  assert.strictEqual(ids[ids.length - 1], 'qa-records-and-workflow', `m12 runs last: ${ids.join(', ')}`);
  const order = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => /^\d{2}-.*\.js$/.test(f)).sort()
    .map((f) => require(path.join(__dirname, 'migrations', f)).id);
  assert.strictEqual(order[order.length - 1], 'qa-records-and-workflow');
  assert.strictEqual(order.length, 12, 'twelve migrations, 01→12');
  const pos = ids.map((id) => order.indexOf(id));
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b), 'applied in file order');
  const cfg = readJson(dir, 'config/project.json');
  for (const k of PLUGIN_BLOCKS) assert.deepStrictEqual(cfg[k], SD[k]);
  assert.deepStrictEqual(cfg.azure.workflow, SD.workflow, 'the carried azure block gains the empty workflow');
  assert.strictEqual(readJson(dir, '.agentex/version.json').version, INSTALLED);
  assert.ok(!exists(dir, QA_FOLDER), 'no QA watchlist file appears through the chain');
  commitAll(dir);
  const mid = snapshot(dir);
  const r2 = run(dir);
  assert.match(r2.out, /already up to date/i);
  assert.deepStrictEqual(snapshot(dir), mid);
});

// AC E: a fresh /init-test project + its first wizard save, and a pre-1.0
// project + /update-agentex, end with IDENTICAL new config keys — for no
// tracker, ADO and Jira. The fresh side is the template copy plus what the
// browser sends (the on-disk project + the chosen provider's managed keys),
// written through the server's save seeding (withPluginConfigBlocks — the call
// /api/save makes; server.test.js pins that round-trip over HTTP).
test('fresh vs migrated (×3: none, ADO, Jira): identical new config keys; no QA watchlist file on either side', () => {
  const NEW_KEYS = (cfg) => {
    const out = {};
    for (const k of PLUGIN_BLOCKS) out[k] = cfg[k];
    for (const p of ['azure', 'jira']) if (cfg[p]) out[`${p}.workflow`] = cfg[p].workflow;
    return out;
  };
  for (const [label, provider] of [['no tracker', {}], ['ADO', { azure: { ...AZ_BLOCK } }], ['Jira', { jira: { ...JI_BLOCK } }]]) {
    const fresh = proj();
    runInit(fresh);
    const browserSends = { ...readJson(fresh, 'config/project.json'), ...JSON.parse(JSON.stringify(provider)) };
    addFiles(fresh, { 'config/project.json': withPluginConfigBlocks(browserSends) });
    const migrated = preOneZero(JSON.parse(JSON.stringify(provider)));
    const r = run(migrated);
    assert.strictEqual(r.code, 0, `${label}: ${r.out}`);
    const f = NEW_KEYS(readJson(fresh, 'config/project.json'));
    const m = NEW_KEYS(readJson(migrated, 'config/project.json'));
    assert.deepStrictEqual(m, f, `${label}: fresh and migrated agree`);
    assert.deepStrictEqual(Object.keys(f).sort(), [...PLUGIN_BLOCKS, ...Object.keys(provider).map((p) => `${p}.workflow`)].sort(), `${label}: the expected keys`);
    for (const dir of [fresh, migrated]) {
      assert.ok(!exists(dir, QA_FOLDER), `${label}: QA watchlist files are created on first use only — same on both sides`);
    }
  }
});

// The agent scratch location (.agentex/scratch/) reaches existing projects through
// m05's state detection — no new migration; on a stamped project it arrives with
// the next version bump.
const GI_BEFORE_SCRATCH = 'node_modules/\n.env\ntest/.auth/\n.playwright-cli/\ntest/.ui-baselines/\n.agentex/cache/\nmy-notes/\n';

test('m05: a project stamped at an older version gains ONLY .agentex/scratch/, order kept, re-run unchanged', () => {
  const dir = proj();
  runInit(dir);
  addFiles(dir, { '.gitignore': GI_BEFORE_SCRATCH, '.agentex/version.json': JSON.stringify({ version: '0.23.0' }) + '\n' });
  gitInit(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\] gitignore-secrets — \.gitignore — \.agentex\/scratch\/ appended/);
  const gi = readText(dir, '.gitignore');
  assert.ok(gi.startsWith(GI_BEFORE_SCRATCH), 'existing lines and their order untouched');
  assert.deepStrictEqual(gi.slice(GI_BEFORE_SCRATCH.length).split('\n').filter(l => l && !l.startsWith('#')), ['.agentex/scratch/']);
  commitAll(dir);
  fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.23.0' }) + '\n');
  commitAll(dir);
  run(dir);
  assert.strictEqual(readText(dir, '.gitignore'), gi, 'second run changes nothing');
});

test('m05: an equivalent spelling or a deliberate un-ignore of the scratch location is left unchanged', () => {
  for (const line of ['.agentex/scratch', '!.agentex/scratch/']) {
    const dir = proj();
    runInit(dir);
    addFiles(dir, { '.gitignore': GI_BEFORE_SCRATCH + line + '\n', '.agentex/version.json': JSON.stringify({ version: '0.23.0' }) + '\n' });
    gitInit(dir);
    const before = readText(dir, '.gitignore');
    const r = run(dir);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!/\[migrated\] gitignore-secrets/.test(r.out), line);
    assert.strictEqual(readText(dir, '.gitignore'), before, `${line}: byte-identical`);
  }
});

// ── optional pre-commit secret-scan hook: an offer or a consented install ─────
// Runs before the version fast path (so a stamped project gets it), never a
// migration, never touches the report counters or the stamp.
const HOOK_FILE = '.git/hooks/pre-commit';
function stampedCurrent() {
  const dir = proj();
  runInit(dir);
  gitInit(dir);
  return dir;
}

test('[hook] offer on a project stamped at the installed version (fast path); stamp unchanged, nothing installed', () => {
  const dir = stampedCurrent();
  const stamp = readText(dir, '.agentex/version.json');
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^\[hook\] offer .*--install-pre-commit-hook/m);
  assert.match(r.out, /already up to date/i);
  assert.strictEqual(readText(dir, '.agentex/version.json'), stamp);
  assert.ok(!exists(dir, HOOK_FILE), 'no flag → never installs');
});

test('--install-pre-commit-hook on a stamped project → installed, still "already up to date", exit 0', () => {
  const dir = stampedCurrent();
  const r = run(dir, '--install-pre-commit-hook');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^\[hook\] installed \(/m);
  assert.match(r.out, /already up to date/i);
  assert.match(readText(dir, HOOK_FILE), /agentex-pre-commit-hook v1/);
  const again = run(dir, '--install-pre-commit-hook');
  assert.match(again.out, /^\[hook\] already installed/m);
  assert.match(run(dir).out, /^\[hook\] installed/m, 'no offer once it is in place');
});

test('[hook] an existing foreign hook is left untouched, with the docs pointer', () => {
  const dir = stampedCurrent();
  addFiles(dir, { [HOOK_FILE]: '#!/bin/sh\necho mine\n' });
  const r = run(dir, '--install-pre-commit-hook');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^\[hook\] existing hook left untouched.*#calling-the-scan-from-an-existing-hook/m);
  assert.strictEqual(readText(dir, HOOK_FILE), '#!/bin/sh\necho mine\n');
});

test('[hook] on a migrating project: the consent install never changes [manual] counts or the stamp', () => {
  const a = fixture010();
  const b = fixture010();
  const plain = run(a);
  const consented = run(b, '--install-pre-commit-hook');
  assert.strictEqual(plain.code, 0, plain.out);
  assert.strictEqual(consented.code, plain.code);
  const strip = (out, dir) => out.split('\n').filter(l => !l.startsWith('[hook]')).join('\n').split(dir).join('<dir>');
  assert.strictEqual(strip(consented.out, b), strip(plain.out, a), 'identical report apart from the [hook] line');
  assert.strictEqual(readJson(b, '.agentex/version.json').version, INSTALLED);
  assert.ok(exists(b, HOOK_FILE) && !exists(a, HOOK_FILE));
});

// ── config/estimation.json — created only by an approved estimation run ──────
// No migration and no scaffold step creates it; once it exists, /update-agentex
// and an /init-test re-run leave it byte-identical (invariant 11).
const ESTIMATION = 'config/estimation.json';
const ESTIMATION_BYTES = '{\n  "schemaVersion": 1,\n  "tasks": [\n    { "name": "Requirement Review", "enabled": true, "minHours": 0.5, "maxHours": 2 }\n  ],\n' +
  '  "factors": { "Scenarios / ACs": 1 },\n  "source": { "kind": "history", "sprints": 2, "note": "hand-edited" }\n}\n';

test('estimation file: a legacy-era project migrates with no config/estimation.json created', () => {
  const dir = fixture010();
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[migrated\]/);
  assert.ok(!exists(dir, ESTIMATION), 'no migration creates the estimation file');
});

test('estimation file: a project on the previous release\'s conventions migrates with no config/estimation.json created', () => {
  const dir = proj();
  runInit(dir);
  fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.22.0' }, null, 2) + '\n');
  gitInit(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!exists(dir, ESTIMATION), 'neither a fresh scaffold nor a migration creates it');
});

test('estimation file: an existing config/estimation.json is byte-identical across /update-agentex and an /init-test re-run', () => {
  const dir = fixture010();
  addFiles(dir, { [ESTIMATION]: ESTIMATION_BYTES });
  commitAll(dir);
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(readText(dir, ESTIMATION), ESTIMATION_BYTES, 'migrate leaves it byte-identical');
  commitAll(dir);
  runInit(dir);
  assert.strictEqual(readText(dir, ESTIMATION), ESTIMATION_BYTES, 'an /init-test re-run leaves it byte-identical');
  const fresh = proj({ [ESTIMATION]: ESTIMATION_BYTES });
  runInit(fresh);
  gitInit(fresh);
  fs.writeFileSync(path.join(fresh, '.agentex', 'version.json'), JSON.stringify({ version: '0.22.0' }, null, 2) + '\n');
  commitAll(fresh);
  assert.strictEqual(run(fresh).code, 0);
  assert.strictEqual(readText(fresh, ESTIMATION), ESTIMATION_BYTES);
});

// ── secrecy ───────────────────────────────────────────────────────────────────
test('no secret value ever appears in any migration output', () => {
  assert.ok(ALL_OUTPUT.length > 0, 'outputs were collected');
  const all = ALL_OUTPUT.join('\n');
  for (const [name, value] of Object.entries(SENTINELS)) {
    assert.ok(!all.includes(value), `sentinel secret "${name}" leaked into output`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
