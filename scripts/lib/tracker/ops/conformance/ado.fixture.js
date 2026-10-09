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
  refs: { item: '42' },
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
      { method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 42 }, { id: 44 }] } },
      { method: 'PATCH', match: '/wit/workitems/42', json: { id: 42, rev: 2 } },
    ];
  },

  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/wiql')),
};
