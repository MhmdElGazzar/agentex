'use strict';
// ops/ado.js — the tracker CLI's Azure DevOps strategy (TrackerOpsStrategy;
// contract in ./index.js). Everything ADO-shaped the CLI needs lives here:
// field reference names, the WIQL result shape, and the honest State-field
// update that stands in for a workflow transition (ADO has no transition API).
// Pure mapping over adapter reads/writes — no transport, no CLI text beyond the
// notes the user must see.

const provider = 'ado';

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

// search: the query text sent to the adapter (scoping lands in a later step).
function scopeQuery(adapter, text) {
  return text;
}

// search: WIQL result -> neutral rows (+ truncated when the adapter reports it).
function searchResults(adapter, res) {
  const results = ((res && res.workItems) || []).map((w) => ({ id: w.id, url: adapter.webUrl(w.id) }));
  return { results, truncated: Boolean(res && res.truncated) };
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

// update: fields this tracker refuses before any request (none yet).
function refusedUpdateFields() {
  return [];
}

module.exports = { provider, summarize, scopeQuery, searchResults, transition, refusedUpdateFields };
