'use strict';
// Conformance fixture for the ADO tracker-ops strategy — consumed by
// ../conformance.test.js (the fixture contract is documented there). Offline:
// fake routes for an injected fetch; neutral placeholder org/project/people.
const fs = require('node:fs');
const path = require('node:path');

const WI_42 = {
  id: 42,
  fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'Checkout totals', 'System.State': 'Active' },
};

module.exports = {
  refs: { item: '42', item2: '44', missing: '99' },
  batchFields: ['System.Title'],
  query: "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'",
  transitionTo: 'Resolved',

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      azure: { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'AZURE_PAT=SENTINEL-ops-conformance-pat\n');
  },

  routes() {
    return [
      { match: '/wit/workitems/42?', json: WI_42 },
      { method: 'POST', match: '/wit/wiql', bodyMatch: 'System.Parent', json: { workItems: [{ id: 501 }] } },
      { method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 42 }, { id: 44 }] } },
      { method: 'PATCH', match: '/wit/workitems/42', json: { id: 42, rev: 2 } },
      // Echo: every requested id except 99, with exactly the requested fields (children of 42).
      { method: 'POST', match: '/wit/workitemsbatch', respond: (call) => {
        const b = JSON.parse(call.body);
        const value = b.ids.filter((id) => id !== 99).map((id) => ({ id, fields: Object.fromEntries((b.fields || []).map((f) => [f, f === 'System.Parent' ? 42 : `${f} of ${id}`])) }));
        return { json: { value } };
      } },
      { match: '/wit/workItems/42/comments', json: { comments: [
        { id: 1, createdBy: { displayName: 'Ana' }, createdDate: '2026-01-01T00:00:00Z', text: '<div>first</div>' },
        { id: 2, createdBy: { displayName: 'Ben' }, createdDate: '2026-01-02T00:00:00Z', text: 'second' },
      ] } },
      { match: '/teamsettings/iterations', json: { value: [{ id: 'g1', name: 'Sprint 9', path: 'Sample Project\\Sprint 9', attributes: { timeFrame: 'current' } }] } },
    ];
  },

  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && (c.url.includes('/wiql') || c.url.includes('/workitemsbatch'))),
};
