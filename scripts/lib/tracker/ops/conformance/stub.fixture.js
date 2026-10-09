'use strict';
// Synthetic third provider for ../conformance.test.js: an in-memory adapter
// ('acme') and a stub strategy built only from the contract, registered in a
// test registry and run through the UNMODIFIED scripts/tracker.js spine — a new
// tracker is an adapter, a strategy, and one registry line. No requests exist
// here at all: every adapter call is recorded in memory.
const fs = require('node:fs');
const path = require('node:path');

const provider = 'acme';

const strategy = {
  provider,
  summarize: (adapter, raw) => ({
    id: raw.ref, type: raw.kind || null, title: raw.headline || null, state: raw.status || null,
    url: adapter.webUrl(raw.ref), fields: raw,
  }),
  scopeQuery: (adapter, text) => text,
  searchResults: (adapter, res) => ({
    results: (res.rows || []).map((r) => ({ id: r.ref, url: adapter.webUrl(r.ref) })),
    truncated: Boolean(res.more),
  }),
  transition: async (adapter, id, to, { execute = false } = {}) => {
    const payload = { fields: { status: to } };
    if (!execute) return { step: 'transition-as-status-update', request: await adapter.updateWorkItem(id, payload, { execute: false }) };
    return { result: await adapter.updateWorkItem(id, payload, { execute: true }) };
  },
  refusedUpdateFields: () => [],
  renderDiscussion: (text, mention) => (mention ? `@[${mention.id}] ${text}` : String(text)),
};

// capabilities: overrides for a scenario (e.g. { comments: false }).
function inMemory(capabilities = {}) {
  const calls = [];
  const write = (op) => async (id, payload, { execute = false } = {}) => {
    const d = { op, method: 'POST', url: `https://acme.example.com/api/${op}/${id}`, headers: {}, body: payload };
    if (!execute) return d;
    if (process.env.AGENTEX_CI === '1') { const e = new Error(`ci-mode: ${op} refused`); e.exitCode = 2; throw e; }
    calls.push({ method: 'POST', op, id });
    return { id };
  };
  const adapter = {
    name: provider,
    capabilities: { query: 'aql', comments: true, ...capabilities },
    webUrl: (id) => `https://acme.example.com/item/${id}`,
    async getWorkItem(id) { calls.push({ method: 'GET', op: 'getWorkItem', id }); return { ref: id, kind: 'Story', headline: 'Checkout totals', status: 'Open' }; },
    async query(text) { calls.push({ method: 'GET', op: 'query', text }); return { rows: [{ ref: 'A-1' }, { ref: 'A-2' }] }; },
    createWorkItem: write('createWorkItem'),
    updateWorkItem: write('updateWorkItem'),
    addRelation: write('addRelation'),
    addComment: write('addComment'),
  };
  return { adapter, calls };
}

module.exports = {
  provider, strategy, inMemory,
  refs: { item: 'A-1' },
  query: 'status = open',
  transitionTo: 'Done',
  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), '{}');
  },
  isWrite: (c) => c.method !== 'GET',
};
