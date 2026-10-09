'use strict';
// ops/jira.js — the tracker CLI's Jira Cloud strategy (TrackerOpsStrategy;
// contract in ./index.js). Everything Jira-shaped the CLI needs lives here:
// issue keys, the flat field ids, the JQL search result shape, and the real
// workflow transition. Pure mapping over adapter reads/writes.

const path = require('node:path');
const { toAdf, mention: mentionNode } = require(path.join(__dirname, '..', 'adf.js'));

const provider = 'jira';

const SEARCH_CAP = 1000; // the adapter's 10 pages x 100
const TIMEFRAMES = { current: 'active', future: 'future', past: 'closed', all: undefined };
const STATE_TO_TIMEFRAME = { active: 'current', future: 'future', closed: 'past' };
const KIND_ORDER = ['parent', 'child', 'tested-by', 'related', 'link'];

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));
const row = (issue) => {
  const f = (issue && issue.fields) || {};
  return { type: (f.issuetype || {}).name || null, title: f.summary ?? null, state: (f.status || {}).name || null };
};

// show: provider-neutral summary (moved verbatim from the 0.23.0 CLI).
function summarize(adapter, wi) {
  const f = (wi && wi.fields) || {};
  const key = wi.key || wi.id;
  return {
    id: key,
    type: (f.issuetype && f.issuetype.name) || null,
    title: f.summary || null,
    state: (f.status && f.status.name) || null,
    url: adapter.webUrl(key),
    fields: f,
    ...(wi.renderedFields ? { renderedFields: wi.renderedFields } : {}),
  };
}

// search: JQL passes through untouched — project scope belongs in the JQL.
function scopeQuery(adapter, text) {
  return text;
}

// search: the adapter.query options and the --top ceiling (the adapter's
// 10-page cap). --top n -> limit n; --fields -> the search's fields list.
function searchOptions({ top, fields } = {}) {
  return { max: SEARCH_CAP, options: { ...(fields && fields.length ? { fields } : {}), ...(top ? { limit: top } : {}) } };
}

// search: JQL result -> neutral rows (+ the requested fields with --fields).
// truncated = the adapter hit its page cap, or the count reached --top n.
async function searchResults(adapter, res, { top, fields } = {}) {
  const results = ((res && res.issues) || []).map((i) => ({
    id: i.key, title: ((i.fields || {}).summary) ?? null, url: adapter.webUrl(i.key),
    ...(fields && fields.length ? { fields: i.fields || {} } : {}),
  }));
  return { results, truncated: Boolean(res && res.truncated) || Boolean(top && results.length >= top) };
}

// batch: bulkfetch; input order; missing keys listed; moved issues reported apart.
async function batchRead(adapter, keys, fields) {
  const res = await adapter.getWorkItems(keys, { fields });
  return {
    items: res.items.map((i) => ({ id: i.key, fields: i.fields || {} })),
    missing: res.missing,
    moved: (res.moved || []).map((m) => ({ id: m.key, fields: m.fields || {} })),
  };
}

// comments: the thread, oldest first, as {author, date, text} (ADF -> plain).
async function comments(adapter, key) {
  return (await adapter.listComments(key)).map((c) => ({ author: c.author, date: c.date, text: c.text }));
}

// relations: getStory per key (ONE request each) carries parent, sub-tasks
// and issue links inline — children come from listChildren with ZERO extra
// requests. --fields adds ONE batch read of the targets for those fields.
async function relations(adapter, keys, kinds, fields = []) {
  const want = new Set(kinds);
  const items = [];
  for (const key of keys) {
    const story = await adapter.getStory(key);
    const f = (story.raw && story.raw.fields) || {};
    const rels = [];
    if (want.has('parent') && f.parent) rels.push({ kind: 'parent', id: f.parent.key, ...row(f.parent) });
    if (want.has('child')) {
      const subs = Array.isArray(f.subtasks) ? f.subtasks : [];
      for (const c of await adapter.listChildren(story)) {
        const raw = subs.find((s) => s && s.key === c.id);
        rels.push({ kind: 'child', id: c.id, type: raw ? row(raw).type : null, title: c.title, state: c.state });
      }
    }
    for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
      const t = l.outwardIssue || l.inwardIssue;
      if (!t) continue;
      const name = (l.type || {}).name || null;
      if (name === 'Relates') {
        if (want.has('related')) rels.push({ kind: 'related', id: t.key, ...row(t) });
      } else if (want.has('link')) {
        const direction = l.outwardIssue ? (l.type || {}).outward : (l.type || {}).inward;
        rels.push({ kind: 'link', linkType: name, direction: direction || null, id: t.key, ...row(t) });
      }
    }
    items.push({ id: story.id, relations: rels.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) });
  }
  if (fields.length) {
    const targets = [...new Set(items.flatMap((i) => i.relations.map((r) => r.id)))];
    const b = targets.length ? await adapter.getWorkItems(targets, { fields }) : { items: [] };
    const byKey = new Map(b.items.map((i) => [i.key, i.fields || {}]));
    for (const i of items) i.relations = i.relations.map((r) => ({ ...r, fields: pick(byKey.get(r.id) || {}, fields) }));
  }
  return { items };
}

// iterations: the board's sprints (--board id|name, else jira.board). A board
// NAME costs one listBoards read; no board -> exit 2 naming jira.board with
// zero requests. active -> current, future -> future, closed -> past.
async function iterations(adapter, { team, board, timeframe = 'all' } = {}) {
  if (team !== undefined) throw configError('--team is an Azure DevOps option — on Jira, sprints belong to a board: pass --board <id|name> or set jira.board');
  if (!Object.prototype.hasOwnProperty.call(TIMEFRAMES, timeframe)) throw configError(`unknown timeframe ${JSON.stringify(timeframe)} — accepted: ${Object.keys(TIMEFRAMES).join(', ')}`);
  const b = board || adapter.config.board;
  if (!b) throw configError('No board resolved — Jira sprints belong to a board. Pass --board <id|name> or set jira.board in config/project.json.');
  let boardId = String(b);
  if (!/^\d+$/.test(boardId)) {
    const boards = await adapter.listBoards();
    const hit = boards.find((x) => x.name === boardId);
    if (!hit) throw configError(`board "${boardId}" was not found — boards on this project: ${boards.map((x) => `${x.name} (id ${x.id})`).join(', ') || '(none)'}`);
    boardId = String(hit.id);
  }
  const sprints = await adapter.listSprints(boardId, TIMEFRAMES[timeframe] ? { state: TIMEFRAMES[timeframe] } : {});
  return sprints.map((s) => ({
    id: s.id, name: s.name, startDate: s.startDate || null, finishDate: s.endDate || null,
    timeFrame: STATE_TO_TIMEFRAME[s.state] || null,
  }));
}

// transition: resolved against the issue's REAL transitions (the adapter fails
// closed listing them); the dry run performs the free read only.
async function transition(adapter, id, to, { execute = false } = {}) {
  if (!execute) {
    const d = await adapter.transition(id, to, { execute: false });
    return { step: 'transition', request: d, extra: { transition: d.transition } };
  }
  const result = await adapter.transition(id, to, { execute: true });
  return { result };
}

// discussion: the exact ADF body. Without a mention it is toAdf(text) — byte-
// identical to the 0.23.0 comment. A resolved mention ({id: accountId,
// displayName}) becomes a real ADF mention node + ' ' at the start of the
// first paragraph — never a bare "@text".
function renderDiscussion(text, mention) {
  const doc = toAdf(text);
  if (!mention) return doc;
  doc.content[0].content.unshift(mentionNode(mention.id, `@${mention.displayName}`), { type: 'text', text: ' ' });
  return doc;
}

// update: no refused field on Jira (a remaining-estimate update is legitimate
// here; the "never set remaining work" rule is judgment in the lifecycle reference).
function refusedUpdateFields() {
  return [];
}

module.exports = {
  provider, summarize, scopeQuery, searchOptions, searchResults, batchRead, comments, relations, iterations,
  transition, refusedUpdateFields, renderDiscussion,
};
