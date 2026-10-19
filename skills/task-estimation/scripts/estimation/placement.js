'use strict';
// estimation/placement.js — factor ratings → a story score → each enabled
// task's hours, placed inside that task's [minHours, maxHours]. Deterministic
// and pure: plain IEEE-754 arithmetic, no clock, no locale, no provider input,
// so the same file and the same ratings give identical hours on every run and
// on every tracker (invariant 9 — the agent rates, this module computes).
//
//   score:  over the factors with weight w > 0, in file order,
//           num = Σ w·r, den = Σ w·4 (same summation order) → s = num / den ∈ [0, 1]
//           (all ratings 4 → exactly 1, all 0 → exactly 0, no float drift)
//   hours:  s == 0 → min · s == 1 → max (exact: the file's own values)
//           else round(min + s·(max − min)) to the HOURS_STEP grid, half-up,
//           clamped into [min, max]
//
// Validation is script-enforced: the ratings' keys must equal the file's factor
// names (case-insensitive, trimmed) and each value an integer 0–4, so a factor
// added to the file MUST be rated and a removed one CANNOT appear. Run-only
// gate adjustments (`adjust`, keyed by task name) override or skip a task for
// this run; the file is never touched.
//
// Findings are blocked entries { reason, story, factor? | task?, message }:
// missing-rating · unknown-factor · bad-rating · bad-adjustment · no-tasks-left.
const path = require('node:path');
const { RATING_MIN, RATING_MAX, HOURS_STEP } = require('./defaults.js');
const { normalizeTaskName, taskKey } = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'estimation_config.js'));

const TITLE_PREFIX = '[Testing] ';
const factorKey = (name) => String(name).trim().toLowerCase();
const round = (n, places) => { const f = 10 ** places; return Math.round(n * f) / f; };

// ratings: { <file factor name>: 0..4 } (already matched to the file's names).
function score(factors, ratings) {
  let num = 0; let den = 0;
  for (const [name, w] of Object.entries(factors)) {
    if (!(w > 0)) continue;
    num += w * ratings[name];
    den += w * RATING_MAX;
  }
  return num / den;
}

function placeHours(s, minHours, maxHours) {
  if (s === 0) return minHours;
  if (s === 1) return maxHours;
  const raw = minHours + s * (maxHours - minHours);
  const h = Math.floor(raw / HOURS_STEP + 0.5 + 1e-9) * HOURS_STEP;
  return Math.min(Math.max(h, minHours), maxHours);
}

// Match the spec's ratings to the file's factor names; every finding at once.
function matchRatings(factors, ratings, storyId) {
  const problems = [];
  const block = (reason, extra, text) => problems.push({ reason, story: storyId, ...extra, message: `story ${storyId}: ${text}` });
  const byKey = new Map(Object.keys(factors).map((n) => [factorKey(n), n]));
  const matched = {};
  if (ratings !== undefined && (ratings === null || typeof ratings !== 'object' || Array.isArray(ratings))) {
    block('bad-rating', {}, `ratings must be an object of "<factor>": 0–4 (got ${JSON.stringify(ratings)})`);
    return { problems, matched };
  }
  for (const [rawName, r] of Object.entries(ratings || {})) {
    const name = byKey.get(factorKey(rawName));
    if (!name) {
      block('unknown-factor', { factor: rawName },
        `"${rawName}" is not a factor of config/estimation.json — rate exactly its factors (${Object.keys(factors).join(', ')})`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(matched, name)) {
      block('bad-rating', { factor: name }, `factor "${name}" is rated more than once`);
      continue;
    }
    if (!Number.isInteger(r) || r < RATING_MIN || r > RATING_MAX) {
      block('bad-rating', { factor: name, rating: r ?? null },
        `the rating for "${name}" must be a whole number ${RATING_MIN}–${RATING_MAX} (got ${JSON.stringify(r ?? null)})`);
      matched[name] = null;
      continue;
    }
    matched[name] = r;
  }
  for (const name of Object.keys(factors)) {
    if (!Object.prototype.hasOwnProperty.call(matched, name)) {
      block('missing-rating', { factor: name }, `factor "${name}" has no rating — rate every factor the file lists (${RATING_MIN}–${RATING_MAX})`);
    }
  }
  return { problems, matched };
}

// One story: ratings → score → the enabled tasks' hours → run-only adjustments.
//   { problems: [] , story: { id, ratings, score, scorePct, tasks: [{ name, title, hours, minHours, maxHours, adjusted? }], total } }
//   { problems: [...] }  (blocked)
function deriveStory(content, story) {
  const storyId = story.id;
  const { problems, matched } = matchRatings(content.factors, story.ratings, storyId);
  const enabled = content.tasks.filter((t) => t.enabled);

  const adjust = story.adjust;
  const byTask = new Map(enabled.map((t) => [taskKey(t.name), t]));
  const overrides = new Map(); const skips = new Set();
  if (adjust !== undefined) {
    if (adjust === null || typeof adjust !== 'object' || Array.isArray(adjust)) {
      problems.push({ reason: 'bad-adjustment', story: storyId,
        message: `story ${storyId}: adjust must be an object of "<task>": <hours> | "skip" (got ${JSON.stringify(adjust)})` });
    } else {
      for (const [rawTask, v] of Object.entries(adjust)) {
        const t = byTask.get(taskKey(rawTask));
        if (!t) {
          problems.push({ reason: 'bad-adjustment', story: storyId, task: rawTask,
            message: `story ${storyId}: "${rawTask}" is not an enabled task of config/estimation.json (${enabled.map((x) => x.name).join(', ')})` });
        } else if (v === 'skip') skips.add(taskKey(t.name));
        else if (typeof v === 'number' && Number.isFinite(v) && v > 0) overrides.set(taskKey(t.name), v);
        else {
          problems.push({ reason: 'bad-adjustment', story: storyId, task: t.name,
            message: `story ${storyId}: the adjustment for "${t.name}" must be hours > 0 or "skip" (got ${JSON.stringify(v)})` });
        }
      }
    }
  }
  const kept = enabled.filter((t) => !skips.has(taskKey(t.name)));
  if (!kept.length && enabled.length) {
    problems.push({ reason: 'no-tasks-left', story: storyId,
      message: `story ${storyId}: every task is skipped — drop the story from the spec instead` });
  }
  if (problems.length) return { problems };

  const s = score(content.factors, matched);
  const tasks = kept.map((t) => {
    const name = normalizeTaskName(t.name);
    const k = taskKey(t.name);
    const adjusted = overrides.has(k);
    return {
      name, title: TITLE_PREFIX + name,
      hours: adjusted ? overrides.get(k) : placeHours(s, t.minHours, t.maxHours),
      minHours: t.minHours, maxHours: t.maxHours,
      ...(adjusted ? { adjusted: true } : {}),
    };
  });
  return {
    problems: [],
    story: {
      id: storyId,
      ratings: Object.fromEntries(Object.keys(content.factors).map((n) => [n, matched[n]])),
      score: round(s, 4),
      scorePct: Math.round(s * 100),
      tasks,
      total: round(tasks.reduce((sum, t) => sum + t.hours, 0), 2),
    },
  };
}

// Every story, every finding at once; perStory in spec order.
function deriveStories(content, stories) {
  const problems = []; const perStory = [];
  for (const st of stories) {
    const r = deriveStory(content, st);
    problems.push(...r.problems);
    if (r.story) perStory.push(r.story);
  }
  return { problems, perStory, total: round(perStory.reduce((sum, s) => sum + s.total, 0), 2) };
}

module.exports = { TITLE_PREFIX, score, placeHours, deriveStory, deriveStories };
