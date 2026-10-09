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
  searchOptions: ({ top } = {}) => ({ max: 50, options: top ? { max: top } : {} }),
  searchResults: async (adapter, res) => ({
    results: (res.rows || []).map((r) => ({ id: r.ref, url: adapter.webUrl(r.ref) })),
    truncated: Boolean(res.more),
  }),
  batchRead: async (adapter, ids, fields) => {
    const rows = await adapter.readMany(ids);
    return { items: rows.map((r) => ({ id: r.ref, fields: Object.fromEntries(fields.map((f) => [f, r[f] ?? null])) })), missing: ids.filter((i) => !rows.some((r) => r.ref === i)) };
  },
  comments: async (adapter, id) => (await adapter.thread(id)).map((c) => ({ author: c.who, date: c.when, text: c.body })),
  relations: async (adapter, ids, kinds) => ({
    items: ids.map((id) => ({ id, relations: kinds.includes('child') ? [{ kind: 'child', id: `${id}-c1`, type: 'Task', title: 'child', state: 'Open' }] : [] })),
  }),
  iterations: async (adapter, { timeframe }) => (await adapter.cycles()).filter((c) => timeframe === 'all' || c.timeFrame === timeframe),
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
    capabilities: { query: 'aql', comments: true, batchRead: true, sprints: true, relations: { parent: true, child: true, related: true, testedBy: true }, ...capabilities },
    webUrl: (id) => `https://acme.example.com/item/${id}`,
    async getWorkItem(id) { calls.push({ method: 'GET', op: 'getWorkItem', id }); return { ref: id, kind: 'Story', headline: 'Checkout totals', status: 'Open' }; },
    async query(text) { calls.push({ method: 'GET', op: 'query', text }); return { rows: [{ ref: 'A-1' }, { ref: 'A-2' }] }; },
    async readMany(ids) { calls.push({ method: 'GET', op: 'readMany' }); return ids.filter((i) => i !== 'A-404').map((ref) => ({ ref, headline: `H ${ref}` })); },
    async thread() { calls.push({ method: 'GET', op: 'thread' }); return [{ who: 'Ana', when: '2026-01-01', body: 'first' }, { who: 'Ben', when: '2026-01-02', body: 'second' }]; },
    async cycles() { calls.push({ method: 'GET', op: 'cycles' }); return [{ id: 'c1', name: 'Cycle 1', startDate: null, finishDate: null, timeFrame: 'current' }]; },
    createWorkItem: write('createWorkItem'),
    updateWorkItem: write('updateWorkItem'),
    addRelation: write('addRelation'),
    addComment: write('addComment'),
  };
  return { adapter, calls };
}

module.exports = {
  provider, strategy, inMemory,
  refs: { item: 'A-1', item2: 'A-2', missing: 'A-404' },
  batchFields: ['headline'],
  query: 'status = open',
  transitionTo: 'Done',
  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), '{}');
  },
  isWrite: (c) => c.method !== 'GET',
};
