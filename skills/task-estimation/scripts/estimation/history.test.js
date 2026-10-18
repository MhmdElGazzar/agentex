'use strict';
// Tests for the first-run proposal engine (estimation/history.js): grouping,
// min/max, outliers, the outlier choices, gate edits, starter defaults, and the
// recompute that the dry run and --execute rely on.
// Run: node skills/task-estimation/scripts/estimation/history.test.js
// Pure: no I/O, no tracker, no clock (createdOn is an input).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const history = require('./history.js');
const ec = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'estimation_config.js'));

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CREATED_ON = '2026-10-18';
const story = (n) => ({ ref: 2100 + n, title: `Story ${n}`, url: `https://tracker.example/${2100 + n}`, seq: 2100 + n });
let nextRef = 4500;
const pt = (title, hours, s, extra = {}) => {
  const ref = extra.ref ?? ++nextRef;
  return { ref, title, hours, seq: extra.seq ?? ref, parent: story(s), ...extra };
};
const hist = (points, extra = {}) => ({
  sprintsRequested: 2,
  sprints: [{ id: 42, name: 'Sprint 42' }, { id: 41, name: 'Sprint 41' }],
  storiesRead: 12, points, truncated: false, reason: null, reasonMessage: null, ...extra,
});
const propose = (h) => history.propose(h, { createdOn: CREATED_ON });
const reasons = (problems) => problems.map((p) => p.reason);
const group = (p, name) => p.groups.find((g) => g.name === name);

// ── grouping ────────────────────────────────────────────────────────────────
test('grouping: case, surrounding whitespace and the [Testing] marker are ignored; one task per name', () => {
  const p = propose(hist([
    pt('[Testing] Test Execution', 2, 1), pt('[testing]test execution ', 3, 2), pt('[Testing]   TEST EXECUTION', 1, 3),
    pt('[Testing] Requirement Review', 1, 1),
  ]));
  assert.strictEqual(p.kind, 'history');
  assert.deepStrictEqual(p.groups.map((g) => g.key), ['test execution', 'requirement review']);
  assert.deepStrictEqual(p.content.tasks.map((t) => t.name), ['Test Execution', 'Requirement Review']);
  assert.ok(p.content.tasks.every((t) => t.enabled === true), 'every name found becomes an enabled task (A4)');
});

test('display name: the most frequent exact spelling wins; ties go to the first seen', () => {
  const p = propose(hist([
    pt('[Testing] test creation', 1, 1), pt('[Testing] Test Creation', 1, 2), pt('[Testing] Test Creation', 1, 3),
    pt('[Testing] Smoke pass', 1, 1), pt('[Testing] Smoke Pass', 1, 2),
  ]));
  assert.deepStrictEqual(p.content.tasks.map((t) => t.name), ['Test Creation', 'Smoke pass']);
});

test('order: points sorted by (story seq, task seq); task order = first-seen order of names', () => {
  const p = propose(hist([
    pt('[Testing] Test Execution', 2, 2, { seq: 10 }),
    pt('[Testing] Automation', 1, 1, { seq: 30 }),
    pt('[Testing] Requirement Review', 1, 1, { seq: 20 }),
  ]));
  assert.deepStrictEqual(p.content.tasks.map((t) => t.name), ['Requirement Review', 'Automation', 'Test Execution']);
});

test('min/max = the lowest and highest Original Estimate per name; stories = distinct stories counted', () => {
  const p = propose(hist([pt('[Testing] A', 2, 1), pt('[Testing] A', 0.5, 2), pt('[Testing] A', 1.5, 2), pt('[Testing] B', 3, 3)]));
  assert.deepStrictEqual(p.content.tasks.map((t) => [t.name, t.minHours, t.maxHours]), [['A', 0.5, 2], ['B', 3, 3]]);
  assert.strictEqual(group(p, 'A').stories, 2);
  assert.strictEqual(group(p, 'B').stories, 1);
});

test('skips: no estimate is skipped and counted, never an outlier; a name with no estimate at all is listed, not proposed', () => {
  const p = propose(hist([
    pt('[Testing] A', 1, 1), pt('[Testing] A', null, 2), pt('[Testing] A', 1, 3), pt('[Testing] A', 1, 4),
    pt('[Testing] Ghost', null, 1), pt('[Testing] Ghost', null, 2),
    pt('[Testing]', 2, 3), pt('[Testing]   ', 2, 4),
  ]));
  assert.deepStrictEqual(p.content.tasks.map((t) => t.name), ['A']);
  assert.strictEqual(p.provenance.tasksCounted, 3);
  assert.strictEqual(p.provenance.tasksSkipped, 5, '1 + 2 without an estimate, 2 with an empty name');
  assert.deepStrictEqual(p.provenance.namesWithoutEstimates, ['Ghost']);
  assert.deepStrictEqual(history.outliersOf(p), []);
});

test('a task ref seen twice (a carried-over story) is counted once', () => {
  const p = propose(hist([pt('[Testing] A', 1, 1, { ref: 9 }), pt('[Testing] A', 1, 1, { ref: 9 }), pt('[Testing] A', 2, 2)]));
  assert.strictEqual(p.provenance.tasksCounted, 2);
  assert.strictEqual(group(p, 'A').points.length, 2);
});

// ── outliers ────────────────────────────────────────────────────────────────
test('outliers: fewer than OUTLIER_MIN_SAMPLE estimates are never checked', () => {
  const p = propose(hist([pt('[Testing] A', 1, 1), pt('[Testing] A', 30, 2)]));
  assert.deepStrictEqual(history.outliersOf(p), []);
  assert.deepStrictEqual([p.content.tasks[0].minHours, p.content.tasks[0].maxHours], [1, 30]);
});

test('outliers: a HIGH value (> median × 3) — normal range, suggested = the normal max, used by default (A3)', () => {
  const p = propose(hist([pt('[Testing] Test Execution', 1, 1), pt('[Testing] Test Execution', 2, 2),
    pt('[Testing] Test Execution', 3, 3), pt('[Testing] Test Execution', 12, 4, { ref: 4520 })]));
  const o = history.outliersOf(p);
  assert.strictEqual(o.length, 1);
  assert.deepStrictEqual(o[0], {
    ref: 4520, task: 'Test Execution', story: { ref: 2104, title: 'Story 4', url: 'https://tracker.example/2104' },
    hours: 12, side: 'high', normalRange: [1, 3], suggested: 3, choice: 'suggested', used: 3,
  });
  assert.deepStrictEqual([p.content.tasks[0].minHours, p.content.tasks[0].maxHours], [1, 3], 'the suggested value is in use');
});

test('outliers: a LOW value (< median ÷ 3) — suggested = the normal min; strict comparisons', () => {
  const p = propose(hist([pt('[Testing] A', 3, 1), pt('[Testing] A', 3, 2), pt('[Testing] A', 0.5, 3, { ref: 77 }), pt('[Testing] A', 1, 4)]));
  // median of [0.5, 1, 3, 3] = 2 → low < 0.667: 0.5 flagged; high > 6: none; 1 is not low (strict)
  const o = history.outliersOf(p);
  assert.deepStrictEqual(o.map((x) => [x.ref, x.side, x.suggested]), [[77, 'low', 1]]);
  assert.deepStrictEqual(o[0].normalRange, [1, 3]);
  const edge = propose(hist([pt('[Testing] B', 3, 1), pt('[Testing] B', 1, 2), pt('[Testing] B', 9, 3)]));
  assert.deepStrictEqual(history.outliersOf(edge), [], 'exactly median × 3 is not flagged');
});

test('outliers: even-n median = the mean of the two middles; the normal set is never empty', () => {
  const p = propose(hist([pt('[Testing] A', 1, 1), pt('[Testing] A', 1, 2), pt('[Testing] A', 10, 3), pt('[Testing] A', 10, 4)]));
  // median 5.5 → low < 1.83: both 1s; high > 16.5: none
  const o = history.outliersOf(p);
  assert.deepStrictEqual(o.map((x) => x.side), ['low', 'low']);
  assert.deepStrictEqual(o[0].normalRange, [10, 10]);
  assert.strictEqual(history.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(history.median([5, 1, 3]), 3);
});

// ── choices and gate edits ──────────────────────────────────────────────────
const OUTLIER_HIST = () => hist([pt('[Testing] Test Execution', 1, 1), pt('[Testing] Test Execution', 2, 2),
  pt('[Testing] Test Execution', 3, 3), pt('[Testing] Test Execution', 12, 4, { ref: 4520 }),
  pt('[Testing] Requirement Review', 1, 1), pt('[Testing] Requirement Review', 2, 2)]);

test('choices: count keeps the value; a typed number replaces it (rounded to 2 decimals); min/max recomputed', () => {
  const p = propose(OUTLIER_HIST());
  const counted = history.recompute(p, { outlierChoices: { 4520: 'count' } });
  assert.deepStrictEqual(counted.problems, []);
  assert.deepStrictEqual([counted.content.tasks[0].minHours, counted.content.tasks[0].maxHours], [1, 12]);
  assert.deepStrictEqual([counted.outliers[0].choice, counted.outliers[0].used], ['count', 12]);
  const typed = history.recompute(p, { outlierChoices: { 4520: 5.256 } });
  assert.deepStrictEqual([typed.content.tasks[0].minHours, typed.content.tasks[0].maxHours], [1, 5.26]);
  assert.strictEqual(typed.outliers[0].used, 5.26);
  const sug = history.recompute(p, { outlierChoices: { 4520: 'suggested' } });
  assert.strictEqual(sug.content.tasks[0].maxHours, 3);
  assert.deepStrictEqual(sug.groups.map((g) => [g.name, g.stories, g.min, g.max]), [['Test Execution', 4, 1, 3], ['Requirement Review', 2, 1, 2]]);
});

test('choices: anything else, or a ref that is not a flagged value, is bad-outlier-choice (asked again)', () => {
  const p = propose(OUTLIER_HIST());
  for (const choice of [0, -2, 'maybe', null, '5', true]) {
    assert.deepStrictEqual(reasons(history.recompute(p, { outlierChoices: { 4520: choice } }).problems), ['bad-outlier-choice'], JSON.stringify(choice));
  }
  assert.deepStrictEqual(reasons(history.recompute(p, { outlierChoices: { 99999: 'count' } }).problems), ['bad-outlier-choice']);
  const notFlagged = group(p, 'Test Execution').points[0].ref;
  assert.deepStrictEqual(reasons(history.recompute(p, { outlierChoices: { [notFlagged]: 'count' } }).problems), ['bad-outlier-choice']);
});

test('taskEdits: disable a task or change its min/max at the gate; anything else is bad-task-edit', () => {
  const p = propose(OUTLIER_HIST());
  const r = history.recompute(p, { taskEdits: { 'requirement review': { enabled: false }, 'Test Execution': { minHours: 0.5, maxHours: 4 } } });
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(r.content.tasks.map((t) => [t.name, t.enabled, t.minHours, t.maxHours]),
    [['Test Execution', true, 0.5, 4], ['Requirement Review', false, 1, 2]]);
  for (const edits of [{ Nope: { enabled: false } }, { 'Test Execution': { name: 'X' } }, { 'Test Execution': { enabled: 'no' } },
    { 'Test Execution': { minHours: '1' } }, { 'Test Execution': 'off' }]) {
    assert.deepStrictEqual(reasons(history.recompute(p, { taskEdits: edits }).problems), ['bad-task-edit'], JSON.stringify(edits));
  }
});

test('the edited proposal is validated like a file: an invalid result blocks with the validator\'s problems', () => {
  const p = propose(OUTLIER_HIST());
  const r = history.recompute(p, { taskEdits: { 'Test Execution': { minHours: 5 }, 'Requirement Review': { enabled: false } } });
  assert.deepStrictEqual(reasons(r.problems), ['estimation-proposal-invalid']);
  assert.deepStrictEqual(r.problems[0].problems.map((x) => x.code), ['min-greater-than-max']);
  const none = history.recompute(p, { taskEdits: { 'Test Execution': { enabled: false }, 'Requirement Review': { enabled: false } } });
  assert.deepStrictEqual(none.problems[0].problems.map((x) => x.code), ['no-enabled-task']);
});

// ── the file content and its provenance ─────────────────────────────────────
test('content: a valid schemaVersion-1 file with the default factors and a history provenance record', () => {
  const p = propose(OUTLIER_HIST());
  assert.deepStrictEqual(ec.validateEstimationConfig(p.content), []);
  assert.deepStrictEqual(Object.keys(p.content), ['schemaVersion', 'tasks', 'factors', 'source']);
  assert.deepStrictEqual(p.content.factors, ec.DEFAULT_FACTORS);
  assert.deepStrictEqual(p.content.source, {
    kind: 'history', sprints: 2, sprintsRead: ['Sprint 42', 'Sprint 41'], tasksCounted: 6, tasksSkipped: 0,
    createdOn: CREATED_ON, note: p.content.source.note,
  });
  assert.match(p.content.source.note, /delete or move this file/);
  assert.deepStrictEqual(p.provenance, {
    sprintsRequested: 2, sprintsRead: ['Sprint 42', 'Sprint 41'], storiesRead: 12, tasksCounted: 6, tasksSkipped: 0,
    namesWithoutEstimates: [], truncated: false, reason: null, reasonMessage: null,
  });
  assert.deepStrictEqual(p.threshold, { ratio: 3, minSample: 3 });
  assert.strictEqual(p.proposalVersion, 1);
});

test('fewer closed sprints than requested: the ones that exist are read and the record says so', () => {
  const p = propose(hist([pt('[Testing] A', 1, 1)], { sprintsRequested: 3, sprints: [{ id: 41, name: 'Sprint 41' }] }));
  assert.strictEqual(p.content.source.sprints, 3);
  assert.deepStrictEqual(p.content.source.sprintsRead, ['Sprint 41']);
});

// ── starter defaults ────────────────────────────────────────────────────────
test('starter defaults for each reason: five enabled tasks, Σmin 3.0, Σmax 5.0, eight factors, labelled with the reason', () => {
  const cases = [
    ['no-closed-sprints', hist([], { sprints: [], storiesRead: 0, reason: 'no-closed-sprints', reasonMessage: 'no closed sprint found' })],
    ['no-testing-tasks', hist([], { reason: 'no-testing-tasks', reasonMessage: 'no [Testing] task in those sprints' })],
    ['no-estimates', hist([pt('[Testing] A', null, 1), pt('[Testing] B', null, 2)], { reason: 'no-estimates', reasonMessage: 'none has an Original Estimate' })],
  ];
  for (const [reason, h] of cases) {
    const p = propose(h);
    assert.strictEqual(p.kind, 'starter-defaults', reason);
    assert.deepStrictEqual(p.content.tasks, ec.STARTER_TASKS.map((t) => ({ ...t })));
    assert.strictEqual(p.content.tasks.reduce((s, t) => s + t.minHours, 0), 3);
    assert.strictEqual(p.content.tasks.reduce((s, t) => s + t.maxHours, 0), 5);
    assert.strictEqual(Object.keys(p.content.factors).length, 8);
    assert.strictEqual(p.content.source.kind, 'starter-defaults');
    assert.strictEqual(p.content.source.reason, reason);
    assert.match(p.content.source.note, /starter defaults/i);
    assert.strictEqual(p.provenance.reason, reason);
    assert.strictEqual(p.groups.length, 0);
    assert.deepStrictEqual(history.outliersOf(p), [], 'starter defaults never carry outliers');
    assert.deepStrictEqual(ec.validateEstimationConfig(p.content), []);
  }
});

test('starter defaults can be edited at the gate too (disable Automation)', () => {
  const p = propose(hist([], { sprints: [], reason: 'no-closed-sprints', reasonMessage: 'x' }));
  const r = history.recompute(p, { taskEdits: { Automation: { enabled: false } } });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.content.tasks.find((t) => t.name === 'Automation').enabled, false);
});

// ── recompute: the scratch file supplies data, never decisions ──────────────
test('recompute from groups ignores a tampered content (and tampered factors/threshold)', () => {
  const p = propose(OUTLIER_HIST());
  const clean = history.recompute(p, {});
  const tampered = JSON.parse(JSON.stringify(p));
  tampered.content.tasks[0].maxHours = 99;
  tampered.content.factors = { Anything: 5 };
  tampered.factors = { Anything: 5 };
  tampered.threshold = { ratio: 100, minSample: 99 };
  const again = history.recompute(tampered, {});
  assert.deepStrictEqual(again.content, clean.content);
  assert.deepStrictEqual(again.content, p.content);
  assert.deepStrictEqual(again.outliers, clean.outliers);
});

test('checkProposal: a malformed scratch file is named, never trusted', () => {
  const p = propose(OUTLIER_HIST());
  assert.strictEqual(history.checkProposal(p), null);
  for (const bad of [null, [], { ...p, proposalVersion: 2 }, { ...p, kind: 'guess' }, { ...p, groups: {} },
    { ...p, groups: [{ key: 'a', name: 'A', stories: 1, points: [{ ref: 1, hours: -1, story: {} }] }] },
    { ...p, provenance: null }, { ...p, createdOn: 7 }]) {
    assert.strictEqual(typeof history.checkProposal(bad), 'string', JSON.stringify(bad).slice(0, 80));
  }
});

test('determinism: the same history gives the same proposal, byte for byte', () => {
  const h = OUTLIER_HIST();
  assert.strictEqual(JSON.stringify(propose(h)), JSON.stringify(propose(JSON.parse(JSON.stringify(h)))));
});

test('history.js is pure: no I/O requires, no provider words, no CompletedWork/time-spent reads', () => {
  const src = fs.readFileSync(path.join(__dirname, 'history.js'), 'utf8');
  for (const m of src.matchAll(/require\(([^)]*)\)/g)) {
    assert.ok(/^'node:path'$|^'\.\/|^path\.join\(__dirname/.test(m[1].trim()), m[1]);
  }
  assert.ok(!/\bfs\b\.|child_process|fetch\(/.test(src));
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\b(ado|jira|azure)\b/i.test(code));
  assert.ok(!/CompletedWork|timespent/i.test(src));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
