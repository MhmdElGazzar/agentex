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

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [MIGRATE, dir], { encoding: 'utf8' });
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

  const env = readJson(dir, 'environments/qa.json');
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
  for (const p of ['config/project.json', 'environments/qa.json', '.agentex/version.json', '.gitignore', 'CLAUDE.md']) {
    assert.ok(exists(dir, p), `migrated project should have ${p}`);
    assert.ok(exists(fresh, p), `fresh scaffold should have ${p}`);
  }
  assert.ok(fs.statSync(path.join(dir, 'executions')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'integration')).isDirectory());
  assert.deepStrictEqual(
    Object.keys(readJson(dir, 'config/project.json')).sort(),
    Object.keys(readJson(fresh, 'config/project.json')).sort(), 'project.json schema');
  assert.deepStrictEqual(
    Object.keys(readJson(dir, 'environments/qa.json')).sort(),
    Object.keys(readJson(fresh, 'environments/qa.json')).sort(), 'environment schema');
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
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://old.example.test');
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
  const env = readJson(dir, 'environments/qa.json');
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
  assert.strictEqual(readJson(dir, 'environments/qa.json').portalUrl, 'https://legacy.example.test');
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
