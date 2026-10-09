'use strict';
// ops/ado.js — the tracker CLI's Azure DevOps strategy (TrackerOpsStrategy;
// contract in ./index.js). Everything ADO-shaped the CLI needs lives here:
// field reference names, the WIQL result shape, and the honest State-field
// update that stands in for a workflow transition (ADO has no transition API).
// Pure mapping over adapter reads/writes — no transport, no CLI text beyond the
// notes the user must see.

const provider = 'ado';

const F = { parent: 'System.Parent', title: 'System.Title', state: 'System.State', type: 'System.WorkItemType' };
const WIQL_CAP = 20000; // the service's maximum WIQL result size
// Relation reference name -> neutral kind (child comes from the batched
// [System.Parent] read, so Hierarchy-Forward on the story is not used).
const REL_KIND = {
  'System.LinkTypes.Hierarchy-Reverse': 'parent',
  'Microsoft.VSTS.Common.TestedBy-Forward': 'tested-by',
  'System.LinkTypes.Related': 'related',
};
const CHILD_REL = 'System.LinkTypes.Hierarchy-Forward';
const KIND_ORDER = ['parent', 'child', 'tested-by', 'related', 'link'];

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

// show: provider-neutral summary (moved verbatim from the 0.23.0 CLI).
function summarize(adapter, wi) {
  const f = (wi && wi.fields) || {};
  return {
    id: wi.id,
    type: f['System.WorkItemType'] || null,
    title: f['System.Title'] || null,
    state: f['System.State'] || null,
    url: adapter.webUrl(wi.id),
    fields: f,
    ...(wi.relations ? { relations: wi.relations } : {}),
  };
}

// search: scope a WIQL to the configured project unless it already names
// one. The adapter posts to the project-scoped wiql route, where @project
// resolves — the same rule findByTitle applies — so no quoting is needed.
//   - System.TeamProject mentioned anywhere outside a string literal (any
//     case, bracketed or not) -> left alone (an explicit opt-out);
//   - a top-level WHERE -> WHERE <scope> AND (<original predicate>), with a
//     trailing ORDER BY / ASOF / MODE clause kept outside the parentheses;
//   - no WHERE -> WHERE <scope> inserted before the trailing clause or at the end;
//   - FROM WorkItemLinks -> the scope is on [Source].
// Keyword search runs on a masked copy: string-literal contents ('…', "…",
// doubled quotes escaped) and bracketed field names are blanked, so a value
// such as 'where to order by' can never be mistaken for syntax.
function maskLiterals(q, { brackets = false } = {}) {
  let out = '';
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < q.length) {
        if (q[j] === c) { if (q[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      const end = Math.min(j, q.length);
      out += c + ' '.repeat(Math.max(0, end - i - 1)) + (j < q.length ? c : '');
      i = end + 1;
    } else if (brackets && c === '[') {
      const j = q.indexOf(']', i);
      const end = j === -1 ? q.length - 1 : j;
      out += '[' + ' '.repeat(Math.max(0, end - i - 1)) + (j === -1 ? '' : ']');
      i = end + 1;
    } else { out += c; i++; }
  }
  return out;
}
function scopeQuery(adapter, text) {
  const q = String(text);
  if (/system\.teamproject/i.test(maskLiterals(q))) return q;
  const m = maskLiterals(q, { brackets: true });
  const scope = /\bfrom\s+workitemlinks\b/i.test(m)
    ? '[Source].[System.TeamProject] = @project'
    : '[System.TeamProject] = @project';
  const trailingFrom = (from) => {
    const re = /\b(order\s+by|asof|mode)\b/ig;
    re.lastIndex = from;
    const hit = re.exec(m);
    return hit ? hit.index : -1;
  };
  const where = /\bwhere\b/i.exec(m);
  if (where) {
    const ps = where.index + where[0].length;
    const t = trailingFrom(ps);
    const end = t === -1 ? q.length : t;
    const predicate = q.slice(ps, end).trim();
    return `${q.slice(0, ps)} ${scope} AND (${predicate})${t === -1 ? '' : ` ${q.slice(t)}`}`;
  }
  const from = /\bfrom\b/i.exec(m);
  const t = trailingFrom(from ? from.index : 0);
  if (t === -1) return `${q.trimEnd()} WHERE ${scope}`;
  return `${q.slice(0, t).trimEnd()} WHERE ${scope} ${q.slice(t)}`;
}

// search: the adapter.query options and the --top ceiling (the service's
// 20,000-item WIQL maximum). $top is sent only when --top is given.
function searchOptions({ top } = {}) {
  return { max: WIQL_CAP, options: top ? { top } : {} };
}

// search: WIQL result -> neutral rows. --fields hydrates the ids with ONE
// batch read (chunked at 200). truncated = the result count reached the cap
// in force (--top n, or the service maximum) — "more may exist".
async function searchResults(adapter, res, { top, fields } = {}) {
  const rows = (res && res.workItems) || [];
  let results = rows.map((w) => ({ id: w.id, url: adapter.webUrl(w.id) }));
  if (fields && fields.length && rows.length) {
    const b = await adapter.getWorkItems(rows.map((w) => w.id), { fields });
    const byId = new Map(b.items.map((wi) => [Number(wi.id), wi.fields || {}]));
    results = results.map((r) => ({ ...r, fields: byId.has(Number(r.id)) ? byId.get(Number(r.id)) : null }));
  }
  const cap = top || WIQL_CAP;
  return { results, truncated: Boolean(res && res.truncated) || results.length >= cap };
}

// batch: many ids, chosen fields, input order; missing ids listed.
async function batchRead(adapter, ids, fields) {
  const res = await adapter.getWorkItems(ids, { fields });
  return { items: res.items.map((wi) => ({ id: wi.id, fields: wi.fields || {} })), missing: res.missing };
}

// comments: the thread, oldest first, as {author, date, text}.
async function comments(adapter, id) {
  return (await adapter.listComments(id)).map((c) => ({ author: c.author, date: c.date, text: c.text }));
}

// relations: neutral kinds for each id. A constant request count:
//   child              -> ONE [System.Parent] IN (...) WIQL (listChildRefs);
//   parent/tested-by/related/link -> getStory per id (expand=all carries relations);
//   then ONE batch hydrate (chunked at 200) of every target.
// Artifact links (commits, attachments, hyperlinks) are dropped.
async function relations(adapter, ids, kinds, fields = []) {
  const want = new Set(kinds);
  const parents = ids.map((id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw configError(`relations needs Azure DevOps work-item ids (positive integers; got ${JSON.stringify(id)})`);
    return n;
  });
  const found = new Map(parents.map((p) => [p, []])); // parent -> [{kind, linkType?, id}]
  if (['parent', 'tested-by', 'related', 'link'].some((k) => want.has(k))) {
    for (const p of parents) {
      const story = await adapter.getStory(p);
      for (const r of ((story.raw && story.raw.relations) || [])) {
        const m = String(r.url || '').match(/\/workItems\/(\d+)$/i);
        if (!m || r.rel === CHILD_REL) continue; // artifact link, or a child (read below)
        const kind = REL_KIND[r.rel] || 'link';
        if (!want.has(kind)) continue;
        found.get(p).push({ kind, ...(kind === 'link' ? { linkType: r.rel } : {}), id: Number(m[1]) });
      }
    }
  }
  let childRefs = [];
  if (want.has('child')) childRefs = await adapter.listChildRefs(parents);
  const targets = [...new Set([...childRefs, ...[...found.values()].flat().map((x) => x.id)])];
  const hydrated = new Map();
  if (targets.length) {
    const b = await adapter.getWorkItems(targets, { fields: [F.parent, F.title, F.state, F.type, ...fields.filter((x) => ![F.parent, F.title, F.state, F.type].includes(x))] });
    for (const wi of b.items) hydrated.set(Number(wi.id), wi.fields || {});
  }
  for (const c of childRefs) {
    const p = Number((hydrated.get(Number(c)) || {})[F.parent]);
    if (found.has(p)) found.get(p).push({ kind: 'child', id: Number(c) });
  }
  return {
    items: parents.map((p) => ({
      id: p,
      relations: found.get(p)
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
        .map((x) => {
          const f = hydrated.get(x.id) || {};
          return { ...x, type: f[F.type] ?? null, title: f[F.title] ?? null, state: f[F.state] ?? null, ...(fields.length ? { fields: pick(f, fields) } : {}) };
        }),
    })),
  };
}

// iterations: the team's iterations (--team, else azure.team). The adapter
// refuses a missing team with zero requests.
async function iterations(adapter, { team, board, timeframe = 'all' } = {}) {
  if (board !== undefined) throw configError('--board is a Jira option — on Azure DevOps, iterations are team settings: pass --team "<name>" or set azure.team');
  return adapter.listIterations({ team: team || adapter.config.team, timeframe });
}

// transition: ADO has no transition API — the honest equivalent is a
// State-field update via updateWorkItem, STATED to the user, never dressed up
// as a workflow transition.
async function transition(adapter, id, to, { execute = false } = {}) {
  const note = `this tracker has no transition API — the honest equivalent is a State-field update (System.State = "${to}") via updateWorkItem, shown below`;
  const payload = { fields: { 'System.State': to } };
  if (!execute) {
    const d = await adapter.updateWorkItem(id, payload, { execute: false });
    return { step: 'transition-as-state-update', request: d, note };
  }
  const result = await adapter.updateWorkItem(id, payload, { execute: true });
  return { result, note };
}

// discussion: the exact HTML the comments API receives. Markup characters are
// encoded (they render literally), newlines become <br>, non-ASCII stays
// literal. A resolved mention ({id, displayName}) is prepended as ADO's real
// mention anchor — never a bare "@text".
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
function renderDiscussion(text, mention) {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>');
  if (!mention) return body;
  return `<a href="#" data-vss-mention="version:2.0,${escapeHtml(mention.id)}">@${escapeHtml(mention.displayName)}</a> ${body}`;
}

// update: fields this tracker refuses before any request (none yet).
function refusedUpdateFields() {
  return [];
}

module.exports = {
  provider, summarize, scopeQuery, searchOptions, searchResults, batchRead, comments, relations, iterations,
  transition, refusedUpdateFields, renderDiscussion,
};
