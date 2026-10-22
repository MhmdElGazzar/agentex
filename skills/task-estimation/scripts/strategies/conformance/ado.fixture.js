'use strict';
// Conformance fixture for the ADO task-estimation strategy — consumed by
// ../conformance.test.js (the fixture contract is documented there). Offline:
// fake routes for an injected fetch; neutral placeholder org/project/people.
const fs = require('node:fs');
const path = require('node:path');

const FIVE = ['Requirement Review', 'Test Creation', 'Test Execution', 'Bug Review and Retest', 'Automation']
  .map((t, i) => ({ title: `[Testing] ${t}`, estimate: i + 1 }));
const WI = 'https://dev.azure.com/exampleorg/_apis/wit/workItems';
const item = (id, type, extra = {}) => ({
  id,
  fields: {
    'System.WorkItemType': type, 'System.Title': `Item ${id}`, 'System.State': 'Active',
    'Microsoft.VSTS.Scheduling.StoryPoints': 3,
    'System.IterationPath': 'Sample Project\\Sprint 1', 'System.AreaPath': 'Sample Project',
  },
  ...extra,
});
const TASK_FIELDS = { value: [
  { referenceName: 'System.Title', alwaysRequired: true },
  { referenceName: 'Microsoft.VSTS.Common.Activity', allowedValues: ['Development', 'Testing'] },
  { referenceName: 'Microsoft.VSTS.Scheduling.OriginalEstimate' },
  { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork' },
] };

// The 'history' scenario: past iterations, two stories, their children.
const ITER = (id, name, timeFrame, finishDate) => ({ id, name, path: `Sample Project\\${name}`, attributes: { timeFrame, startDate: null, finishDate } });
const HISTORY_ITEMS = {
  201: { id: 201, fields: { 'System.Id': 201, 'System.Title': 'Contact preferences' } },
  202: { id: 202, fields: { 'System.Id': 202, 'System.Title': 'Checkout address form' } },
  601: { id: 601, fields: { 'System.Id': 601, 'System.Title': '[Testing] Test Execution', 'System.Parent': 201, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 2 } },
  602: { id: 602, fields: { 'System.Id': 602, 'System.Title': 'Build the API', 'System.Parent': 201, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 5 } },
  603: { id: 603, fields: { 'System.Id': 603, 'System.Title': '[Testing] Requirement Review', 'System.Parent': 202, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 1 } },
  604: { id: 604, fields: { 'System.Id': 604, 'System.Title': '[Testing] Automation', 'System.Parent': 202 } },
};
const HISTORY_ROUTES = [
  { match: '/Sample%20Team/_apis/work/teamsettings/iterations', json: { value: [
    ITER('i40', 'Sprint 40', 'past', '2026-08-31T00:00:00Z'), ITER('i42', 'Sprint 42', 'past', '2026-09-28T00:00:00Z'),
    ITER('i41', 'Sprint 41', 'past', '2026-09-14T00:00:00Z'), ITER('i43', 'Sprint 43', 'current', '2026-10-12T00:00:00Z'),
  ] } },
  { method: 'POST', match: '/wiql', bodyMatch: '[System.Parent]', json: { workItems: [{ id: 601 }, { id: 602 }, { id: 603 }, { id: 604 }] } },
  { method: 'POST', match: '/wiql', bodyMatch: '[System.IterationPath] IN', json: { workItems: [{ id: 201 }, { id: 202 }] } },
  { method: 'POST', match: '/workitemsbatch', respond: (call) => ({ json: { value: JSON.parse(call.body).ids.map((id) => HISTORY_ITEMS[id]) } }) },
];

module.exports = {
  refs: { story: 101, story2: 103, nonStory: 104, withTestingChild: 102, historyNonTesting: 602 },
  nonStoryReason: 'story-not-a-user-story',
  historySprintNames: ['Sprint 42', 'Sprint 41'],

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      azure: { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'AZURE_PAT=SENTINEL-conformance-pat\n');
  },

  // scenario: 'happy' | 'non-story' | 'existing-children' | 'children-unreadable' | 'history' | { failWriteAt: k }
  routes(scenario) {
    const failAt = scenario && typeof scenario === 'object' ? scenario.failWriteAt : null;
    return [
      ...(scenario === 'history' ? HISTORY_ROUTES : []),
      ...(scenario === 'non-story' ? [{ match: '/wit/workitems/101?', json: item(101, 'Bug') }] : []),
      ...(scenario === 'children-unreadable' ? [{ match: '/wit/workitems/555?', status: 500, text: 'unavailable' }] : []),
      { match: '/wit/workitems/101?', json: item(101, 'User Story') },
      { match: '/wit/workitems/102?', json: item(102, 'User Story', { relations: [
        { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${WI}/555` },
        { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${WI}/556` },
      ] }) },
      { match: '/wit/workitems/103?', json: item(103, 'User Story') },
      { match: '/wit/workitems/104?', json: item(104, 'Bug') },
      { match: '/wit/workitems/555?', json: { id: 555, fields: { 'System.Title': '[Testing] Test Execution', 'System.State': 'New' } } },
      { match: '/wit/workitems/556?', json: { id: 556, fields: { 'System.Title': 'Build the API', 'System.State': 'New' } } },
      { method: 'POST', match: '/wiql', json: { workItems: [{ id: 101 }, { id: 103 }] } },
      { match: '/wit/workitemtypes/Task/fields', json: TASK_FIELDS },
      { method: 'POST', match: 'validateOnly=true', json: {} },
      { method: 'POST', match: '/workitems/$Task', respond: (call, n) => (n === failAt
        ? { status: 500, text: JSON.stringify({ message: 'injected failure' }) }
        : { json: { id: 9000 + n } }) },
    ];
  },

  spec(storyRefs) {
    return { assignee: 'qa.engineer@example.com', stories: storyRefs.map((id) => ({ id, complexity: 'Simple', tasks: FIVE })) };
  },

  // Board writes only: the WIQL read, the batch read and the validateOnly probe write nothing.
  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && (c.url.includes('/wiql') || c.url.includes('/workitemsbatch'))) &&
    !c.url.includes('validateOnly=true'),
};
