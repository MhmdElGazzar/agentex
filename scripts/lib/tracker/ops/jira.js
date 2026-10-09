'use strict';
// ops/jira.js — the tracker CLI's Jira Cloud strategy (TrackerOpsStrategy;
// contract in ./index.js). Everything Jira-shaped the CLI needs lives here:
// issue keys, the flat field ids, the JQL search result shape, and the real
// workflow transition. Pure mapping over adapter reads/writes.

const provider = 'jira';

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

// search: JQL result -> neutral rows (+ truncated from the adapter's page cap).
function searchResults(adapter, res) {
  const results = ((res && res.issues) || []).map((i) => ({
    id: i.key, title: ((i.fields || {}).summary) ?? null, url: adapter.webUrl(i.key),
  }));
  return { results, truncated: Boolean(res && res.truncated) };
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

// update: no refused field on Jira (a remaining-estimate update is legitimate
// here; the "never set remaining work" rule is judgment in the lifecycle reference).
function refusedUpdateFields() {
  return [];
}

module.exports = { provider, summarize, scopeQuery, searchResults, transition, refusedUpdateFields };
