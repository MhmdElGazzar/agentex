'use strict';
// Unit tests for the shared project-config resolver. Run: node scripts/lib/project_config.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pc = require('./project_config.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Fresh throwaway project dir per test, with optional files.
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-pc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// ---- readEnvVar ----
test('readEnvVar reads a .env line and strips quotes', () => {
  const dir = proj({ '.env': "DB_SERVER='srv.local'\nPLAIN=abc\n" });
  assert.strictEqual(pc.readEnvVar(dir, 'DB_SERVER'), 'srv.local');
  assert.strictEqual(pc.readEnvVar(dir, 'PLAIN'), 'abc');
  assert.strictEqual(pc.readEnvVar(dir, 'MISSING'), null);
});
test('readEnvVar prefers process.env over .env', () => {
  const dir = proj({ '.env': 'X_TEST_VAR=fromfile\n' });
  process.env.X_TEST_VAR = 'fromproc';
  try { assert.strictEqual(pc.readEnvVar(dir, 'X_TEST_VAR'), 'fromproc'); }
  finally { delete process.env.X_TEST_VAR; }
});

// ---- loadProjectConfig ----
test('loadProjectConfig returns {} when file is absent', () => {
  assert.deepStrictEqual(pc.loadProjectConfig(proj()), {});
});
test('loadProjectConfig parses config/project.json', () => {
  const dir = proj({ 'config/project.json': { name: 'demo', defaultEnvironment: 'qa' } });
  assert.strictEqual(pc.loadProjectConfig(dir).defaultEnvironment, 'qa');
});
test('loadProjectConfig throws on invalid JSON', () => {
  const dir = proj({ 'config/project.json': '{ nope' });
  assert.throws(() => pc.loadProjectConfig(dir), /invalid JSON/);
});

// ---- listEnvironments / loadEnvironment ----
test('listEnvironments: [] without folder, sorted names with it', () => {
  assert.deepStrictEqual(pc.listEnvironments(proj()), []);
  const dir = proj({ 'environments/uat.json': {}, 'environments/qa.json': {} });
  assert.deepStrictEqual(pc.listEnvironments(dir), ['qa', 'uat']);
});
test('loadEnvironment: null for legacy project (no name, no default)', () => {
  assert.strictEqual(pc.loadEnvironment(proj(), null), null);
});
test('loadEnvironment: explicit name wins over defaultEnvironment', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { portalUrl: 'https://qa' },
    'environments/uat.json': { portalUrl: 'https://uat' },
  });
  assert.strictEqual(pc.loadEnvironment(dir, 'uat').portalUrl, 'https://uat');
  assert.strictEqual(pc.loadEnvironment(dir, null).name, 'qa');
});
test('loadEnvironment: wanted-but-missing env throws listing available', () => {
  const dir = proj({ 'environments/qa.json': {} });
  assert.throws(() => pc.loadEnvironment(dir, 'live'), /available: qa/);
});

// ---- resolveSecret / secretHint ----
test('resolveSecret: literal string, envSecret ref, null', () => {
  const dir = proj({ '.env': 'MY_SECRET=s3cret\n' });
  assert.strictEqual(pc.resolveSecret(dir, 'plain'), 'plain');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'MY_SECRET' }), 's3cret');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'UNSET_VAR' }), null);
  assert.strictEqual(pc.resolveSecret(dir, null), null);
  assert.strictEqual(pc.secretHint({ envSecret: 'MY_SECRET' }), 'env var MY_SECRET');
});

// ---- resolveDbConnection ----
test('resolveDbConnection: environment db block wins, password via envSecret', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 'qa-db', port: 1434, name: 'QaDb', user: 'u1', password: { envSecret: 'QA_DB_PW' } } },
    '.env': 'QA_DB_PW=pw1\nDB_SERVER=legacy-db\n',
  });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER' });
  assert.strictEqual(c.server, 'qa-db');
  assert.strictEqual(c.port, '1434');
  assert.strictEqual(c.database, 'QaDb');
  assert.strictEqual(c.password, 'pw1');
});
test('resolveDbConnection: legacy catalog fallback reads .env by name', () => {
  const dir = proj({ '.env': 'DB_SERVER=legacy-db\nDB_NAME=LegacyDb\nSQLCMDPASSWORD=lpw\n' });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' });
  assert.strictEqual(c.server, 'legacy-db');
  assert.strictEqual(c.database, 'LegacyDb');
  assert.strictEqual(c.password, 'lpw');
});
test('resolveDbConnection: named-but-unset databaseEnv throws', () => {
  const dir = proj({ '.env': 'DB_SERVER=srv\n' });
  const savedServer = process.env.DB_SERVER;
  const savedName = process.env.DB_NAME;
  delete process.env.DB_SERVER;
  delete process.env.DB_NAME;
  try {
    assert.throws(() => pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' }), /DB_NAME/);
  } finally {
    if (savedServer === undefined) delete process.env.DB_SERVER; else process.env.DB_SERVER = savedServer;
    if (savedName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = savedName;
  }
});
test('resolveDbConnection: nothing resolvable throws', () => {
  assert.throws(() => pc.resolveDbConnection(proj(), null, {}), /no db config/);
});

// ---- resolveApiTarget ----
test('resolveApiTarget: env api block with envSecret token', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { api: { baseUrl: 'https://api.qa/', token: { envSecret: 'QA_TOKEN' } } },
    '.env': 'QA_TOKEN=tok1\n',
  });
  const t = pc.resolveApiTarget(dir, null);
  assert.strictEqual(t.baseUrl, 'https://api.qa'); // trailing slash stripped
  assert.strictEqual(t.token, 'tok1');
  assert.strictEqual(t.hasToken, true);
});
test('resolveApiTarget: null when no environment or no api block', () => {
  assert.strictEqual(pc.resolveApiTarget(proj(), null), null);
  const dir = proj({ 'config/project.json': { defaultEnvironment: 'qa' }, 'environments/qa.json': { portalUrl: 'x' } });
  assert.strictEqual(pc.resolveApiTarget(dir, null), null);
});

// ════ structured getter (skill-consolidation-foundation R5 / WP-5) ════════════
// The QA-record default paths live ONLY in STRUCTURED_DEFAULTS.qaRecords: these
// tests read the constant and never repeat its values, so renaming a default is
// one edit in project_config.js (plus whatever mirror the pin tests below flag).
const { STRUCTURED_DEFAULTS: D, getStructured, ConfigError, withPluginConfigBlocks, detectTrackerBlock } = pc;
const AZ = { org: 'exampleorg', project: 'Sample Project' };
const JI = { site: 'example', project: 'PROJ' };
const cfgDir = (config, env) => proj({ 'config/project.json': config, ...(env ? { '.env': env } : {}) });
const configError = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a ConfigError'); };
const clone = (v) => JSON.parse(JSON.stringify(v));

test('getStructured with no config at all: every default, typed; no tracker -> workflow null', () => {
  const got = getStructured(proj());
  assert.deepStrictEqual(Object.keys(got), ['testingTasks', 'workflow', 'reproSummaryRow', 'testDesign', 'estimation', 'qaRecords']);
  assert.strictEqual(got.testingTasks.length, 5);
  assert.deepStrictEqual(got.testingTasks.map((t) => t.stage), ['requirementReview', 'testCreation', 'testExecution', 'bugRetest', 'automation']);
  assert.ok(got.testingTasks.every((t) => t.enabled === true && t.title.startsWith('[Testing] ')));
  assert.strictEqual(got.reproSummaryRow, true);
  assert.deepStrictEqual(got.testDesign, { approval: 'consolidated', independentCoverageCheck: false });
  assert.deepStrictEqual(got.estimation, D.estimation);
  assert.deepStrictEqual(got.qaRecords, D.qaRecords);
  assert.strictEqual(got.workflow, null);
  assert.deepStrictEqual(getStructured(proj(), 'qaRecords'), D.qaRecords);
});

test('STRUCTURED_DEFAULTS.qaRecords: the four kinds, relative Markdown paths in ONE folder', () => {
  assert.deepStrictEqual(Object.keys(D.qaRecords), ['pendingQuestions', 'pendingRechecks', 'envIssues', 'deferredConditions']);
  const paths = Object.values(D.qaRecords);
  for (const p of paths) {
    assert.strictEqual(typeof p, 'string');
    assert.ok(!path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), p);
    assert.ok(p.endsWith('.md'), `${p} — the defaults are all Markdown`);
  }
  assert.strictEqual(new Set(paths.map((p) => path.posix.dirname(p))).size, 1, 'one folder');
  assert.notStrictEqual(path.posix.dirname(paths[0]), '.', 'a folder, not the project root');
  assert.strictEqual(new Set(paths).size, 4, 'four distinct files');
});

// Owner decision #6 (amended 2026-10-09): the folder is the "QA watchlist" and
// each kind has a plain-English file name. Asserted as folder + basenames (never
// the joined paths, which live only in the constant) so this is the decision
// record, not a second copy of the defaults.
test('STRUCTURED_DEFAULTS.qaRecords follows owner decision #6: the qa-watchlist/ folder and its four file names', () => {
  const folders = new Set(Object.values(D.qaRecords).map((p) => path.posix.dirname(p)));
  assert.deepStrictEqual([...folders], ['qa-watchlist']);
  const base = Object.fromEntries(Object.entries(D.qaRecords).map(([k, p]) => [k, path.posix.basename(p)]));
  assert.deepStrictEqual(base, {
    pendingQuestions: 'awaiting-answers.md',
    pendingRechecks: 'awaiting-retest.md',
    envIssues: 'environment-blockers.md',
    deferredConditions: 'deferred-conditions.md',
  });
});

test('STRUCTURED_DEFAULTS.workflow is EMPTY (assumption A-1, owner answer #5)', () => {
  assert.deepStrictEqual(D.workflow, {
    devDoneStates: [], devActiveStates: [], inTestState: '', qaStates: [], terminalStates: [],
    taskActiveState: '', taskClosedState: '', testCaseReadyState: '',
    closeOut: { state: '', assignee: '' },
  });
});

test('the getter returns copies: mutating a result never moves the defaults', () => {
  const got = getStructured(proj());
  got.testingTasks[0].enabled = false; got.qaRecords.envIssues = 'x.md'; got.testDesign.approval = 'per-story';
  assert.strictEqual(D.testingTasks[0].enabled, true);
  assert.notStrictEqual(D.qaRecords.envIssues, 'x.md');
  assert.strictEqual(D.testDesign.approval, 'consolidated');
});

test('types are kept: arrays, nested objects and booleans are never stringified', () => {
  const dir = cfgDir({ azure: { ...AZ, reproSummaryRow: false, workflow: { qaStates: ['QA', 'Verify'], closeOut: { state: 'Closed' } } }, testDesign: { independentCoverageCheck: true } });
  const got = getStructured(dir);
  assert.strictEqual(got.reproSummaryRow, false);
  assert.deepStrictEqual(got.workflow.qaStates, ['QA', 'Verify']);
  assert.strictEqual(got.testDesign.independentCoverageCheck, true);
  assert.strictEqual(typeof got.testingTasks[0].enabled, 'boolean');
});

test('reproSummaryRow: JSON boolean or exactly "true"/"false"; from the configured provider block; absent -> true', () => {
  assert.strictEqual(getStructured(cfgDir({ azure: { ...AZ, reproSummaryRow: 'false' } }), 'reproSummaryRow'), false);
  assert.strictEqual(getStructured(cfgDir({ jira: { ...JI, reproSummaryRow: 'true' } }), 'reproSummaryRow'), true);
  assert.strictEqual(getStructured(cfgDir({ jira: { ...JI } }), 'reproSummaryRow'), true);
  assert.strictEqual(getStructured(cfgDir({ reproSummaryRow: false }), 'reproSummaryRow'), true, 'a top-level key is not the provider block');
  const e = configError(() => getStructured(cfgDir({ azure: { ...AZ, reproSummaryRow: 'yes' } }), 'reproSummaryRow'));
  assert.ok(e instanceof ConfigError); assert.strictEqual(e.exitCode, 2);
  assert.match(e.message, /azure\.reproSummaryRow/); assert.match(e.message, /true.*false/);
});

test('per-key merge: setting only testDesign.approval keeps every other default', () => {
  const got = getStructured(cfgDir({ testDesign: { approval: 'per-story' } }));
  assert.deepStrictEqual(got.testDesign, { approval: 'per-story', independentCoverageCheck: false });
  assert.deepStrictEqual(got.estimation, D.estimation);
  assert.deepStrictEqual(got.qaRecords, D.qaRecords);
  const est = getStructured(cfgDir({ estimation: { historyPath: 'data/history.jsonl' } }), 'estimation');
  assert.deepStrictEqual(est, { ...D.estimation, historyPath: 'data/history.jsonl' });
  const qa = getStructured(cfgDir({ qaRecords: { envIssues: 'notes/env.jsonl' } }), 'qaRecords');
  assert.deepStrictEqual(qa, { ...D.qaRecords, envIssues: 'notes/env.jsonl' }, 'one override, three defaults; .jsonl accepted for teams that override');
});

test('testingTasks merge BY STAGE: one entry disables one task and keeps four; canonical order always', () => {
  const got = getStructured(cfgDir({ testingTasks: [{ stage: 'automation', enabled: false }, { stage: 'requirementReview', title: '[Testing] Requirement Analysis' }] }), 'testingTasks');
  assert.deepStrictEqual(got.map((t) => t.stage), D.testingTasks.map((t) => t.stage));
  assert.deepStrictEqual(got[4], { ...D.testingTasks[4], enabled: false });
  assert.deepStrictEqual(got[0], { ...D.testingTasks[0], title: '[Testing] Requirement Analysis' });
  assert.deepStrictEqual(got.slice(1, 4), D.testingTasks.slice(1, 4));
});

test('workflow: from azure.workflow vs jira.workflow, same shape; deep merge incl. closeOut; arrays replace wholesale', () => {
  const az = getStructured(cfgDir({ azure: { ...AZ, workflow: { devDoneStates: ['Resolved'], closeOut: { assignee: 'po@example.com' } } } }), 'workflow');
  assert.deepStrictEqual(az, { ...D.workflow, devDoneStates: ['Resolved'], closeOut: { state: '', assignee: 'po@example.com' } });
  const ji = getStructured(cfgDir({ jira: { ...JI, workflow: { inTestState: 'In QA' } } }), 'workflow');
  assert.deepStrictEqual(Object.keys(ji), Object.keys(D.workflow));
  assert.strictEqual(ji.inTestState, 'In QA');
  const none = getStructured(cfgDir({ name: 'x' }), 'workflow');
  assert.strictEqual(none, null, 'no tracker configured -> no workflow');
  const legacy = getStructured(cfgDir({}, 'AZURE_URL=https://dev.azure.com/exampleorg\n'), 'workflow');
  assert.deepStrictEqual(legacy, D.workflow, 'legacy .env azure project -> azure, defaults');
  const two = configError(() => getStructured(cfgDir({ azure: AZ, jira: JI }), 'workflow'));
  assert.strictEqual(two.exitCode, 2);
  assert.match(two.message, /More than one tracker provider is configured \(azure, jira\)/);
});

test('validation: wrong type at each block exits 2 naming the key path and the accepted shape', () => {
  for (const [config, key, re] of [
    [{ testingTasks: {} }, 'testingTasks', /testingTasks.*array/],
    [{ testDesign: [] }, 'testDesign', /testDesign.*object/],
    [{ estimation: 'x' }, 'estimation', /estimation.*object/],
    [{ qaRecords: null }, 'qaRecords', /qaRecords.*object/],
    [{ azure: { ...AZ, workflow: 'x' } }, 'workflow', /azure\.workflow.*object/],
    [{ testingTasks: ['automation'] }, 'testingTasks', /testingTasks\[0\].*object/],
  ]) {
    const e = configError(() => getStructured(cfgDir(config), key));
    assert.ok(e instanceof ConfigError, key); assert.strictEqual(e.exitCode, 2); assert.match(e.message, re);
  }
});

test('validation: unknown stage, duplicate stage, bad title prefix, non-boolean enabled', () => {
  const stages = D.testingTasks.map((t) => t.stage).join(', ');
  let e = configError(() => getStructured(cfgDir({ testingTasks: [{ stage: 'smokeTest' }] }), 'testingTasks'));
  assert.match(e.message, /testingTasks\[0\]\.stage/); assert.match(e.message, /smokeTest/); assert.ok(e.message.includes(stages), 'names the accepted stages');
  e = configError(() => getStructured(cfgDir({ testingTasks: [{ stage: 'automation' }, { stage: 'automation', enabled: false }] }), 'testingTasks'));
  assert.match(e.message, /testingTasks\[1\]\.stage.*duplicate/i);
  e = configError(() => getStructured(cfgDir({ testingTasks: [{ stage: 'automation', title: 'Automation' }] }), 'testingTasks'));
  assert.match(e.message, /testingTasks\[0\]\.title/); assert.match(e.message, /\[Testing\] /);
  e = configError(() => getStructured(cfgDir({ testingTasks: [{ stage: 'automation', enabled: 'no' }] }), 'testingTasks'));
  assert.match(e.message, /testingTasks\[0\]\.enabled.*true or false/);
  e = configError(() => getStructured(cfgDir({ testingTasks: [{ enabled: false }] }), 'testingTasks'));
  assert.match(e.message, /testingTasks\[0\]\.stage/);
});

test('validation: approval mode, coverage-check type, paths, extensions, workflow lists', () => {
  let e = configError(() => getStructured(cfgDir({ testDesign: { approval: 'per-case' } }), 'testDesign'));
  assert.match(e.message, /testDesign\.approval/); assert.match(e.message, /consolidated/); assert.match(e.message, /per-story/);
  e = configError(() => getStructured(cfgDir({ testDesign: { independentCoverageCheck: 'false' } }), 'testDesign'));
  assert.match(e.message, /testDesign\.independentCoverageCheck.*true or false/);
  e = configError(() => getStructured(cfgDir({ estimation: { modelPath: '/etc/model.json' } }), 'estimation'));
  assert.match(e.message, /estimation\.modelPath.*relative/);
  e = configError(() => getStructured(cfgDir({ qaRecords: { envIssues: '../outside/env.md' } }), 'qaRecords'));
  assert.match(e.message, /qaRecords\.envIssues.*\.\./);
  e = configError(() => getStructured(cfgDir({ qaRecords: { envIssues: 'records/env.txt' } }), 'qaRecords'));
  assert.match(e.message, /qaRecords\.envIssues/); assert.match(e.message, /\.md/); assert.match(e.message, /\.jsonl/);
  e = configError(() => getStructured(cfgDir({ qaRecords: { envIssues: '' } }), 'qaRecords'));
  assert.match(e.message, /qaRecords\.envIssues/);
  e = configError(() => getStructured(cfgDir({ jira: { ...JI, workflow: { qaStates: 'QA' } } }), 'workflow'));
  assert.match(e.message, /jira\.workflow\.qaStates.*array of strings/);
  e = configError(() => getStructured(cfgDir({ jira: { ...JI, workflow: { qaStates: ['QA', 3] } } }), 'workflow'));
  assert.match(e.message, /jira\.workflow\.qaStates/);
  e = configError(() => getStructured(cfgDir({ azure: { ...AZ, workflow: { inTestState: ['Testing'] } } }), 'workflow'));
  assert.match(e.message, /azure\.workflow\.inTestState.*string/);
  e = configError(() => getStructured(cfgDir({ azure: { ...AZ, workflow: { closeOut: 'Closed' } } }), 'workflow'));
  assert.match(e.message, /azure\.workflow\.closeOut.*object/);
});

test('validation: unknown keys in every plugin-owned block are a ConfigError naming the known keys (S13)', () => {
  for (const [config, key, re] of [
    [{ testDesign: { aproval: 'per-story' } }, 'testDesign', /testDesign\.aproval.*approval, independentCoverageCheck/],
    [{ estimation: { model: 'x.json' } }, 'estimation', /estimation\.model\b.*modelPath, historyPath/],
    [{ qaRecords: { questions: 'q.md' } }, 'qaRecords', /qaRecords\.questions.*pendingQuestions, pendingRechecks, envIssues, deferredConditions/],
    [{ azure: { ...AZ, workflow: { doneStates: [] } } }, 'workflow', /azure\.workflow\.doneStates.*devDoneStates/],
    [{ azure: { ...AZ, workflow: { closeOut: { owner: 'x' } } } }, 'workflow', /azure\.workflow\.closeOut\.owner.*state, assignee/],
    [{ testingTasks: [{ stage: 'automation', hours: 2 }] }, 'testingTasks', /testingTasks\[0\]\.hours.*stage, title, enabled/],
  ]) {
    const e = configError(() => getStructured(cfgDir(config), key));
    assert.ok(e instanceof ConfigError, JSON.stringify(config)); assert.match(e.message, re);
  }
});

test('only the requested key is validated; getStructured(cwd) validates all', () => {
  const dir = cfgDir({ testDesign: { approval: 'nope' } });
  assert.deepStrictEqual(getStructured(dir, 'qaRecords'), D.qaRecords);
  assert.ok(configError(() => getStructured(dir)) instanceof ConfigError);
  assert.ok(configError(() => getStructured(dir, 'noSuchKey')) instanceof ConfigError, 'an unknown key name is refused too');
});

test('existing azure/jira keys are not validated more strictly (only the new nested blocks)', () => {
  const dir = cfgDir({ azure: { ...AZ, someHandAddedKey: { any: 'thing' }, areaPath: 'Sample Project\\QA' } });
  assert.deepStrictEqual(getStructured(dir, 'workflow'), D.workflow);
});

test('pin: the testingTasks default mirrors task-estimation SKILL.md "Task template" (titles and order)', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'task-estimation', 'SKILL.md'), 'utf8');
  const section = md.split(/^## Task template\s*$/m)[1].split(/^## /m)[0];
  const titles = [...section.matchAll(/^\|\s*`(\[Testing\][^`]*)`\s*\|/gm)].map((m) => m[1]);
  assert.deepStrictEqual(titles, D.testingTasks.map((t) => t.title));
});

test('pin: rules.js TITLE_PREFIX is the prefix the getter enforces', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'task-estimation', 'scripts', 'strategies', 'rules.js'), 'utf8');
  assert.match(rules, /const TITLE_PREFIX = '\[Testing\] ';/);
  assert.ok(D.testingTasks.every((t) => t.title.startsWith('[Testing] ')));
});

// The only files allowed to MIRROR the default paths — each because a reader
// (or the scaffold) must see them — and the test that compares each mirror with
// STRUCTURED_DEFAULTS.qaRecords, so a rename that misses a mirror fails there.
const QA_PATH_MIRRORS = {
  'references/tracker/qa-records.md': 'scripts/references.test.js (the default-path table)',
  'templates/config/project.json': 'scripts/lib/project_config.test.js (the template\'s plugin blocks equal the defaults)',
};

test('pin: templates/config/project.json\'s plugin blocks equal STRUCTURED_DEFAULTS (fresh /init-test = the defaults)', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'config', 'project.json'), 'utf8'));
  for (const k of ['testingTasks', 'testDesign', 'estimation', 'qaRecords']) assert.deepStrictEqual(tpl[k], D[k], k);
  assert.deepStrictEqual(withPluginConfigBlocks(tpl), tpl, 'nothing left for the wizard save or m12 to seed on a fresh scaffold');
});

test('pin: the default qaRecords paths appear literally ONLY in project_config.js and the pinned mirrors (one constant, mechanical rename)', () => {
  const root = path.join(__dirname, '..', '..');
  const { spawnSync } = require('node:child_process'); // test-side only
  const ls = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (ls.status !== 0) { console.log('    (skipped: git unavailable)'); return; }
  const needles = Object.values(D.qaRecords);
  const hits = [];
  for (const rel of ls.stdout.trim().split(/\r?\n/)) {
    if (rel === 'scripts/lib/project_config.js' || QA_PATH_MIRRORS[rel]) continue;
    let text; try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const n of needles) if (text.includes(n)) hits.push(`${rel}: ${n}`);
  }
  assert.deepStrictEqual(hits, [], `hard-coded default QA-record path(s) — read STRUCTURED_DEFAULTS.qaRecords instead: ${hits.join('; ')}`);
});

// ---- detectTrackerBlock: the provider-block rule, kept in step with resolveTracker ----
test('detectTrackerBlock agrees with resolveTracker on six fixtures', () => {
  const { resolveTracker } = require('./tracker/index.js');
  const ADAPTER_OF = { azure: 'ado', jira: 'jira' };
  const fixtures = [
    [{ azure: AZ }, ''],
    [{ jira: JI }, ''],
    [{}, ''],
    [{ azure: AZ, jira: JI }, ''],
    [{}, 'AZURE_URL=https://dev.azure.com/exampleorg\nAZURE_PROJECT=Sample Project\n'],
    [{ azure: {}, jira: JI }, ''],
  ];
  for (const [config, env] of fixtures) {
    const dir = cfgDir(config, env);
    let mine; let theirs;
    try { mine = { provider: detectTrackerBlock(pc.loadProjectConfig(dir), dir) }; } catch (e) { mine = { error: e.message }; }
    try { theirs = { provider: resolveTracker(dir).name }; } catch (e) { theirs = { error: e.message }; }
    if (theirs.error && /^No tracker is configured/.test(theirs.error)) {
      assert.strictEqual(mine.provider, null, `${JSON.stringify(config)}: no tracker -> null`);
    } else if (mine.error || theirs.error) {
      assert.strictEqual(mine.error, theirs.error, `${JSON.stringify(config)} ${env}`);
    } else {
      assert.strictEqual(ADAPTER_OF[mine.provider], theirs.provider, JSON.stringify(config));
    }
  }
  assert.strictEqual(detectTrackerBlock({}, proj()), null, 'no tracker -> null (resolveTracker throws; the getter returns no workflow)');
});

// ---- withPluginConfigBlocks: the one function the wizard save and m12 share ----
test('withPluginConfigBlocks adds the absent top-level blocks and the ONE provider\'s workflow; never rewrites', () => {
  const fresh = withPluginConfigBlocks({ name: 'x', azure: { ...AZ } });
  assert.deepStrictEqual(Object.keys(fresh), ['name', 'azure', 'testingTasks', 'testDesign', 'estimation', 'qaRecords']);
  assert.deepStrictEqual(fresh.testingTasks, D.testingTasks);
  assert.deepStrictEqual(fresh.qaRecords, D.qaRecords);
  assert.deepStrictEqual(fresh.azure, { ...AZ, workflow: D.workflow });
  assert.ok(!('reproSummaryRow' in fresh.azure), 'reproSummaryRow is never written');
  const custom = { jira: { ...JI, workflow: { inTestState: 'In QA' } }, testingTasks: [{ stage: 'automation', enabled: false }] };
  const out = withPluginConfigBlocks(clone(custom));
  assert.deepStrictEqual(out.jira, custom.jira, 'an existing workflow is never rewritten');
  assert.deepStrictEqual(out.testingTasks, custom.testingTasks, 'an existing block is never rewritten');
  assert.ok(!('azure' in out), 'never creates a provider block');
  const none = withPluginConfigBlocks({ name: 'x' });
  assert.ok(!('azure' in none) && !('jira' in none), 'no tracker -> no provider key');
  const two = withPluginConfigBlocks({ azure: { ...AZ }, jira: { ...JI } });
  assert.ok(!('workflow' in two.azure) && !('workflow' in two.jira), 'two provider blocks are left alone');
  assert.ok('qaRecords' in two, 'top-level blocks are still added');
  const empty = withPluginConfigBlocks({ azure: {} });
  assert.deepStrictEqual(empty.azure, {}, 'an empty provider block is not a configured tracker');
  const src = { azure: { ...AZ } };
  withPluginConfigBlocks(src);
  assert.deepStrictEqual(src, { azure: { ...AZ } }, 'the input object is not mutated');
  fresh.testingTasks[0].enabled = false;
  assert.strictEqual(D.testingTasks[0].enabled, true, 'blocks are copies of the defaults');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
