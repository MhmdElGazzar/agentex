'use strict';
// estimation/history.js — the first-run proposal engine (pure). It turns the
// past [Testing] tasks a strategy read from the team's last closed sprints into
// a proposed config/estimation.json: one task per name, min = the lowest and
// max = the highest Original Estimate, abnormal values flagged for the ONE
// approval screen, and labelled starter defaults when there is no usable history.
//
//   grouping   name = the title without its [Testing] marker; names match
//              ignoring case and surrounding whitespace; the display name is the
//              most frequent exact spelling (ties: first seen); points are
//              ordered by (story seq, task seq) and task order is the first-seen
//              order of names. A task ref seen twice counts once.
//   skips      a task without an estimate (hours null) or with an empty name is
//              skipped and counted — never an outlier, never replaced; a name
//              with no estimate at all is listed (namesWithoutEstimates), not proposed.
//   outliers   per name with ≥ OUTLIER_MIN_SAMPLE estimates: HIGH when above
//              median × OUTLIER_RATIO, LOW when below median ÷ OUTLIER_RATIO
//              (strict). The suggested value is the nearest normal extreme and
//              is in use by default; choices: 'count' · 'suggested' · hours > 0.
//   taskEdits  at the gate, per task name: enabled / minHours / maxHours only.
//
// The proposal travels as a scratch file between Phase A, the dry run and
// --execute. recompute() re-derives outliers and content from its `groups`
// with this module's own constants: the scratch file supplies data, never
// decisions (a tampered `content`, `factors` or `threshold` has no effect).
const path = require('node:path');
const { OUTLIER_RATIO, OUTLIER_MIN_SAMPLE } = require('./defaults.js');
const ec = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'estimation_config.js'));

const PROPOSAL_VERSION = 1;
const KINDS = ['history', 'starter-defaults'];
const REASONS = ['no-closed-sprints', 'no-testing-tasks', 'no-estimates'];
const EDIT_KEYS = ['enabled', 'minHours', 'maxHours'];
const REBUILD = 'Editing this block changes nothing; delete or move this file and the next estimation run proposes a new one from your board.';

const round2 = (n) => Math.round(n * 100) / 100;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Past [Testing] points → name groups (counted points only) + the counts.
function groupPoints(points) {
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const sorted = [...points].sort((a, b) => (num(a.parent && a.parent.seq) - num(b.parent && b.parent.seq)) || (num(a.seq) - num(b.seq)));
  const seen = new Set();
  const byKey = new Map();
  let tasksCounted = 0; let tasksSkipped = 0;
  for (const p of sorted) {
    const ref = String(p.ref);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const name = ec.normalizeTaskName(p.title || '');
    if (!name) { tasksSkipped++; continue; }
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { key, spellings: new Map(), points: [], storyRefs: new Set() });
    const g = byKey.get(key);
    g.spellings.set(name, (g.spellings.get(name) || 0) + 1);
    if (!isPositive(p.hours)) { tasksSkipped++; continue; }
    tasksCounted++;
    const parent = p.parent || {};
    g.points.push({ ref: p.ref, hours: p.hours, story: { ref: parent.ref, title: parent.title ?? null, url: parent.url ?? null } });
    g.storyRefs.add(String(parent.ref));
  }
  const groups = []; const namesWithoutEstimates = [];
  for (const g of byKey.values()) {
    let name = null; let best = 0;
    for (const [spelling, n] of g.spellings) if (n > best) { name = spelling; best = n; }
    if (!g.points.length) { namesWithoutEstimates.push(name); continue; }
    groups.push({ key: g.key, name, stories: g.storyRefs.size, points: g.points });
  }
  return { groups, tasksCounted, tasksSkipped, namesWithoutEstimates };
}

// The flagged values of one group (on the ORIGINAL estimates), in point order.
function findOutliers(group) {
  const values = group.points.map((p) => p.hours);
  if (values.length < OUTLIER_MIN_SAMPLE) return [];
  const med = median(values);
  const side = (h) => (h > med * OUTLIER_RATIO ? 'high' : h < med / OUTLIER_RATIO ? 'low' : null);
  const normal = values.filter((h) => !side(h)); // never empty: the upper middle value is never flagged
  const normalRange = [Math.min(...normal), Math.max(...normal)];
  return group.points.filter((p) => side(p.hours)).map((p) => ({
    ref: p.ref, task: group.name, story: p.story, hours: p.hours, side: side(p.hours),
    normalRange, suggested: side(p.hours) === 'high' ? normalRange[1] : normalRange[0],
  }));
}

function sourceRecord(p, kind) {
  const pv = p.provenance;
  return {
    kind,
    sprints: pv.sprintsRequested,
    sprintsRead: pv.sprintsRead,
    tasksCounted: pv.tasksCounted,
    tasksSkipped: pv.tasksSkipped,
    ...(kind === 'starter-defaults' ? { reason: pv.reason } : {}),
    createdOn: p.createdOn,
    note: kind === 'history'
      ? `Where these numbers came from. ${REBUILD}`
      : `These are starter defaults, not your team's history (${pv.reason}). ${REBUILD}`,
  };
}

// The proposal as it stands after the user's choices and edits.
//   { problems: Blocked[], content, outliers: [...], groups: [{ name, stories, min, max }] }
// Blocked reasons: bad-outlier-choice · bad-task-edit · estimation-proposal-invalid.
function recompute(p, { outlierChoices, taskEdits } = {}) {
  const problems = [];
  const choices = outlierChoices === undefined ? {} : outlierChoices;
  const edits = taskEdits === undefined ? {} : taskEdits;
  if (!isPlainObject(choices)) {
    problems.push({ reason: 'bad-outlier-choice', message: `outlierChoices must be an object keyed by the past task's ref (got ${JSON.stringify(choices)})` });
  }
  if (!isPlainObject(edits)) {
    problems.push({ reason: 'bad-task-edit', message: `taskEdits must be an object keyed by task name (got ${JSON.stringify(edits)})` });
  }
  const choiceOf = isPlainObject(choices) ? choices : {};

  const outliers = []; const summary = []; const flagged = new Set();
  for (const g of p.groups) {
    const used = new Map();
    for (const o of findOutliers(g)) {
      const ref = String(o.ref);
      flagged.add(ref);
      const choice = has(choiceOf, ref) ? choiceOf[ref] : 'suggested';
      let value;
      if (choice === 'suggested') value = o.suggested;
      else if (choice === 'count') value = o.hours;
      else if (isPositive(choice)) value = round2(choice);
      else {
        value = o.suggested;
        problems.push({
          reason: 'bad-outlier-choice', ref: o.ref, task: g.name, choice: choice ?? null,
          message: `the ${o.hours} h on past task ${o.ref} (${g.name}): the choice must be "count", "suggested" or hours > 0 (got ${JSON.stringify(choice ?? null)}) — ask again in the same round`,
        });
      }
      used.set(ref, value);
      outliers.push({ ...o, choice, used: value });
    }
    const values = g.points.map((pt) => (used.has(String(pt.ref)) ? used.get(String(pt.ref)) : pt.hours));
    summary.push({ name: g.name, stories: g.stories, min: Math.min(...values), max: Math.max(...values) });
  }
  for (const ref of Object.keys(choiceOf)) {
    if (!flagged.has(ref)) {
      problems.push({
        reason: 'bad-outlier-choice', ref,
        message: `past task ${ref} is not one of the flagged values — only the flagged values take a choice`,
      });
    }
  }

  const kind = p.groups.length ? 'history' : 'starter-defaults';
  const tasks = kind === 'history'
    ? summary.map((g) => ({ name: g.name, enabled: true, minHours: g.min, maxHours: g.max }))
    : ec.STARTER_TASKS.map((t) => ({ ...t }));

  if (isPlainObject(edits)) {
    for (const [rawName, edit] of Object.entries(edits)) {
      const t = tasks.find((x) => ec.taskKey(x.name) === ec.taskKey(rawName));
      const bad = (text) => problems.push({ reason: 'bad-task-edit', task: rawName, message: `taskEdits["${rawName}"]: ${text}` });
      if (!t) { bad(`no proposed task is named "${rawName}" (${tasks.map((x) => x.name).join(', ')})`); continue; }
      if (!isPlainObject(edit)) { bad(`must be an object of ${EDIT_KEYS.join(' / ')} (got ${JSON.stringify(edit)})`); continue; }
      const wrong = Object.keys(edit).filter((k) => !EDIT_KEYS.includes(k));
      if (wrong.length) { bad(`only ${EDIT_KEYS.join(', ')} can be edited at the gate (got ${wrong.join(', ')})`); continue; }
      if (has(edit, 'enabled') && typeof edit.enabled !== 'boolean') { bad(`enabled must be true or false (got ${JSON.stringify(edit.enabled)})`); continue; }
      const nonNumber = ['minHours', 'maxHours'].filter((k) => has(edit, k) && !(typeof edit[k] === 'number' && Number.isFinite(edit[k])));
      if (nonNumber.length) { bad(`${nonNumber.join(', ')} must be a number`); continue; }
      Object.assign(t, edit);
    }
  }

  const content = {
    schemaVersion: ec.SCHEMA_VERSION,
    tasks,
    factors: { ...ec.DEFAULT_FACTORS },
    source: sourceRecord(p, kind),
  };
  if (!problems.length) {
    const invalid = ec.validateEstimationConfig(content);
    if (invalid.length) {
      problems.push({
        reason: 'estimation-proposal-invalid', problems: invalid,
        message: `the proposal, after the gate edits, is not a valid estimation file: ${invalid.map((x) => x.message).join('; ')}`,
      });
    }
  }
  return { problems, content, outliers, groups: summary };
}

// history: what strategy.pastTestingTasks returned ({ sprintsRequested,
// sprints, storiesRead, points, truncated, reason, reasonMessage }).
function propose(history, { createdOn }) {
  const { groups, tasksCounted, tasksSkipped, namesWithoutEstimates } = groupPoints(history.points || []);
  let reason = history.reason || null;
  let reasonMessage = history.reasonMessage || null;
  if (!groups.length && !reason) {
    // [Testing] tasks with estimates exist but none carries a name.
    reason = 'no-testing-tasks';
    reasonMessage = 'no past [Testing] task carries a task name after its [Testing] marker';
  }
  const p = {
    proposalVersion: PROPOSAL_VERSION,
    kind: groups.length ? 'history' : 'starter-defaults',
    createdOn,
    provenance: {
      sprintsRequested: history.sprintsRequested,
      sprintsRead: (history.sprints || []).map((s) => s.name),
      storiesRead: history.storiesRead || 0,
      tasksCounted, tasksSkipped, namesWithoutEstimates,
      truncated: Boolean(history.truncated),
      reason: groups.length ? null : reason,
      reasonMessage: groups.length ? null : reasonMessage,
    },
    threshold: { ratio: OUTLIER_RATIO, minSample: OUTLIER_MIN_SAMPLE },
    groups,
    factors: { ...ec.DEFAULT_FACTORS },
    content: null,
  };
  p.content = recompute(p, {}).content;
  return p;
}

const outliersOf = (p, opts) => recompute(p, opts).outliers;

// A scratch proposal file is data from a previous call: check its shape before
// using it. Returns null when well-formed, else what is wrong.
function checkProposal(p) {
  if (!isPlainObject(p)) return 'the proposal is not a JSON object';
  if (p.proposalVersion !== PROPOSAL_VERSION) return `proposalVersion must be ${PROPOSAL_VERSION}`;
  if (!KINDS.includes(p.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (typeof p.createdOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.createdOn)) return 'createdOn must be a YYYY-MM-DD date';
  const pv = p.provenance;
  if (!isPlainObject(pv)) return 'provenance is missing';
  const count = (v) => Number.isInteger(v) && v >= 0;
  if (!(Number.isInteger(pv.sprintsRequested) && pv.sprintsRequested > 0)) return 'provenance.sprintsRequested must be a positive whole number';
  if (!Array.isArray(pv.sprintsRead) || !pv.sprintsRead.every((s) => typeof s === 'string')) return 'provenance.sprintsRead must be a list of names';
  if (!count(pv.storiesRead) || !count(pv.tasksCounted) || !count(pv.tasksSkipped)) return 'provenance counts must be whole numbers';
  if (!Array.isArray(pv.namesWithoutEstimates)) return 'provenance.namesWithoutEstimates must be a list';
  if (typeof pv.truncated !== 'boolean') return 'provenance.truncated must be true or false';
  if (!(pv.reason === null || REASONS.includes(pv.reason))) return `provenance.reason must be null or one of ${REASONS.join(', ')}`;
  if (!(pv.reasonMessage === null || typeof pv.reasonMessage === 'string')) return 'provenance.reasonMessage must be text or null';
  if (!Array.isArray(p.groups)) return 'groups must be a list';
  for (const [i, g] of p.groups.entries()) {
    if (!isPlainObject(g) || typeof g.key !== 'string' || typeof g.name !== 'string' || !g.name.trim() || !count(g.stories)) return `groups[${i}] is malformed`;
    if (!Array.isArray(g.points) || !g.points.length) return `groups[${i}].points must be a non-empty list`;
    for (const pt of g.points) {
      if (!isPlainObject(pt) || !(typeof pt.ref === 'string' || typeof pt.ref === 'number') || !isPositive(pt.hours) || !isPlainObject(pt.story)) {
        return `groups[${i}] has a malformed data point`;
      }
    }
  }
  if ((p.groups.length ? 'history' : 'starter-defaults') !== p.kind) return `kind "${p.kind}" does not match the data points`;
  if (p.kind === 'starter-defaults' && !REASONS.includes(pv.reason)) return 'a starter-defaults proposal needs its reason';
  return null;
}

module.exports = { PROPOSAL_VERSION, median, groupPoints, findOutliers, propose, recompute, outliersOf, checkProposal };
