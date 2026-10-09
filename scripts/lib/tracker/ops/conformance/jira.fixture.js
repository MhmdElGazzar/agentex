'use strict';
// Conformance fixture for the Jira tracker-ops strategy — consumed by
// ../conformance.test.js (the fixture contract is documented there). Offline:
// fake routes for an injected fetch; neutral placeholder site/project/people.
const fs = require('node:fs');
const path = require('node:path');

const ISSUE_1 = {
  key: 'PROJ-1', id: '10001',
  fields: { issuetype: { name: 'Story' }, summary: 'Checkout totals', status: { name: 'To Do' } },
};

module.exports = {
  refs: { item: 'PROJ-1' },
  query: 'project = "PROJ" AND status = "To Do"',
  transitionTo: 'Done',

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      jira: { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=SENTINEL-ops-conformance-token\n');
  },

  routes() {
    return [
      { match: '/issue/PROJ-1/transitions', json: { transitions: [{ id: '21', name: 'Done', to: { name: 'Done' } }] } },
      { method: 'POST', match: '/issue/PROJ-1/transitions', status: 204, text: '' },
      { match: '/rest/api/3/issue/PROJ-1?', json: ISSUE_1 },
      { method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 'Checkout totals' } }, { key: 'PROJ-2', fields: {} }] } },
    ];
  },

  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/search/jql')),
};
