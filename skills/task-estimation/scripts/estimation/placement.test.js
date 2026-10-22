'use strict';
// Tests for the deterministic score → hours placement (estimation/placement.js)
// and the tunable defaults it reads (estimation/defaults.js).
// Run: node skills/task-estimation/scripts/estimation/placement.test.js
// Pure: no I/O, no tracker, no clock.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./defaults.js');
const placement = require('./placement.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CONTENT = () => ({
  schemaVersion: 1,
  tasks: [
    { name: 'Requirement Review', enabled: true, minHours: 0.5, maxHours: 2 },
    { name: 'Test Creation', enabled: true, minHours: 1, maxHours: 4 },
    { name: 'Smoke Pass', enabled: false, minHours: 1, maxHours: 1 },
    { name: 'Test Execution', enabled: true, minHours: 1, maxHours: 3 },
  ],
  factors: { 'Scenarios / ACs': 1, 'UI elements': 2, 'Data setup': 0 },
});
const all = (content, r) => Object.fromEntries(Object.keys(content.factors).map((f) => [f, r]));
const reasons = (problems) => problems.map((p) => p.reason);

test('defaults: the 0–4 rating scale, the half-hour step and the outlier tunables', () => {
  assert.strictEqual(defaults.RATING_MIN, 0);
  assert.strictEqual(defaults.RATING_MAX, 4);
  assert.strictEqual(defaults.HOURS_STEP, 0.5);
  assert.strictEqual(defaults.OUTLIER_RATIO, 3);
  assert.strictEqual(defaults.OUTLIER_MIN_SAMPLE, 3);
});

// ── score ───────────────────────────────────────────────────────────────────
test('score: weighted sum over 4·weight; weights change the score', () => {
  assert.strictEqual(placement.score({ A: 1, B: 3 }, { A: 4, B: 0 }), 0.25);
  assert.strictEqual(placement.score({ A: 3, B: 1 }, { A: 4, B: 0 }), 0.75, 'the same ratings, re-weighted, move the score');
  assert.strictEqual(placement.score({ A: 1, B: 1 }, { A: 2, B: 2 }), 0.5);
});

test('score: zero-weight factors are rated but excluded from the score', () => {
  assert.strictEqual(placement.score({ A: 1, Z: 0 }, { A: 2, Z: 4 }), 0.5);
  assert.strictEqual(placement.score({ A: 1, Z: 0 }, { A: 2, Z: 0 }), 0.5);
});

test('score: all 0 → exactly 0; all 4 → exactly 1, even with float-unfriendly weights', () => {
  for (const factors of [{ A: 1 }, { A: 0.1, B: 0.2, C: 0.7 }, { A: 1 / 3, B: 2 / 7, C: 0.3, D: 9.99 }]) {
    const names = Object.keys(factors);
    assert.strictEqual(placement.score(factors, Object.fromEntries(names.map((n) => [n, 0]))), 0);
    assert.strictEqual(placement.score(factors, Object.fromEntries(names.map((n) => [n, 4]))), 1);
  }
});

// ── placement ───────────────────────────────────────────────────────────────
test('placeHours: exact endpoints, on-grid and off-grid', () => {
  assert.strictEqual(placement.placeHours(0, 0.5, 2), 0.5);
  assert.strictEqual(placement.placeHours(1, 0.5, 2), 2);
  assert.strictEqual(placement.placeHours(0, 0.75, 1.25), 0.75);
  assert.strictEqual(placement.placeHours(1, 0.75, 1.25), 1.25);
});

test('placeHours: interior values on half-hours, rounded half-up', () => {
  assert.strictEqual(placement.placeHours(0.25, 1, 3), 1.5);   // raw 1.5
  assert.strictEqual(placement.placeHours(0.375, 1, 3), 2);    // raw 1.75 → up
  assert.strictEqual(placement.placeHours(0.125, 1, 3), 1.5);  // raw 1.25 → up
  assert.strictEqual(placement.placeHours(0.1, 1, 3), 1);      // raw 1.2  → down
  assert.strictEqual(placement.placeHours(0.5, 0.5, 0.5), 0.5, 'min = max');
});

test('placeHours: clamped into [min, max] when rounding would leave the range', () => {
  assert.strictEqual(placement.placeHours(0.5, 0.75, 0.9), 0.9);  // raw 0.825 → 1 → clamp 0.9
  assert.strictEqual(placement.placeHours(0.01, 0.75, 1.25), 1);
});

test('PROPERTY: 10,000 random files and ratings stay within [min, max]; extremes hit the endpoints exactly', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 10000; n++) {
    const a = Math.round((0.05 + rnd() * 10) * 100) / 100;
    const b = Math.round((0.05 + rnd() * 10) * 100) / 100;
    const [m, M] = a <= b ? [a, b] : [b, a];
    const factors = {};
    const k = 1 + Math.floor(rnd() * 9);
    for (let i = 0; i < k; i++) factors[`F${i}`] = Math.round(rnd() * 500) / 100;
    factors.F0 = factors.F0 || 1;
    const ratings = Object.fromEntries(Object.keys(factors).map((f) => [f, Math.floor(rnd() * 5)]));
    const h = placement.placeHours(placement.score(factors, ratings), m, M);
    assert.ok(h >= m && h <= M, `h ${h} outside [${m}, ${M}]`);
    const lo = placement.placeHours(placement.score(factors, Object.fromEntries(Object.keys(factors).map((f) => [f, 0]))), m, M);
    const hi = placement.placeHours(placement.score(factors, Object.fromEntries(Object.keys(factors).map((f) => [f, 4]))), m, M);
    assert.strictEqual(lo, m);
    assert.strictEqual(hi, M);
  }
});

// ── per-story derivation ────────────────────────────────────────────────────
test('deriveStory: exactly the enabled tasks, in file order, titled "[Testing] <name>", hours in range, total', () => {
  const c = CONTENT();
  const r = placement.deriveStory(c, { id: 2101, ratings: { 'Scenarios / ACs': 2, 'UI elements': 2, 'Data setup': 3 } });
  assert.deepStrictEqual(r.problems, []);
  const s = r.story;
  assert.strictEqual(s.id, 2101);
  assert.deepStrictEqual(s.tasks.map((t) => t.title), ['[Testing] Requirement Review', '[Testing] Test Creation', '[Testing] Test Execution']);
  assert.strictEqual(s.score, 0.5);
  assert.strictEqual(s.scorePct, 50);
  assert.deepStrictEqual(s.tasks.map((t) => t.hours), [1.5, 2.5, 2]);
  assert.deepStrictEqual(s.tasks.map((t) => [t.minHours, t.maxHours]), [[0.5, 2], [1, 4], [1, 3]]);
  assert.strictEqual(s.total, 6);
  assert.deepStrictEqual(s.ratings, { 'Scenarios / ACs': 2, 'UI elements': 2, 'Data setup': 3 });
});

test('deriveStory: lowest on every factor → each task\'s min; highest → each task\'s max', () => {
  const c = CONTENT();
  const lo = placement.deriveStory(c, { id: 1, ratings: all(c, 0) }).story;
  const hi = placement.deriveStory(c, { id: 1, ratings: all(c, 4) }).story;
  assert.deepStrictEqual(lo.tasks.map((t) => t.hours), [0.5, 1, 1]);
  assert.deepStrictEqual(hi.tasks.map((t) => t.hours), [2, 4, 3]);
  assert.strictEqual(lo.score, 0); assert.strictEqual(hi.score, 1);
});

test('deriveStory: a name carrying the marker never doubles the prefix', () => {
  const c = CONTENT(); c.tasks[0].name = '[Testing] Requirement Review';
  const s = placement.deriveStory(c, { id: 1, ratings: all(c, 1) }).story;
  assert.strictEqual(s.tasks[0].title, '[Testing] Requirement Review');
  assert.strictEqual(s.tasks[0].name, 'Requirement Review');
});

test('deriveStory: rating keys match the file\'s factors case-insensitively and trimmed; output keyed by the file\'s names', () => {
  const c = CONTENT();
  const s = placement.deriveStory(c, { id: 1, ratings: { ' scenarios / acs ': 1, 'UI ELEMENTS': 3, 'data setup': 0 } }).story;
  assert.deepStrictEqual(s.ratings, { 'Scenarios / ACs': 1, 'UI elements': 3, 'Data setup': 0 });
});

test('ratings validation: missing-rating, unknown-factor, bad-rating — every finding at once', () => {
  const c = CONTENT();
  const r = placement.deriveStory(c, { id: 7, ratings: { 'Scenarios / ACs': 5, 'Edge cases': 1, 'Data setup': '2' } });
  assert.strictEqual(r.story, undefined);
  assert.deepStrictEqual(reasons(r.problems).sort(), ['bad-rating', 'bad-rating', 'missing-rating', 'unknown-factor']);
  const missing = r.problems.find((p) => p.reason === 'missing-rating');
  assert.strictEqual(missing.story, 7);
  assert.strictEqual(missing.factor, 'UI elements');
  assert.match(missing.message, /story 7/);
  for (const bad of [-1, 1.5, null, true]) {
    const x = placement.deriveStory(c, { id: 1, ratings: { ...all(c, 1), 'UI elements': bad } });
    assert.deepStrictEqual(reasons(x.problems), ['bad-rating'], JSON.stringify(bad));
  }
  const none = placement.deriveStory(c, { id: 1 });
  assert.deepStrictEqual(reasons(none.problems), ['missing-rating', 'missing-rating', 'missing-rating']);
  const twice = placement.deriveStory(c, { id: 1, ratings: { ...all(c, 1), 'ui elements': 2 } });
  assert.deepStrictEqual(reasons(twice.problems), ['bad-rating']);
});

test('a factor added to the file must be rated; a removed one cannot appear', () => {
  const c = CONTENT();
  c.factors['Accessibility'] = 1;
  assert.deepStrictEqual(reasons(placement.deriveStory(c, { id: 1, ratings: all(CONTENT(), 2) }).problems), ['missing-rating']);
  const d = CONTENT(); delete d.factors['Data setup'];
  assert.deepStrictEqual(reasons(placement.deriveStory(d, { id: 1, ratings: all(CONTENT(), 2) }).problems), ['unknown-factor']);
});

test('adjust: a number overrides the hours for the run (labelled adjusted, even outside the range); "skip" drops the task', () => {
  const c = CONTENT();
  const s = placement.deriveStory(c, {
    id: 1, ratings: all(c, 0), adjust: { 'test creation': 6, '[Testing] Requirement Review': 'skip' },
  }).story;
  assert.deepStrictEqual(s.tasks.map((t) => [t.name, t.hours, t.adjusted === true]), [['Test Creation', 6, true], ['Test Execution', 1, false]]);
  assert.strictEqual(s.tasks[1].adjusted, undefined, 'only adjusted tasks carry the flag');
  assert.strictEqual(s.total, 7);
});

test('adjust: bad-adjustment (bad value, unknown or disabled task) and no-tasks-left', () => {
  const c = CONTENT();
  for (const adjust of [{ 'Test Creation': 0 }, { 'Test Creation': 'later' }, { 'Test Creation': -1 }, { 'Smoke Pass': 2 }, { Nope: 1 }, ['x']]) {
    const r = placement.deriveStory(c, { id: 1, ratings: all(c, 1), adjust });
    assert.deepStrictEqual(reasons(r.problems), ['bad-adjustment'], JSON.stringify(adjust));
  }
  const r = placement.deriveStory(c, { id: 1, ratings: all(c, 1), adjust: { 'Requirement Review': 'skip', 'Test Creation': 'skip', 'Test Execution': 'skip' } });
  assert.deepStrictEqual(reasons(r.problems), ['no-tasks-left']);
});

test('deriveStories: every story\'s problems at once; perStory in spec order; the sprint total', () => {
  const c = CONTENT();
  const ok = placement.deriveStories(c, [{ id: 1, ratings: all(c, 0) }, { id: 2, ratings: all(c, 4) }]);
  assert.deepStrictEqual(ok.problems, []);
  assert.deepStrictEqual(ok.perStory.map((s) => s.id), [1, 2]);
  assert.strictEqual(ok.total, 2.5 + 9);
  const bad = placement.deriveStories(c, [{ id: 1, ratings: {} }, { id: 2, ratings: { ...all(c, 1), X: 1 } }]);
  assert.deepStrictEqual(bad.problems.map((p) => p.story), [1, 1, 1, 2]);
});

test('identical inputs give identical hours on every call (no clock, no locale, no provider input)', () => {
  const c = CONTENT();
  const story = { id: 'PROJ-1', ratings: { 'Scenarios / ACs': 3, 'UI elements': 1, 'Data setup': 4 } };
  const a = JSON.stringify(placement.deriveStory(c, story));
  for (let i = 0; i < 50; i++) assert.strictEqual(JSON.stringify(placement.deriveStory(c, story)), a);
});

test('engine modules are pure: no requires beyond node: builtins, siblings and the schema module; no provider words', () => {
  for (const n of ['defaults.js', 'placement.js']) {
    const src = fs.readFileSync(path.join(__dirname, n), 'utf8');
    assert.ok(!/child_process|process\.exit\(|fetch\(/.test(src), n);
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\b(ado|jira|azure)\b/i.test(code), `${n}: no provider names in code`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
