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

module.exports = {
  refs: { story: 101, story2: 103, nonStory: 104, withTestingChild: 102 },
  nonStoryReason: 'story-not-a-user-story',

  project(dir) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      azure: { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com' },
    }));
    fs.writeFileSync(path.join(dir, '.env'), 'AZURE_PAT=SENTINEL-conformance-pat\n');
  },

  // scenario: 'happy' | 'non-story' | 'existing-children' | 'children-unreadable' | { failWriteAt: k }
  routes(scenario) {
    const failAt = scenario && typeof scenario === 'object' ? scenario.failWriteAt : null;
    return [
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

  // Board writes only: the WIQL read and the validateOnly probe write nothing.
  isWrite: (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/wiql')) && !c.url.includes('validateOnly=true'),
};
