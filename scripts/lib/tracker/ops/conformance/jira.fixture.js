'use strict';
// Conformance fixture for the Jira tracker-ops strategy — consumed by
// ../conformance.test.js (the fixture contract is documented there). Offline:
// fake routes for an injected fetch; neutral placeholder site/project/people.
const fs = require('node:fs');
const path = require('node:path');

const ISSUE_1 = {
  key: 'PROJ-1', id: '10001',
  fields: {
    issuetype: { name: 'Story' }, summary: 'Checkout totals', status: { name: 'To Do' },
    subtasks: [{ key: 'PROJ-5', fields: { summary: '[Testing] Test Execution', status: { name: 'To Do' }, issuetype: { name: 'Sub-task' } } }],
    issuelinks: [],
  },
};

module.exports = {
  refs: { item: 'PROJ-1', item2: 'PROJ-2', missing: 'PROJ-404' },
  batchFields: ['summary'],
  query: 'project = "PROJ" AND status = "To Do"',
  transitionTo: 'Done',

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      jira: { site: 'example', project: 'PROJ', board: '3', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=SENTINEL-ops-conformance-token\n');
  },

  routes() {
    return [
      { match: '/issue/PROJ-1/transitions', json: { transitions: [{ id: '21', name: 'Done', to: { name: 'Done' } }] } },
      { method: 'POST', match: '/issue/PROJ-1/transitions', status: 204, text: '' },
      { match: '/rest/api/3/issue/PROJ-1?', json: ISSUE_1 },
      { method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 'Checkout totals' } }, { key: 'PROJ-2', fields: {} }] } },
      { method: 'POST', match: '/issue/bulkfetch', json: { issues: [{ id: '10002', key: 'PROJ-2', fields: { summary: 'Other' } }, { id: '10001', key: 'PROJ-1', fields: { summary: 'Checkout totals' } }], issueErrors: [{ issueIdsOrKeys: ['PROJ-404'], status: 404 }] } },
      { match: '/issue/PROJ-1/comment', json: { total: 2, comments: [
        { id: '1', author: { displayName: 'Ana' }, created: '2026-01-01T00:00:00.000+0000', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] } },
        { id: '2', author: { displayName: 'Ben' }, created: '2026-01-02T00:00:00.000+0000', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] } },
      ] } },
      { match: '/rest/agile/1.0/board/3/sprint', json: { isLast: true, values: [{ id: 8, name: 'Sprint 8', state: 'active' }] } },
    ];
  },

  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && (c.url.includes('/search/jql') || c.url.includes('/issue/bulkfetch'))),
};
