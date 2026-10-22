'use strict';
// Unit tests for the shared scaffold library. Run: node scripts/lib/scaffold.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scaffold = require('./scaffold.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Fresh throwaway project dir per test, with optional files.
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const TEMPLATE_ENV = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'environments', 'qc.json'), 'utf8'));

// ---- hasEnvFiles ----
test('hasEnvFiles: false without environments/, false for non-json content, true for any env json', () => {
  assert.strictEqual(scaffold.hasEnvFiles(proj()), false);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/notes.txt': 'x' })), false);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/uat.json': {} })), true);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/qc.json': {} })), true);
});

// ---- conditional sample copy ----
test('fresh scaffold creates the sample environment under the default name qc', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.deepStrictEqual(readJson(dir, 'environments/qc.json'), TEMPLATE_ENV);
});

test('sample environment is NOT copied when any environment file already exists', () => {
  const dir = proj({ 'environments/uat.json': { portalUrl: 'https://uat.example' } });
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.ok(!fs.existsSync(path.join(dir, 'environments', 'qc.json')),
    'sample must not be injected next to an existing environment');
  const skip = actions.find(a => a.path === 'environments' && a.kind === 'skipped');
  assert.ok(skip, 'the decision is reported as a skipped action');
});

test('re-run after a wizard save under another name does not re-inject the sample', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  // wizard saved "uat" and the pristine sample was reconciled away
  fs.writeFileSync(path.join(dir, 'environments', 'uat.json'), '{"portalUrl":"https://uat.example"}');
  fs.unlinkSync(path.join(dir, 'environments', 'qc.json'));
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.ok(!fs.existsSync(path.join(dir, 'environments', 'qc.json')),
    're-scaffold must not resurrect the sample');
});

test('dryRun reports the sample copy without writing anything', () => {
  const dir = proj();
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT, { dryRun: true });
  assert.ok(actions.some(a => a.kind === 'created' && a.path === 'environments/qc.json'));
  assert.ok(!fs.existsSync(path.join(dir, 'environments')), 'dryRun must not write');
});

// ---- .gitignore: the agent scratch location, and nothing broader ----
const PRIOR_ENTRIES = ['.env', 'test/.auth/', '.playwright-cli/', 'test/.ui-baselines/', '.agentex/cache/'];
function checkIgnored(dir, rel) {
  const { spawnSync } = require('node:child_process');
  return spawnSync('git', ['-C', dir, 'check-ignore', '-q', '--no-index', rel]).status === 0;
}
function scaffoldedRepo() {
  const { execFileSync } = require('node:child_process');
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}

test('a fresh scaffold ignores the agent scratch location .agentex/scratch/', () => {
  const dir = scaffoldedRepo();
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.agentex\/scratch\/$/m);
  assert.strictEqual(checkIgnored(dir, '.agentex/scratch/x.json'), true);
  assert.strictEqual(checkIgnored(dir, '.agentex/scratch/cases.json'), true);
});

test('the prior entries are unchanged and in order; the scratch entry is appended last', () => {
  assert.deepStrictEqual(scaffold.GITIGNORE_ENTRIES.map(e => e.entry), [...PRIOR_ENTRIES, '.agentex/scratch/']);
  const lines = fs.readFileSync(path.join(scaffoldedRepo(), '.gitignore'), 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'));
  assert.deepStrictEqual(lines, [...PRIOR_ENTRIES, '.agentex/scratch/']);
});

test('the entries stay narrow: committed plugin files, qa-watchlist, .claude and executions are never ignored', () => {
  const dir = scaffoldedRepo();
  for (const rel of ['.agentex/version.json', '.agentex/test-template.md', '.agentex/task-estimation.json',
    '.agentex/estimation-history.jsonl', 'qa-watchlist/a.md', '.claude/settings.json', 'executions/', 'executions/x/report.md']) {
    assert.strictEqual(checkIgnored(dir, rel), false, `${rel} must not be ignored`);
  }
  const entries = scaffold.GITIGNORE_ENTRIES.map(e => e.entry);
  for (const whole of ['.agentex/', '.agentex', '.claude/', '.claude', '/.agentex/', '/.claude/']) {
    assert.ok(!entries.includes(whole), `no entry ignores ${whole} as a whole`);
  }
  for (const harness of ['.claude/worktrees/', '.claude/settings.local.json']) {
    assert.ok(!entries.includes(harness), `${harness} is a docs recommendation, not a scaffold entry`);
  }
});

test('the scratch entry: an equivalent spelling or a deliberate un-ignore counts as covered', () => {
  for (const line of ['.agentex/scratch', '/.agentex/scratch/', '.agentex/', '!.agentex/scratch/', '!/.agentex/scratch']) {
    const dir = proj({ '.gitignore': `${PRIOR_ENTRIES.join('\n')}\n${line}\n` });
    assert.deepStrictEqual(scaffold.gitignoreMissing(dir), [], line);
    const before = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    scaffold.ensureGitignore(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), before, `${line}: byte-identical`);
  }
});

// ---- pristine sample-environment detection ----
// The shape the qa-era scaffold shipped (plugin <= 0.16.x, templates/environments/qa.json).
const QA_ERA_SAMPLE = {
  portalUrl: 'https://example.com',
  defaults: { otp: '0000', password: 'Test@1234' },
  users: {
    valid_user: { phone: '0550000001', role: 'customer' },
    expired_user: { phone: '0550000002', notes: 'for negative login scenarios' },
  },
  db: {
    server: 'localhost', port: 1433, name: 'my-database', user: 'qa_user',
    password: { envSecret: 'SQLCMDPASSWORD' },
  },
  api: { baseUrl: 'https://jsonplaceholder.typicode.com', token: { envSecret: 'API_TOKEN' } },
};

test('isPristineSampleEnv: current template and the historical qa-era shape are pristine', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(TEMPLATE_ENV, PLUGIN_ROOT), true);
  assert.strictEqual(scaffold.isPristineSampleEnv(QA_ERA_SAMPLE, PLUGIN_ROOT), true);
});

// The shape main shipped briefly after PR #24 (mobile testing): the sample qc.json carried a
// placeholder `mobile` block. Projects scaffolded then still have it, untouched.
const WITH_MOBILE_PLACEHOLDER_SAMPLE = {
  ...QA_ERA_SAMPLE,
  mobile: {
    platformName: 'Android', automationName: 'UiAutomator2',
    app: '/absolute/path/to/app.apk', deviceName: 'emulator-5554',
  },
};

test('the sample environment has no mobile block: mobile is opt-in', () => {
  assert.ok(!('mobile' in TEMPLATE_ENV), 'templates/environments/qc.json must not scaffold a mobile block');
});

test('isPristineSampleEnv: the with-mobile-placeholder sample shipped after PR #24 is still pristine', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(WITH_MOBILE_PLACEHOLDER_SAMPLE, PLUGIN_ROOT), true);
  const touched = JSON.parse(JSON.stringify(WITH_MOBILE_PLACEHOLDER_SAMPLE));
  touched.mobile.app = '/Users/me/real.apk';
  assert.strictEqual(scaffold.isPristineSampleEnv(touched, PLUGIN_ROOT), false);
});

test('isPristineSampleEnv: structural comparison — key order and whitespace do not matter', () => {
  const reordered = JSON.parse(JSON.stringify({
    api: TEMPLATE_ENV.api, db: TEMPLATE_ENV.db, users: TEMPLATE_ENV.users,
    defaults: TEMPLATE_ENV.defaults, portalUrl: TEMPLATE_ENV.portalUrl,
  }));
  assert.strictEqual(scaffold.isPristineSampleEnv(reordered, PLUGIN_ROOT), true);
});

test('isPristineSampleEnv: any user-touched value means NOT pristine', () => {
  const touched = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  touched.portalUrl = 'https://my-real-app.example';
  assert.strictEqual(scaffold.isPristineSampleEnv(touched, PLUGIN_ROOT), false);
  const extraKey = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  extraKey.users.new_user = { phone: '0550000003' };
  assert.strictEqual(scaffold.isPristineSampleEnv(extraKey, PLUGIN_ROOT), false);
  const removedKey = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  delete removedKey.db;
  assert.strictEqual(scaffold.isPristineSampleEnv(removedKey, PLUGIN_ROOT), false);
});

test('isPristineSampleEnv: null / non-object input is never pristine', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(null, PLUGIN_ROOT), false);
  assert.strictEqual(scaffold.isPristineSampleEnv('a string', PLUGIN_ROOT), false);
  assert.strictEqual(scaffold.isPristineSampleEnv(42, PLUGIN_ROOT), false);
});

test('sampleEnvShapes covers the current template plus every shipped revision', () => {
  const shapes = scaffold.sampleEnvShapes(PLUGIN_ROOT);
  assert.ok(shapes.length >= 1);
  assert.ok(shapes.some(s => { try { assert.deepStrictEqual(s, TEMPLATE_ENV); return true; } catch { return false; } }),
    'current template included');
});

// ---- the QA watchlist (skill-consolidation-foundation R6) ----
// The QA-record files hold user decisions: they are committed, so no scaffolded
// ignore entry may cover them, and they are created lazily by qa-records.js —
// never by the scaffold. The paths come from the one constant.
const { STRUCTURED_DEFAULTS } = require('./project_config.js');
const QA_PATHS = Object.values(STRUCTURED_DEFAULTS.qaRecords);

test('the scaffolded .gitignore covers none of the default QA watchlist paths (git check-ignore)', () => {
  const { spawnSync } = require('node:child_process'); // test-side only
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.env'), 'the scaffold wrote its ignore block');
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) { console.log('    (skipped: git unavailable)'); return; }
  const folder = `${path.posix.dirname(QA_PATHS[0])}/`;
  for (const p of [...QA_PATHS, folder]) {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-v', p], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, `${p} is ignored by: ${r.stdout.trim()}`);
  }
  for (const e of scaffold.gitignoreMissing(proj())) {
    for (const p of QA_PATHS) assert.ok(!p.startsWith(e.entry.replace(/^\//, '')), `${e.entry} would cover ${p}`);
  }
});

test('the scaffold creates no QA watchlist file or folder (they are created lazily on first append)', () => {
  const dir = proj();
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  for (const p of QA_PATHS) assert.ok(!fs.existsSync(path.join(dir, p)), `${p} must not be scaffolded`);
  assert.ok(!fs.existsSync(path.join(dir, path.dirname(QA_PATHS[0]))), 'nor its folder');
  assert.ok(!actions.some((a) => QA_PATHS.some((p) => a.path.startsWith(path.posix.dirname(p)))));
});

test('the scaffolded config/project.json carries the four plugin blocks, equal to STRUCTURED_DEFAULTS; no provider block', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  const cfg = readJson(dir, 'config/project.json');
  for (const k of ['testingTasks', 'testDesign', 'estimation', 'qaRecords']) {
    assert.deepStrictEqual(cfg[k], STRUCTURED_DEFAULTS[k], `${k} equals the default`);
  }
  assert.ok(!('azure' in cfg) && !('jira' in cfg), 'the template carries no provider block (the wizard writes the chosen one)');
  assert.ok(!('workflow' in cfg) && !('reproSummaryRow' in cfg), 'provider-block keys are never top-level');
});

// ---- Decision A-2: the shared test password is a secret in every shipped template ----
const TEMPLATE_PROJECT = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'config', 'project.json'), 'utf8'));
// The project template shipped before A-2 (plain password descriptor with a default).
const PRE_A2_PROJECT_TEMPLATE = {
  ...JSON.parse(JSON.stringify(TEMPLATE_PROJECT)),
  defaultsFields: [
    { key: 'password', label: 'كلمة المرور الافتراضية', labelEn: 'Default Password', default: 'Test@1234',
      hint: 'كلمة مرور حسابات الاختبار المشتركة — تُكتب كما هي في ملف البيئة (ليست سرًّا حقيقيًا)',
      hintEn: 'The shared test-account password — written as-is into the environment file (not a real secret)' },
    { key: 'otp', label: 'OTP الافتراضي', labelEn: 'Default OTP', default: '0000' },
  ],
};

test('A-2: the sample environment references DEFAULT_PASSWORD — no plugin template ships a password value', () => {
  assert.deepStrictEqual(TEMPLATE_ENV.defaults, { otp: '0000', password: { envSecret: 'DEFAULT_PASSWORD' } });
  assert.ok(!JSON.stringify(TEMPLATE_PROJECT).includes('Test@1234'), 'the project template carries no password value');
  assert.ok(!JSON.stringify(TEMPLATE_ENV).includes('Test@1234'));
});

test('A-2: the pre-A-2 sample environment still counts as pristine (historical shape 1)', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(QA_ERA_SAMPLE, PLUGIN_ROOT), true);
  assert.strictEqual(scaffold.isPristineSampleEnv(TEMPLATE_ENV, PLUGIN_ROOT), true);
});

test('A-2: isPristineProjectConfig accepts the current and the pre-A-2 template, nothing user-touched', () => {
  assert.strictEqual(scaffold.isPristineProjectConfig(TEMPLATE_PROJECT, PLUGIN_ROOT), true);
  assert.strictEqual(scaffold.isPristineProjectConfig(PRE_A2_PROJECT_TEMPLATE, PLUGIN_ROOT), true);
  const touched = JSON.parse(JSON.stringify(PRE_A2_PROJECT_TEMPLATE));
  touched.name = 'my-real-project';
  assert.strictEqual(scaffold.isPristineProjectConfig(touched, PLUGIN_ROOT), false);
  assert.strictEqual(scaffold.isPristineProjectConfig(null, PLUGIN_ROOT), false);
});

test('A-2: the scaffolded keys-only .env lists DEFAULT_PASSWORD with an empty value', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^DEFAULT_PASSWORD=$/m);
});

test('A-2: a freshly scaffolded, git add-ed project scans with no plain-string warning and no leak', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const dir = scaffoldedRepo();
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'secret_scan.js'), '--staged'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  const out = JSON.parse(r.stdout);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(out.findings, [], 'zero findings from the plugin\'s own files');
  assert.strictEqual(out.result, 'CLEAN');
});

// ---- config/estimation.json: the user's file, committed, never scaffolded ----
const ESTIMATION = 'config/estimation.json';
const ESTIMATION_BYTES = '{\n  "schemaVersion": 1,\n  "tasks": [ { "name": "Exploratory Pass", "enabled": true, "minHours": 1, "maxHours": 3 } ],\n  "factors": { "Scope": 1 }\n}\n';

test('a fresh scaffold creates no config/estimation.json (only an approved estimation run does)', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.ok(fs.existsSync(path.join(dir, 'config', 'project.json')), 'the scaffold ran');
  assert.ok(!fs.existsSync(path.join(dir, ESTIMATION)));
});

test('a scaffold re-run leaves an existing config/estimation.json byte-identical', () => {
  const dir = proj({ [ESTIMATION]: ESTIMATION_BYTES });
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  scaffold.ensureGitignore(dir);
  scaffold.ensureClaudeMdBullet(dir);
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.strictEqual(fs.readFileSync(path.join(dir, ESTIMATION), 'utf8'), ESTIMATION_BYTES);
});

test('the scaffold\'s .gitignore does not ignore config/estimation.json or config/ (the file is committed)', () => {
  const { execFileSync } = require('node:child_process');
  const dir = proj({ [ESTIMATION]: ESTIMATION_BYTES });
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  scaffold.ensureGitignore(dir);
  const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const pattern of ['config/', 'config', '/config/', '/config', 'config/estimation.json', '*.json', 'config/*']) {
    assert.ok(!lines.includes(pattern), `.gitignore must not carry ${pattern}`);
  }
  execFileSync('git', ['-C', dir, 'init', '-q']);
  for (const rel of [ESTIMATION, 'config/project.json']) {
    let ignored = true;
    try { execFileSync('git', ['-C', dir, 'check-ignore', '-q', rel]); } catch (e) { ignored = e.status !== 1; }
    assert.strictEqual(ignored, false, `${rel} must not be ignored by git`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
