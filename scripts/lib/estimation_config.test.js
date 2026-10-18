'use strict';
// Unit tests for the estimation file schema (scripts/lib/estimation_config.js).
// Run: node scripts/lib/estimation_config.test.js
// Offline, zero dependencies: every case builds a throwaway project dir.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ec = require('./estimation_config.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const FILE = 'config/estimation.json';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A valid file, as the plugin would write it.
const VALID = () => ({
  schemaVersion: 1,
  tasks: [
    { name: 'Requirement Review', enabled: true, minHours: 0.5, maxHours: 2 },
    { name: 'Test Creation', enabled: true, minHours: 1, maxHours: 4 },
    { name: 'Test Execution', enabled: true, minHours: 1, maxHours: 3 },
    { name: 'Automation', enabled: false, minHours: 1, maxHours: 3 },
  ],
  factors: { 'Scenarios / ACs': 1, 'UI elements': 2, 'Data setup': 0 },
  source: { kind: 'history', sprints: 2, sprintsRead: ['Sprint 41', 'Sprint 42'], note: 'x' },
});

function proj(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ec-'));
  if (raw !== undefined) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
  }
  return dir;
}
const codes = (problems) => problems.map((p) => p.code);
const withTask = (i, patch) => { const c = VALID(); c.tasks[i] = { ...c.tasks[i], ...patch }; return c; };

// Load a raw file, asserting the bytes are unchanged by the load (reading never writes).
function loadKeepingBytes(raw) {
  const dir = proj(raw);
  const before = sha(fs.readFileSync(path.join(dir, FILE)));
  const r = ec.loadEstimationConfig(dir);
  assert.strictEqual(sha(fs.readFileSync(path.join(dir, FILE))), before, 'the load changed the file bytes');
  return r;
}

// ── constants and defaults ──────────────────────────────────────────────────
test('constants: file path, schema version, default sprint count', () => {
  assert.strictEqual(ec.ESTIMATION_FILE_REL, 'config/estimation.json');
  assert.strictEqual(ec.SCHEMA_VERSION, 1);
  assert.strictEqual(ec.DEFAULT_SPRINTS, 2);
});

test('STARTER_TASKS: the five starter names, all enabled, 3.0 h at every min and 5.0 h at every max', () => {
  assert.deepStrictEqual(ec.STARTER_TASKS.map((t) => t.name),
    ['Requirement Review', 'Test Creation', 'Test Execution', 'Bug Review and Retest', 'Automation']);
  assert.ok(ec.STARTER_TASKS.every((t) => t.enabled === true));
  assert.strictEqual(ec.STARTER_TASKS.reduce((s, t) => s + t.minHours, 0), 3);
  assert.strictEqual(ec.STARTER_TASKS.reduce((s, t) => s + t.maxHours, 0), 5);
  for (const t of ec.STARTER_TASKS) {
    assert.strictEqual(t.minHours * 2, Math.round(t.minHours * 2), `${t.name} min on the half-hour grid`);
    assert.strictEqual(t.maxHours * 2, Math.round(t.maxHours * 2), `${t.name} max on the half-hour grid`);
  }
});

test('DEFAULT_FACTORS: the eight default factors, weight 1 each', () => {
  assert.deepStrictEqual(Object.keys(ec.DEFAULT_FACTORS), ['Scenarios / ACs', 'UI elements', 'Validations',
    'Conditions / logic', 'Error messages', 'API integrations', 'Translations', 'Edge cases']);
  assert.ok(Object.values(ec.DEFAULT_FACTORS).every((w) => w === 1));
});

test('a starter-defaults file built from the module constants is valid', () => {
  const content = { schemaVersion: 1, tasks: ec.STARTER_TASKS, factors: ec.DEFAULT_FACTORS };
  assert.deepStrictEqual(ec.validateEstimationConfig(content), []);
});

// ── names ───────────────────────────────────────────────────────────────────
test('normalizeTaskName strips a leading [Testing] marker case-insensitively and trims; taskKey lowercases', () => {
  assert.strictEqual(ec.normalizeTaskName('[Testing] Test Execution'), 'Test Execution');
  assert.strictEqual(ec.normalizeTaskName('  [testing]Test Execution  '), 'Test Execution');
  assert.strictEqual(ec.normalizeTaskName('[TESTING]   Smoke Pass'), 'Smoke Pass');
  assert.strictEqual(ec.normalizeTaskName('Exploratory [Testing] Pass'), 'Exploratory [Testing] Pass', 'only a LEADING marker');
  assert.strictEqual(ec.normalizeTaskName('[Testing]'), '');
  assert.strictEqual(ec.taskKey(' [Testing] Test EXECUTION '), 'test execution');
});

// ── a valid file ────────────────────────────────────────────────────────────
test('valid file: state valid, content in file order with normalized names, enabledTasks = the enabled ones', () => {
  const raw = VALID();
  raw.tasks[0].name = '[Testing] Requirement Review';
  const r = loadKeepingBytes(raw);
  assert.strictEqual(r.state, 'valid', JSON.stringify(r));
  assert.deepStrictEqual(r.content.tasks.map((t) => t.name), ['Requirement Review', 'Test Creation', 'Test Execution', 'Automation']);
  assert.deepStrictEqual(r.enabledTasks.map((t) => t.name), ['Requirement Review', 'Test Creation', 'Test Execution']);
  assert.deepStrictEqual(Object.keys(r.content.factors), ['Scenarios / ACs', 'UI elements', 'Data setup']);
  assert.deepStrictEqual(r.content.source, raw.source);
});

test('missing file: state missing (nothing created)', () => {
  const dir = proj();
  assert.deepStrictEqual(ec.loadEstimationConfig(dir), { state: 'missing' });
  assert.ok(!fs.existsSync(path.join(dir, 'config')), 'a load never creates config/');
});

test('source is optional; an unknown source key is informational and ignored', () => {
  const c = VALID(); delete c.source;
  assert.deepStrictEqual(ec.validateEstimationConfig(c), []);
  const d = VALID(); d.source = { kind: 'anything', whatever: [1, 2], sprints: 3 };
  assert.deepStrictEqual(ec.validateEstimationConfig(d), []);
});

test('a zero weight is valid as long as one factor has a positive weight', () => {
  const c = VALID(); c.factors = { A: 0, B: 0.5 };
  assert.deepStrictEqual(ec.validateEstimationConfig(c), []);
});

test('off-grid min/max (0.75 h) are valid (UV13)', () => {
  assert.deepStrictEqual(ec.validateEstimationConfig(withTask(0, { minHours: 0.75, maxHours: 1.25 })), []);
});

// ── every invalid case in the AC list ───────────────────────────────────────
test('AC: JSON that cannot be parsed → parse-error naming the file and the position (line/column)', () => {
  const r = loadKeepingBytes('{\n  "schemaVersion": 1,\n  "tasks": [ }\n');
  assert.strictEqual(r.state, 'invalid');
  assert.deepStrictEqual(codes(r.problems), ['parse-error']);
  assert.match(r.problems[0].message, /^config\/estimation\.json: /);
  assert.match(r.problems[0].message, /line 3, column \d+/);
  const empty = loadKeepingBytes('');
  assert.deepStrictEqual(codes(empty.problems), ['parse-error']);
});

test('a UTF-8 byte-order mark is a named hard stop (parse-error), never stripped or repaired', () => {
  const raw = '﻿' + JSON.stringify(VALID(), null, 2);
  const r = loadKeepingBytes(raw);
  assert.strictEqual(r.state, 'invalid');
  assert.deepStrictEqual(codes(r.problems), ['parse-error']);
  assert.strictEqual(r.problems[0].message,
    'config/estimation.json: the file starts with a byte-order mark (BOM) — save it as UTF-8 without BOM');
});

test('AC: minHours > maxHours → min-greater-than-max, the message names the file, the problem and the entry', () => {
  const r = loadKeepingBytes(withTask(2, { minHours: 4, maxHours: 2 }));
  assert.strictEqual(r.state, 'invalid');
  assert.deepStrictEqual(codes(r.problems), ['min-greater-than-max']);
  assert.strictEqual(r.problems[0].message,
    'config/estimation.json: tasks[2] ("Test Execution"): minHours 4 is greater than maxHours 2');
  assert.strictEqual(r.problems[0].path, 'tasks[2]');
  assert.strictEqual(r.problems[0].entry, 'Test Execution');
});

test('AC: a min or max that is missing, not a number, or ≤ 0', () => {
  const missing = VALID(); delete missing.tasks[1].maxHours;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(missing)), ['hours-missing']);
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(withTask(1, { minHours: '1' }))), ['hours-not-number']);
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(withTask(1, { minHours: null }))), ['hours-not-number']);
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(withTask(1, { minHours: 0 }))), ['hours-not-positive']);
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(withTask(1, { maxHours: -2 }))), ['hours-not-positive']);
  const p = ec.validateEstimationConfig(withTask(1, { minHours: '1' }))[0];
  assert.strictEqual(p.path, 'tasks[1].minHours');
  assert.match(p.message, /tasks\[1\] \("Test Creation"\): minHours/);
});

test('AC: no enabled task → no-enabled-task', () => {
  const c = VALID(); c.tasks.forEach((t) => { t.enabled = false; });
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['no-enabled-task']);
});

test('AC: two tasks with the same name (case, whitespace and the marker ignored) → name-duplicate naming both entries', () => {
  const c = VALID(); c.tasks.push({ name: ' [Testing] test creation ', enabled: true, minHours: 1, maxHours: 2 });
  const p = ec.validateEstimationConfig(c);
  assert.deepStrictEqual(codes(p), ['name-duplicate']);
  assert.match(p[0].message, /tasks\[4\]/);
  assert.match(p[0].message, /tasks\[1\]/);
});

test('AC: no factor with a positive weight → no-positive-weight', () => {
  const c = VALID(); c.factors = { A: 0, B: 0 };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['no-positive-weight']);
});

test('AC: a sprint count that is not a positive whole number → sprints-not-positive-integer', () => {
  for (const sprints of [0, -1, 1.5, '2', null]) {
    const c = VALID(); c.source.sprints = sprints;
    assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['sprints-not-positive-integer'], JSON.stringify(sprints));
  }
});

test('AC: an unknown schema version → schema-version (missing too)', () => {
  const c = VALID(); c.schemaVersion = 2;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['schema-version']);
  const d = VALID(); delete d.schemaVersion;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(d)), ['schema-version']);
});

// ── every other problem code ────────────────────────────────────────────────
test('unknown keys at the top level and inside a task entry are rejected and named', () => {
  const c = VALID(); c.historySprints = 2; c.tasks[0].hours = 3;
  const p = ec.validateEstimationConfig(c);
  assert.deepStrictEqual(codes(p), ['unknown-key', 'unknown-key']);
  assert.ok(p.some((x) => /historySprints/.test(x.message)));
  assert.ok(p.some((x) => /tasks\[0\] \("Requirement Review"\): unknown key "hours"/.test(x.message)));
});

test('tasks-missing, task-not-object, name-missing, enabled-not-boolean', () => {
  const a = VALID(); delete a.tasks;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(a)), ['tasks-missing']);
  const b = VALID(); b.tasks = [];
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(b)), ['tasks-missing']);
  const c = VALID(); c.tasks = { name: 'x' };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['tasks-missing']);
  const d = VALID(); d.tasks.splice(1, 0, 'Test Creation');
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(d)), ['task-not-object']);
  for (const name of [undefined, '', '   ', '[Testing]', 7]) {
    const e = withTask(0, { name });
    assert.deepStrictEqual(codes(ec.validateEstimationConfig(e)), ['name-missing'], JSON.stringify(name));
  }
  const f = withTask(0, { enabled: 'yes' });
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(f)), ['enabled-not-boolean']);
  const g = VALID(); delete g.tasks[0].enabled;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(g)), ['enabled-not-boolean']);
});

test('factors-missing, factor-name-empty, factor-name-duplicate, weight-not-number, weight-negative', () => {
  const a = VALID(); delete a.factors;
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(a)), ['factors-missing']);
  const b = VALID(); b.factors = {};
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(b)), ['factors-missing']);
  const c = VALID(); c.factors = [{ name: 'A', weight: 1 }];
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['factors-missing']);
  const d = VALID(); d.factors = { A: 1, '  ': 1 };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(d)), ['factor-name-empty']);
  const e = VALID(); e.factors = { 'UI elements': 1, ' ui ELEMENTS': 2 };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(e)), ['factor-name-duplicate']);
  const f = VALID(); f.factors = { A: '1', B: 1 };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(f)), ['weight-not-number']);
  const g = VALID(); g.factors = { A: -1, B: 1 };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(g)), ['weight-negative']);
});

test('source-not-object', () => {
  for (const source of ['history', [1], null, 3]) {
    const c = VALID(); c.source = source;
    assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), ['source-not-object'], JSON.stringify(source));
  }
});

test('a top level that is not a JSON object is reported (parse-error), never thrown', () => {
  for (const raw of ['[]', '"x"', 'null', '3']) {
    const r = loadKeepingBytes(raw);
    assert.strictEqual(r.state, 'invalid', raw);
    assert.deepStrictEqual(codes(r.problems), ['parse-error'], raw);
    assert.match(r.problems[0].message, /JSON object/);
  }
});

test('duplicate JSON keys are rejected (top-level and factor) even though JSON.parse keeps the last', () => {
  const top = '{"schemaVersion":1,"tasks":[{"name":"A","enabled":true,"minHours":1,"maxHours":2}],' +
    '"factors":{"X":1},"factors":{"Y":1}}';
  const r1 = loadKeepingBytes(top);
  assert.strictEqual(r1.state, 'invalid');
  assert.deepStrictEqual(codes(r1.problems), ['duplicate-key']);
  assert.match(r1.problems[0].message, /"factors"/);
  const factor = '{"schemaVersion":1,"tasks":[{"name":"A","enabled":true,"minHours":1,"maxHours":2}],' +
    '"factors":{"Validations":1,"Edge cases":1,"Validations":0}}';
  const r2 = loadKeepingBytes(factor);
  assert.deepStrictEqual(codes(r2.problems), ['duplicate-key']);
  assert.match(r2.problems[0].message, /"Validations"/);
  assert.strictEqual(r2.problems[0].path, 'factors');
  const inTask = '{"schemaVersion":1,"tasks":[{"name":"A","enabled":true,"minHours":1,"maxHours":2,"maxHours":3}],"factors":{"X":1}}';
  assert.deepStrictEqual(codes(loadKeepingBytes(inTask).problems), ['duplicate-key']);
  // The same key in two DIFFERENT objects is not a duplicate.
  const ok = '{"schemaVersion":1,"tasks":[{"name":"A","enabled":true,"minHours":1,"maxHours":2},' +
    '{"name":"B","enabled":true,"minHours":1,"maxHours":2}],"factors":{"name":1}}';
  assert.strictEqual(loadKeepingBytes(ok).state, 'valid');
});

test('EVERY problem is reported at once, in document order', () => {
  const c = {
    schemaVersion: 3,
    tasks: [
      { name: 'Test Execution', enabled: true, minHours: 4, maxHours: 2 },
      { name: 'Test Creation', enabled: true, minHours: 1, maxHours: 2 },
      { name: 'test creation', enabled: 'no', minHours: 0, maxHours: 2 },
    ],
    factors: { A: -1 },
    source: { sprints: 0 },
    extra: true,
  };
  assert.deepStrictEqual(codes(ec.validateEstimationConfig(c)), [
    'schema-version', 'min-greater-than-max', 'name-duplicate', 'enabled-not-boolean', 'hours-not-positive',
    'weight-negative', 'no-positive-weight', 'sprints-not-positive-integer', 'unknown-key',
  ]);
});

test('every problem has {code, path, message} and every message starts with the file', () => {
  const c = VALID(); c.schemaVersion = 0; c.tasks[0].minHours = -1; c.factors = { '': 1 };
  for (const p of ec.validateEstimationConfig(c)) {
    assert.strictEqual(typeof p.code, 'string');
    assert.strictEqual(typeof p.path, 'string');
    assert.ok(p.message.startsWith('config/estimation.json: '), p.message);
  }
});

test('reading never writes: bytes unchanged after every invalid case and a valid one', () => {
  const raws = ['{', '{"schemaVersion":1}', JSON.stringify(withTask(0, { minHours: 9 })), '﻿{}', JSON.stringify(VALID())];
  for (const raw of raws) loadKeepingBytes(raw);
});

// ── exclusive create ────────────────────────────────────────────────────────
test('serializeEstimationConfig: two-space JSON plus a trailing newline', () => {
  const c = VALID();
  assert.strictEqual(ec.serializeEstimationConfig(c), JSON.stringify(c, null, 2) + '\n');
});

test('createEstimationFileExclusive creates config/ when missing and writes the exact serialization', () => {
  const dir = proj();
  const c = VALID();
  ec.createEstimationFileExclusive(dir, c);
  assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), ec.serializeEstimationConfig(c));
  assert.strictEqual(ec.loadEstimationConfig(dir).state, 'valid');
});

test('createEstimationFileExclusive: EEXIST → a named error, the existing bytes unchanged, never truncated', () => {
  const existing = '{"hand": "edited"}\n';
  const dir = proj(existing);
  let err;
  try { ec.createEstimationFileExclusive(dir, VALID()); } catch (e) { err = e; }
  assert.ok(err, 'expected a refusal');
  assert.strictEqual(err.name, 'EstimationFileExistsError');
  assert.strictEqual(err.code, 'estimation-file-exists');
  assert.strictEqual(err.message, "config/estimation.json appeared after this run's checks — not replaced");
  assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), existing);
});

test('the module is pure config code: no tracker require, no child_process, no process.exit', () => {
  const src = fs.readFileSync(path.join(__dirname, 'estimation_config.js'), 'utf8');
  assert.ok(!/tracker/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no tracker code');
  assert.ok(!/child_process|process\.exit\(/.test(src));
  for (const m of src.matchAll(/require\(([^)]*)\)/g)) assert.match(m[1], /^'node:/, `only node: builtins (${m[1]})`);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
