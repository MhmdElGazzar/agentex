'use strict';
// Conformance fixture for the Jira task-estimation strategy — consumed by
// ../conformance.test.js (the fixture contract is documented there). Offline:
// fake routes for an injected fetch; neutral placeholder site/project/people.
const fs = require('node:fs');
const path = require('node:path');

const FIVE = ['Requirement Review', 'Test Creation', 'Test Execution', 'Bug Review and Retest', 'Automation']
  .map((t, i) => ({ title: `[Testing] ${t}`, estimate: i + 1 }));
const issue = (key, type, { subtasks = [] } = {}) => ({
  key,
  fields: {
    issuetype: { name: type }, summary: `Issue ${key}`, status: { name: 'In Progress' },
    customfield_10016: 5, customfield_10020: [{ id: 1, name: 'Sprint 1', state: 'active' }],
    ...(subtasks === null ? {} : { subtasks }),
  },
  renderedFields: { description: '<p>desc</p>' },
});
const WITH_CHILD = [
  { key: 'PROJ-21', fields: { summary: '[Testing] Test Execution', status: { name: 'To Do' } } },
  { key: 'PROJ-22', fields: { summary: 'Build the API', status: { name: 'To Do' } } },
];

module.exports = {
  refs: { story: 'PROJ-1', story2: 'PROJ-3', nonStory: 'PROJ-4', withTestingChild: 'PROJ-2' },
  nonStoryReason: 'story-not-a-story',

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      jira: { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=SENTINEL-conformance-token\n');
  },

  // scenario: 'happy' | 'non-story' | 'existing-children' | 'children-unreadable' | { failWriteAt: k }
  routes(scenario) {
    const failAt = scenario && typeof scenario === 'object' ? scenario.failWriteAt : null;
    return [
      ...(scenario === 'non-story' ? [{ match: '/rest/api/3/issue/PROJ-1?', json: issue('PROJ-1', 'Task') }] : []),
      ...(scenario === 'children-unreadable' ? [{ match: '/rest/api/3/issue/PROJ-2?', json: issue('PROJ-2', 'Story', { subtasks: null }) }] : []),
      { match: '/rest/api/3/field', json: [{ id: 'customfield_10016', name: 'Story Points' }, { id: 'customfield_10020', name: 'Sprint' }] },
      { method: 'POST', match: '/search/jql', json: { issues: [issue('PROJ-1', 'Story'), issue('PROJ-3', 'Story')] } },
      { match: '/rest/api/3/issue/PROJ-1?', json: issue('PROJ-1', 'Story') },
      { match: '/rest/api/3/issue/PROJ-2?', json: issue('PROJ-2', 'Story', { subtasks: WITH_CHILD }) },
      { match: '/rest/api/3/issue/PROJ-3?', json: issue('PROJ-3', 'Story') },
      { match: '/rest/api/3/issue/PROJ-4?', json: issue('PROJ-4', 'Bug') },
      { match: '/issue/createmeta/PROJ/issuetypes/10002', json: { total: 5, fields: ['summary', 'timetracking', 'labels', 'assignee', 'parent']
        .map((fieldId) => ({ fieldId, name: fieldId, required: fieldId === 'summary' })) } },
      { match: '/issue/createmeta/PROJ/issuetypes', json: { issueTypes: [
        { id: '10001', name: 'Story', subtask: false }, { id: '10002', name: 'Sub-task', subtask: true }, { id: '10003', name: 'Bug', subtask: false },
      ] } },
      { match: '/rest/api/3/user/search', json: [{ accountId: 'acc-1', emailAddress: 'qa.engineer@example.com', displayName: 'QA Engineer' }] },
      { method: 'POST', match: '/rest/api/3/issue', respond: (call, n) => (n === failAt
        ? { status: 400, text: JSON.stringify({ errorMessages: ['injected failure'] }) }
        : { json: { key: `PROJ-${100 + n}` } }) },
    ];
  },

  spec(storyRefs) {
    return { assignee: 'qa.engineer@example.com', stories: storyRefs.map((id) => ({ id, complexity: 'Simple', tasks: FIVE })) };
  },

  // Board writes only: the JQL search is a read.
  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/search/jql')),
};
