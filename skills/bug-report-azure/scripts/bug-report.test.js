'use strict';
// Focused tests for the semantic bug-report boundary. All Azure traffic is
// injected; no org, CLI, or package dependency is required.
// Run: node skills/bug-report-azure/scripts/bug-report.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./bug-report.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack || e.message}`); }
}

const PAT = 'SENTINEL-PAT-high-level-boundary-001122334455';
for (const name of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT', 'AGENTEX_CI']) delete process.env[name];

function png(width = 1280, height = 720) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  const idatLen = 16_384;
  const idat = Buffer.alloc(12 + idatLen);
  idat.writeUInt32BE(idatLen, 0); idat.write('IDAT', 4);
  for (let i = 0; i < idatLen; i++) idat[8 + i] = (i * 37) % 251;
  const iend = Buffer.alloc(12); iend.writeUInt32BE(0, 0); iend.write('IEND', 4);
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function project(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-br-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: {
      org: 'exampleorg', project: 'Sample Project', assignee: 'qa.engineer@example.com',
      environment: 'QA', bugTemplateId: 99, testPlanId: 3,
      ...overrides,
    },
  }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${PAT}\n`);
  fs.writeFileSync(path.join(dir, 'evidence.png'), png());
  return dir;
}

const BUG_FIELDS = {
  value: [
    { referenceName: 'System.Title', alwaysRequired: true },
    { referenceName: 'System.AreaPath' }, { referenceName: 'System.IterationPath' },
    { referenceName: 'System.AssignedTo', alwaysRequired: true },
    { referenceName: 'Microsoft.VSTS.Common.Severity', alwaysRequired: true, allowedValues: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] },
    { referenceName: 'Microsoft.VSTS.Common.Priority', alwaysRequired: true, allowedValues: ['1', '2', '3', '4'] },
    { referenceName: 'Microsoft.VSTS.Common.ValueArea', allowedValues: ['Business', 'Architectural'] },
    { referenceName: 'Custom.Environment', allowedValues: ['QA', 'UAT', 'Prod'] },
    { referenceName: 'Custom.BugCategory', allowedValues: ['Functional', 'UI', 'Data'] },
    { referenceName: 'Microsoft.VSTS.TCM.ReproSteps', alwaysRequired: true },
    { referenceName: 'Custom.RequiredFoo', alwaysRequired: true },
  ],
};
const TEST_CASE_FIELDS = { value: [{ referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'System.AreaPath' }] };
const PARENT = {
  id: 321,
  fields: {
    'System.WorkItemType': 'User Story', 'System.Title': 'Checkout story', 'System.State': 'Active',
    'System.AreaPath': 'Sample Project\\Checkout', 'System.IterationPath': 'Sample Project\\Sprint 9',
  },
  _links: { html: { href: 'https://example.test/workitems/321' } },
};
const TEMPLATE = {
  id: 99,
  fields: {
    'System.WorkItemType': 'Bug', 'System.Title': 'Team bug template', 'System.State': 'New',
    'Custom.Environment': 'UAT', 'Custom.BugCategory': 'Functional',
    'Microsoft.VSTS.Common.ValueArea': 'Business',
  },
};
const TEST_CASE = {
  id: 77,
  fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'Pay by card', 'System.State': 'Ready' },
};
const SUITES = { value: [{ id: 4, name: 'Regression', suiteType: 'staticTestSuite' }] };
const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward';

function childRelation(id, rel = CHILD_LINK) {
  return { rel, url: `https://example.test/_apis/wit/workItems/${id}` };
}

function parentWithRelations(relations) {
  return { ...PARENT, relations };
}

function childWorkItem(id, type, title, state, repro, url) {
  return {
    id,
    fields: {
      'System.WorkItemType': type,
      'System.Title': title,
      'System.State': state,
      ...(repro ? { 'Microsoft.VSTS.TCM.ReproSteps': repro } : {}),
    },
    ...(url ? { _links: { html: { href: url } } } : {}),
  };
}

function projectedChildWorkItem(item) {
  const workItem = childWorkItem(
    item.id,
    item.type || 'Bug',
    item.title,
    item.state || 'Active',
    item.reproductionSummary,
    item.url,
  );
  workItem.fields['System.Id'] = item.id;
  return workItem;
}

function batchRoute(items, overrides = {}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    method: 'POST',
    match: '/wit/workitemsbatch',
    respond: async (call) => {
      const body = JSON.parse(call.body);
      let value = body.ids
        .filter((id) => byId.has(id))
        .map((id) => projectedChildWorkItem(byId.get(id)));
      if (overrides.reverse) value = value.reverse();
      if (overrides.omitId) value = value.filter((item) => item.id !== overrides.omitId);
      return { status: overrides.status || 200, json: { count: value.length, value } };
    },
  };
}

function parentBugRoutes(items) {
  return [
    { match: '/wit/workitems/321', json: parentWithRelations(items.map((item) => childRelation(item.id))) },
    batchRoute(items),
    ...items.map((item) => ({
      match: `/wit/workitems/${item.id}`,
      json: childWorkItem(
        item.id, item.type || 'Bug', item.title, item.state || 'Active', item.reproductionSummary, item.url,
      ),
    })),
  ];
}

function baseRoutes() {
  return [
    { match: '/wit/workitems/99', json: TEMPLATE },
    { match: '/wit/workitems/321', json: PARENT },
    { match: '/wit/workitems/77', json: TEST_CASE },
    { match: '/workitemtypes/Bug/fields', json: BUG_FIELDS },
    { match: '/workitemtypes/Test%20Case/fields', json: TEST_CASE_FIELDS },
    {
      method: 'POST', match: '/wit/workitemsbatch', status: 405,
      text: JSON.stringify({ message: 'workitemsbatch endpoint unavailable' }),
    },
    { method: 'POST', match: '/wiql', json: { workItems: [] } },
    { method: 'POST', match: 'validateOnly=true', json: {} },
    { match: '/testplan/Plans/3/suites', json: SUITES },
    { match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [{ id: 900 }] } },
    { method: 'POST', match: '/wit/attachments', json: { id: 'att-1', url: 'https://example.test/_apis/wit/attachments/att-1' } },
    { method: 'POST', match: '/workitems/$Bug', json: { id: 4711 } },
    { method: 'PATCH', match: '/workitems/4711', json: { id: 4711, rev: 2 } },
    { method: 'POST', match: '/test/runs?', json: { id: 88, url: 'https://example.test/_apis/test/runs/88' } },
    { match: '/test/Runs/88/results', json: { value: [{ id: 100000 }] } },
    { method: 'PATCH', match: '/test/Runs/88/results', json: {} },
    { method: 'PATCH', match: '/test/runs/88?', json: { id: 88, state: 'Completed' } },
    { method: 'PATCH', match: '/workitems/77', json: { id: 77 } },
    { method: 'POST', match: '/workitems/$Test%20Case', json: { id: 505 } },
    { method: 'PATCH', match: '/testplan/suiteentry/4', json: {} },
  ];
}

function fakeFetch(extra = []) {
  const routes = [...extra, ...baseRoutes()];
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} };
    calls.push(call);
    for (const route of routes) {
      if ((route.method || 'GET') !== call.method) continue;
      if (!call.url.includes(route.match)) continue;
      if (route.bodyMatch && !(typeof call.body === 'string' && call.body.includes(route.bodyMatch))) continue;
      const resolved = route.respond ? await route.respond(call) : route;
      const status = resolved.status || 200;
      return {
        ok: status < 300,
        status,
        text: async () => resolved.text !== undefined ? resolved.text : JSON.stringify(resolved.json || {}),
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

function writeIntent(dir, value) {
  const file = path.join(dir, `intent-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function hasOwnPath(value, dottedPath) {
  let current = value;
  for (const part of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return true;
}

function intent(dir, testCase = { action: 'skip' }, overrides = {}) {
  const value = {
    title: 'Payment fails at checkout',
    summary: 'Clicking Pay shows an error page',
    steps: ['Open checkout', 'Enter valid card details', 'Click Pay'],
    expected: 'The order confirmation is shown',
    actual: 'An HTTP 500 page is shown',
    severity: '1 - Critical', priority: 1,
    classificationReason: 'The core checkout flow is blocked with no workaround.',
    parentStoryId: 321,
    evidence: { attach: [path.join(dir, 'evidence.png')], reject: [] },
    testCase,
    ...overrides,
  };
  return writeIntent(dir, value);
}

function planPath(dir) {
  return path.join(dir, `plan-${Math.random().toString(16).slice(2)}.json`);
}

function actualWrites(calls) {
  return calls.filter((call) =>
    call.method === 'PATCH' ||
    (call.method === 'POST' && (
      call.url.includes('/attachments') || call.url.includes('/test/runs?') ||
      (call.url.includes('/workitems/$') && !call.url.includes('validateOnly=true'))
    ))
  );
}

async function review(dir, fetch, intentFile, extraArgs = []) {
  return run(['context', '--intent', intentFile, ...extraArgs], { cwd: dir, fetch });
}

async function prepareIntentFile(dir, fetch, intentFile, plan = planPath(dir)) {
  const reviewed = await review(dir, fetch, intentFile);
  assert.strictEqual(reviewed.code, 0, JSON.stringify(reviewed.out));
  const result = await run([
    'prepare', '--intent', intentFile,
    '--duplicate-review', reviewed.out.duplicateReview.reviewId,
    '--plan', plan,
  ], {
    cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z',
  });
  return { ...result, plan, review: reviewed.out };
}

async function prepare(dir, fetch, testCase, overrides = {}) {
  return prepareIntentFile(dir, fetch, intent(dir, testCase, overrides));
}

(async () => {
  await test('context returns compact template/config/field decisions and no Azure mechanics', async () => {
    const dir = project(); const fetch = fakeFetch();
    const { code, out } = await run(['context', '--parent', '321'], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.parent, { id: 321, type: 'User Story', title: 'Checkout story', state: 'Active', url: 'https://example.test/workitems/321' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'duplicateCandidates'), false);
    assert.deepStrictEqual(out.duplicateReview, {
      status: 'intent-required',
      strategy: 'lexical-idf-recall-v0',
      view: 'shortlist',
      defaultShortlistSize: 25,
      totalCandidates: 0,
      shownCandidates: 0,
      omittedCandidateCount: 0,
      truncated: false,
      pinnedExactTitleCount: 0,
      shortlistCandidateIds: [],
    });
    assert.strictEqual(out.template.id, 99);
    assert.strictEqual(out.defaults.environment, 'QA', 'configuration wins over template default');
    assert.strictEqual(out.defaults.bugCategory, 'Functional', 'template fills an otherwise missing default');
    assert.deepStrictEqual(out.choices.severity, ['1 - Critical', '2 - High', '3 - Medium', '4 - Low']);
    assert.deepStrictEqual(out.requiredInputs.assignedTo, {
      required: true,
      resolved: true,
      needsUserInput: false,
      choices: ['qa.engineer@example.com'],
    });
    assert.ok(out.processRequirements.unsupported.includes('required foo'));
    assert.strictEqual(out.testPlan.id, '3');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'intentTemplate'), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
    const publicJson = JSON.stringify(out);
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch|Authorization/i.test(publicJson), publicJson);
    assert.ok(!publicJson.includes(PAT));
  });

  await test('context --emit-intent emits a safe scaffold that prepare remains authoritative for', async () => {
    const dir = project(); const fetch = fakeFetch();
    const { code, out } = await run(['context', '--parent', '321', '--emit-intent'], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.intentTemplate, {
      title: null,
      summary: null,
      steps: [],
      expected: null,
      actual: null,
      severity: null,
      priority: null,
      classificationReason: null,
      parentStoryId: 321,
      assignedTo: null,
      environment: null,
      bugCategory: null,
      valueArea: null,
      testConfiguration: null,
      observedAt: null,
      evidence: {
        attach: [], reject: [], waiveScreenshots: false, allowInvalid: false,
      },
      duplicate: { allow: false },
      testCase: {
        action: null,
        planId: null,
        testCaseId: null,
        comment: null,
        runName: null,
        suiteId: null,
        title: null,
        allowDuplicate: false,
      },
    });
    assert.strictEqual(out.defaults.assignedTo, 'qa.engineer@example.com');
    assert.strictEqual(out.defaults.environment, 'QA');
    assert.strictEqual(out.testPlan.id, '3');
    assert.strictEqual(out.duplicateReview.status, 'intent-required');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'duplicateCandidates'), false);

    const untouchedPlan = planPath(dir);
    const untouched = await run([
      'prepare', '--intent', writeIntent(dir, out.intentTemplate), '--plan', untouchedPlan,
    ], { cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z' });
    assert.strictEqual(untouched.code, 2, JSON.stringify(untouched.out));
    assert.strictEqual(fs.existsSync(untouchedPlan), false);
    assert.ok(untouched.out.blocked.every((item) => item.reason === 'missing-input'), JSON.stringify(untouched.out));
    assert.deepStrictEqual(untouched.out.blocked.map((item) => item.field).sort(), [
      'actual', 'classificationReason', 'expected', 'priority', 'severity', 'steps',
      'summary', 'testCase.action', 'title',
    ].sort());
    for (const item of untouched.out.blocked) {
      assert.strictEqual(hasOwnPath(out.intentTemplate, item.field), true, item.field);
    }

    const completed = JSON.parse(JSON.stringify(out.intentTemplate));
    Object.assign(completed, {
      title: 'Payment fails at checkout',
      summary: 'Clicking Pay shows an error page',
      steps: ['Open checkout', 'Enter valid card details', 'Click Pay'],
      expected: 'The order confirmation is shown',
      actual: 'An HTTP 500 page is shown',
      severity: '1 - Critical',
      priority: 1,
      classificationReason: 'The core checkout flow is blocked with no workaround.',
    });
    completed.evidence.attach = [path.join(dir, 'evidence.png')];
    completed.testCase.action = 'skip';
    const completedIntent = writeIntent(dir, completed);
    const reviewed = await review(dir, fetch, completedIntent);
    assert.strictEqual(reviewed.code, 0, JSON.stringify(reviewed.out));
    const completedPlan = planPath(dir);
    const prepared = await run([
      'prepare', '--intent', completedIntent,
      '--duplicate-review', reviewed.out.duplicateReview.reviewId,
      '--plan', completedPlan,
    ], { cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    assert.strictEqual(fs.existsSync(completedPlan), true);
    assert.strictEqual(prepared.out.approval.bug.assignedTo, 'qa.engineer@example.com');
    assert.strictEqual(prepared.out.approval.bug.environment, 'QA');
    assert.strictEqual(prepared.out.approval.bug.bugCategory, 'Functional');
    assert.deepStrictEqual(prepared.out.approval.testCase, { action: 'skip' });
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('intent-aware context returns a ranked default shortlist instead of all parent candidates', async () => {
    const dir = project();
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: 8100 + index,
      title: `Unrelated marine regression ${index + 1}`,
      state: index % 3 === 0 ? 'Closed' : 'Active',
      reproductionSummary: `Unrelated policy flow marker ${index + 1}.`,
    }));
    items[29] = {
      id: 8129,
      title: 'Valid card submission returns a server error',
      state: 'Resolved',
      reproductionSummary: '<div>Submitting a valid Visa returns HTTP 500 at checkout.</div>',
    };
    const fetch = fakeFetch(parentBugRoutes(items));
    const intentFile = intent(dir);
    const { code, out } = await run(['context', '--intent', intentFile], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.duplicateReview.defaultShortlistSize, 25);
    assert.strictEqual(out.duplicateReview.totalCandidates, 30);
    assert.strictEqual(out.duplicateReview.shownCandidates, 25);
    assert.strictEqual(out.duplicateReview.omittedCandidateCount, 5);
    assert.strictEqual(out.duplicateReview.truncated, true);
    assert.deepStrictEqual(out.duplicateCandidates.map((candidate) => candidate.id), out.duplicateReview.shortlistCandidateIds);
    const strong = out.duplicateCandidates.find((candidate) => candidate.id === 8129);
    assert.ok(strong, JSON.stringify(out.duplicateCandidates));
    assert.strictEqual(strong.reproductionSummary, 'Submitting a valid Visa returns HTTP 500 at checkout.');
    assert.ok(fetch.calls.some((call) =>
      call.url.includes('/wit/workitems/321') && call.url.includes('$expand=all')));
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('normalized exact-title matches are pinned beyond the nominal shortlist cap', async () => {
    const dir = project();
    const exacts = Array.from({ length: 27 }, (_, index) => ({
      id: 8200 + index,
      title: index % 2 ? '  PAYMENT   FAILS AT CHECKOUT  ' : 'Payment fails at checkout',
      state: index % 3 === 0 ? 'Closed' : 'Resolved',
      reproductionSummary: `Exact-title candidate ${index + 1}.`,
    }));
    const distractors = Array.from({ length: 10 }, (_, index) => ({
      id: 8300 + index,
      title: `Payment checkout diagnostic ${index + 1}`,
      state: 'Active',
      reproductionSummary: 'Valid card produces an HTTP 500 error page.',
    }));
    const fetch = fakeFetch(parentBugRoutes([...distractors, ...exacts]));
    const reviewed = await review(dir, fetch, intent(dir));
    assert.strictEqual(reviewed.code, 0, JSON.stringify(reviewed.out));
    assert.strictEqual(reviewed.out.duplicateReview.defaultShortlistSize, 25);
    assert.strictEqual(reviewed.out.duplicateReview.pinnedExactTitleCount, 27);
    assert.strictEqual(reviewed.out.duplicateReview.shownCandidates, 27);
    assert.strictEqual(reviewed.out.duplicateReview.omittedCandidateCount, 10);
    assert.deepStrictEqual(
      new Set(reviewed.out.duplicateCandidates.map((candidate) => candidate.id)),
      new Set(exacts.map((candidate) => candidate.id)),
    );
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('duplicate-view all returns the complete ranked candidate set', async () => {
    const dir = project();
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: 8400 + index,
      title: `Candidate ${index + 1}`,
      state: index % 2 ? 'Closed' : 'New',
      reproductionSummary: `Checkout reproduction ${index + 1}.`,
    }));
    const fetch = fakeFetch(parentBugRoutes(items));
    const intentFile = intent(dir);
    const shortlist = await review(dir, fetch, intentFile);
    const complete = await review(dir, fetch, intentFile, ['--duplicate-view', 'all']);
    assert.strictEqual(shortlist.code, 0, JSON.stringify(shortlist.out));
    assert.strictEqual(complete.code, 0, JSON.stringify(complete.out));
    assert.strictEqual(complete.out.duplicateReview.view, 'all');
    assert.strictEqual(complete.out.duplicateReview.totalCandidates, 30);
    assert.strictEqual(complete.out.duplicateReview.shownCandidates, 30);
    assert.strictEqual(complete.out.duplicateReview.omittedCandidateCount, 0);
    assert.strictEqual(complete.out.duplicateReview.truncated, false);
    assert.strictEqual(complete.out.duplicateReview.reviewId, shortlist.out.duplicateReview.reviewId);
    assert.deepStrictEqual(
      new Set(complete.out.duplicateCandidates.map((candidate) => candidate.id)),
      new Set(items.map((candidate) => candidate.id)),
    );
    assert.deepStrictEqual(
      complete.out.duplicateCandidates.slice(0, 25).map((candidate) => candidate.id),
      shortlist.out.duplicateCandidates.map((candidate) => candidate.id),
    );
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('parent discovery uses two projected batches for a 287-child corpus and keeps every state', async () => {
    const dir = project();
    const states = ['Active', 'Closed', 'Resolved'];
    const items = Array.from({ length: 287 }, (_, index) => ({
      id: 9000 + index,
      title: `Projected candidate ${index + 1}`,
      state: states[index % states.length],
      reproductionSummary: `<div>Projected reproduction ${index + 1}</div>`,
    }));
    const fetch = fakeFetch(parentBugRoutes(items));
    const { code, out } = await run([
      'context', '--intent', intent(dir), '--duplicate-view', 'all',
    ], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.duplicateReview.totalCandidates, 287);
    assert.deepStrictEqual(
      new Set(out.duplicateCandidates.map((candidate) => candidate.state)),
      new Set(states),
    );

    const batches = fetch.calls.filter((call) =>
      call.method === 'POST' && call.url.includes('/wit/workitemsbatch'));
    assert.strictEqual(batches.length, 2);
    const bodies = batches.map((call) => JSON.parse(call.body));
    assert.deepStrictEqual(bodies.map((body) => body.ids.length), [200, 87]);
    assert.deepStrictEqual(bodies.flatMap((body) => body.ids), items.map((item) => item.id));
    for (const body of bodies) {
      assert.deepStrictEqual(body.fields, [
        'System.Id',
        'System.WorkItemType',
        'System.Title',
        'System.State',
        'Microsoft.VSTS.TCM.ReproSteps',
      ]);
      assert.strictEqual(body.$expand, 'links');
      assert.strictEqual(body.errorPolicy, 'fail');
    }
    assert.strictEqual(fetch.calls.some((call) =>
      call.method === 'GET' && /\/wit\/workitems\/9\d{3}\?/.test(call.url)), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('a missing child in a batch response fails closed without fallback or writes', async () => {
    const dir = project(); const plan = planPath(dir);
    const items = [
      { id: 9301, title: 'First candidate', state: 'Active' },
      { id: 9302, title: 'Omitted candidate', state: 'Closed' },
    ];
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations(items.map((item) => childRelation(item.id))) },
      batchRoute(items, { omitId: 9302 }),
      ...items.map((item) => ({
        match: `/wit/workitems/${item.id}`,
        json: childWorkItem(item.id, 'Bug', item.title, item.state),
      })),
    ]);
    const result = await run([
      'prepare', '--intent', intent(dir), '--plan', plan,
    ], { cwd: dir, fetch });
    assert.strictEqual(result.code, 2, JSON.stringify(result.out));
    assert.strictEqual(result.out.blocked[0].reason, 'dup-check-failed');
    assert.strictEqual(result.out.nothingWritten, true);
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(fetch.calls.some((call) =>
      call.method === 'GET' && /\/wit\/workitems\/930[12]\?/.test(call.url)), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('a batch service error fails closed without individual-read fallback', async () => {
    const dir = project(); const plan = planPath(dir);
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(9311), childRelation(9312)]) },
      {
        method: 'POST', match: '/wit/workitemsbatch', status: 503,
        text: JSON.stringify({ message: 'batch service unavailable' }),
      },
      { match: '/wit/workitems/9311', json: childWorkItem(9311, 'Bug', 'Candidate one', 'Active') },
      { match: '/wit/workitems/9312', json: childWorkItem(9312, 'Bug', 'Candidate two', 'Resolved') },
    ]);
    const result = await run([
      'prepare', '--intent', intent(dir), '--plan', plan,
    ], { cwd: dir, fetch });
    assert.strictEqual(result.code, 2, JSON.stringify(result.out));
    assert.strictEqual(result.out.blocked[0].reason, 'dup-check-failed');
    assert.strictEqual(result.out.nothingWritten, true);
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(fetch.calls.some((call) =>
      call.method === 'GET' && /\/wit\/workitems\/931[12]\?/.test(call.url)), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('an unavailable batch endpoint uses bounded concurrent individual reads', async () => {
    const dir = project();
    const ids = Array.from({ length: 24 }, (_, index) => 9400 + index);
    let active = 0; let maxActive = 0;
    const childRoutes = ids.map((id) => ({
      match: `/wit/workitems/${id}`,
      respond: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return { json: childWorkItem(id, 'Bug', 'Fallback candidate', 'Closed') };
      },
    }));
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations(ids.map((id) => childRelation(id))) },
      {
        method: 'POST', match: '/wit/workitemsbatch', status: 405,
        text: JSON.stringify({ message: 'method unavailable' }),
      },
      ...childRoutes,
    ]);
    const { code, out } = await run([
      'context', '--intent', intent(dir), '--duplicate-view', 'all',
    ], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.duplicateReview.totalCandidates, ids.length);
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'GET' && /\/wit\/workitems\/94\d{2}\?/.test(call.url)).length, ids.length);
    assert.ok(maxActive > 1, `expected concurrent reads, observed ${maxActive}`);
    assert.ok(maxActive <= 8, `expected at most 8 reads, observed ${maxActive}`);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('an explicit projected-field rejection uses the bounded compatibility fallback', async () => {
    const dir = project();
    const items = [
      { id: 9451, title: 'Projection fallback candidate', state: 'Resolved' },
      { id: 9452, title: 'Second projection fallback candidate', state: 'Closed' },
    ];
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations(items.map((item) => childRelation(item.id))) },
      {
        method: 'POST', match: '/wit/workitemsbatch', status: 400,
        text: JSON.stringify({
          message: 'Field Microsoft.VSTS.TCM.ReproSteps is not supported by this endpoint.',
        }),
      },
      ...items.map((item) => ({
        match: `/wit/workitems/${item.id}`,
        json: childWorkItem(item.id, 'Bug', item.title, item.state),
      })),
    ]);
    const { code, out } = await run([
      'context', '--intent', intent(dir), '--duplicate-view', 'all',
    ], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.duplicateReview.totalCandidates, 2);
    assert.deepStrictEqual(
      new Set(out.duplicateCandidates.map((candidate) => candidate.state)),
      new Set(['Closed', 'Resolved']),
    );
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'GET' && /\/wit\/workitems\/945[12]\?/.test(call.url)).length, 2);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('a successful batch missing an always-present projected field uses the compatibility fallback', async () => {
    const dir = project();
    const id = 9461;
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(id)]) },
      {
        method: 'POST', match: '/wit/workitemsbatch',
        json: {
          count: 1,
          value: [{
            id,
            fields: {
              'System.Id': id,
              'System.WorkItemType': 'Bug',
              'System.State': 'Closed',
            },
          }],
        },
      },
      {
        match: `/wit/workitems/${id}`,
        json: childWorkItem(id, 'Bug', 'Hydrated title', 'Closed'),
      },
    ]);
    const { code, out } = await run([
      'context', '--intent', intent(dir), '--duplicate-view', 'all',
    ], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.duplicateCandidates, [{
      id, type: 'Bug', title: 'Hydrated title', state: 'Closed',
    }]);
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'GET' && call.url.includes(`/wit/workitems/${id}?`)).length, 1);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('batch discovery is candidate- and ranking-equivalent to individual reads', async () => {
    const dir = project();
    const intentFile = intent(dir);
    const items = [
      {
        id: 9501, type: 'Bug', title: 'Payment fails at checkout', state: 'Closed',
        reproductionSummary: '<div>Valid card returns <b>HTTP 500</b>.</div>',
        url: 'https://example.test/workitems/9501',
      },
      { id: 9502, type: 'Task', title: 'Implementation task', state: 'Active' },
      {
        id: 9503, type: 'Bug', title: 'Different checkout issue', state: 'Resolved',
        reproductionSummary: '<p>Checkout footer is clipped.</p>',
        url: 'https://example.test/workitems/9503',
      },
    ];
    const relations = [
      childRelation(9599, 'System.LinkTypes.Related'),
      childRelation(9501), childRelation(9502), childRelation(9503), childRelation(9501),
    ];
    const batchFetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations(relations) },
      batchRoute(items, { reverse: true }),
    ]);
    const individualFetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations(relations) },
      {
        method: 'POST', match: '/wit/workitemsbatch', status: 405,
        text: JSON.stringify({ message: 'method unavailable' }),
      },
      ...items.map((item) => ({
        match: `/wit/workitems/${item.id}`,
        json: childWorkItem(
          item.id, item.type, item.title, item.state, item.reproductionSummary, item.url,
        ),
      })),
    ]);

    const batched = await review(dir, batchFetch, intentFile, ['--duplicate-view', 'all']);
    const individual = await review(dir, individualFetch, intentFile, ['--duplicate-view', 'all']);
    assert.strictEqual(batched.code, 0, JSON.stringify(batched.out));
    assert.strictEqual(individual.code, 0, JSON.stringify(individual.out));
    assert.deepStrictEqual(batched.out.duplicateCandidates, individual.out.duplicateCandidates);
    assert.deepStrictEqual(batched.out.duplicateCandidates, [
      {
        id: 9501, type: 'Bug', title: 'Payment fails at checkout', state: 'Closed',
        url: 'https://example.test/workitems/9501',
        reproductionSummary: 'Valid card returns HTTP 500 .',
      },
      {
        id: 9503, type: 'Bug', title: 'Different checkout issue', state: 'Resolved',
        url: 'https://example.test/workitems/9503',
        reproductionSummary: 'Checkout footer is clipped.',
      },
    ]);
    assert.strictEqual(
      batched.out.duplicateReview.reviewId,
      individual.out.duplicateReview.reviewId,
      'equivalent acquisition produces the same ranked review receipt',
    );
    assert.deepStrictEqual(
      JSON.parse(batchFetch.calls.find((call) => call.url.includes('/wit/workitemsbatch')).body).ids,
      [9501, 9502, 9503],
    );
    assert.strictEqual(batchFetch.calls.some((call) => call.url.includes('/wit/workitems/9599')), false);
  });

  await test('prepare surfaces an unrelated sibling Bug without automatically blocking', async () => {
    const dir = project();
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(611)]) },
      { match: '/wit/workitems/611', json: childWorkItem(611, 'Bug', 'Checkout header overlaps the logo', 'Active') },
    ]);
    const result = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(result.code, 0, JSON.stringify(result.out));
    assert.strictEqual(fs.existsSync(result.plan), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.out.approval, 'duplicateCandidates'), false);
    assert.strictEqual(result.out.approval.duplicateReview.totalCandidates, 1);
    assert.deepStrictEqual(result.out.approval.duplicateReview.shortlistCandidateIds, [611]);
    assert.strictEqual(result.out.approval.duplicateDecision, 'no exception requested');
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('parent discovery returns only unique direct Bug children', async () => {
    const dir = project();
    const fetch = fakeFetch([
      {
        match: '/wit/workitems/321',
        json: parentWithRelations([
          childRelation(612, 'System.LinkTypes.Related'),
          childRelation(613),
          childRelation(614),
          childRelation(614),
        ]),
      },
      { match: '/wit/workitems/612', json: childWorkItem(612, 'Bug', 'Bug under another scope', 'Active') },
      { match: '/wit/workitems/613', json: childWorkItem(613, 'Task', 'Implementation task', 'Active') },
      { match: '/wit/workitems/614', json: childWorkItem(614, 'Bug', 'Direct child Bug', 'New') },
    ]);
    const { code, out } = await run(['context', '--intent', intent(dir)], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.duplicateCandidates, [{
      id: 614, type: 'Bug', title: 'Direct child Bug', state: 'New',
    }]);
    assert.strictEqual(fetch.calls.filter((call) => call.url.includes('/wit/workitems/614')).length, 1);
    assert.strictEqual(fetch.calls.some((call) => call.url.includes('/wit/workitems/612')), false);
  });

  await test('parent discovery includes closed and resolved Bug children', async () => {
    const dir = project();
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(615), childRelation(616)]) },
      { match: '/wit/workitems/615', json: childWorkItem(615, 'Bug', 'Previously closed defect', 'Closed') },
      { match: '/wit/workitems/616', json: childWorkItem(616, 'Bug', 'Fix awaiting verification', 'Resolved') },
    ]);
    const { code, out } = await run(['context', '--intent', intent(dir)], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(new Set(out.duplicateCandidates.map((candidate) => candidate.state)), new Set(['Closed', 'Resolved']));
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('parent discovery failures fail closed before a plan or board write', async () => {
    const dir1 = project(); const plan1 = planPath(dir1);
    const malformedFetch = fakeFetch([{
      match: '/wit/workitems/321',
      json: parentWithRelations([{ rel: CHILD_LINK, url: 'not-a-work-item' }]),
    }]);
    const malformed = await run([
      'prepare', '--intent', intent(dir1), '--plan', plan1,
    ], { cwd: dir1, fetch: malformedFetch });
    assert.strictEqual(malformed.code, 2, JSON.stringify(malformed.out));
    assert.strictEqual(malformed.out.blocked[0].reason, 'dup-check-failed');
    assert.strictEqual(malformed.out.nothingWritten, true);
    assert.strictEqual(fs.existsSync(plan1), false);
    assert.strictEqual(actualWrites(malformedFetch.calls).length, 0);

    const dir2 = project(); const plan2 = planPath(dir2);
    const unreadableFetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(617)]) },
      { match: '/wit/workitems/617', status: 503, text: JSON.stringify({ message: 'child unavailable' }) },
    ]);
    const unreadable = await run([
      'prepare', '--intent', intent(dir2), '--plan', plan2,
    ], { cwd: dir2, fetch: unreadableFetch });
    assert.strictEqual(unreadable.code, 2, JSON.stringify(unreadable.out));
    assert.strictEqual(unreadable.out.blocked[0].reason, 'dup-check-failed');
    assert.strictEqual(unreadable.out.nothingWritten, true);
    assert.strictEqual(fs.existsSync(plan2), false);
    assert.strictEqual(actualWrites(unreadableFetch.calls).length, 0);

    const dir3 = project();
    const malformedChildFetch = fakeFetch([
      {
        match: '/wit/workitems/321',
        json: parentWithRelations([childRelation(619), childRelation(620)]),
      },
      { match: '/wit/workitems/619', json: childWorkItem(619, 'Bug', 'Candidate read before failure', 'Active') },
      { match: '/wit/workitems/620', json: { id: 620, fields: { 'System.Title': 'Missing type' } } },
    ]);
    const malformedChild = await run(['context', '--intent', intent(dir3)], { cwd: dir3, fetch: malformedChildFetch });
    assert.strictEqual(malformedChild.code, 2, JSON.stringify(malformedChild.out));
    assert.strictEqual(malformedChild.out.blocked[0].reason, 'dup-check-failed');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(malformedChild.out.context, 'duplicateCandidates'),
      false,
      'never surface a partial candidate set',
    );
    assert.strictEqual(malformedChild.out.nothingWritten, true);
    assert.strictEqual(actualWrites(malformedChildFetch.calls).length, 0);
  });

  await test('prepare keeps project-wide exact-title exception candidates visible without repeating parent candidates', async () => {
    const dir = project();
    const fetch = fakeFetch([
      { match: '/wit/workitems/321', json: parentWithRelations([childRelation(618)]) },
      { match: '/wit/workitems/618', json: childWorkItem(618, 'Bug', 'Payment fails at checkout', 'Active') },
      { match: '/wit/workitems/621', json: childWorkItem(621, 'Bug', 'Payment fails at checkout', 'Closed') },
      { method: 'POST', match: '/wiql', json: { workItems: [{ id: '618' }, { id: 621 }] } },
    ]);
    const result = await prepare(dir, fetch, { action: 'skip' }, { duplicate: { allow: true } });
    assert.strictEqual(result.code, 0, JSON.stringify(result.out));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.out.approval, 'duplicateCandidates'), false);
    assert.deepStrictEqual(result.out.approval.exactTitleCandidates, [
      { id: 618, type: 'Bug', title: 'Payment fails at checkout', state: 'Active' },
      { id: 621, type: 'Bug', title: 'Payment fails at checkout', state: 'Closed' },
    ]);
    assert.strictEqual(result.out.approval.duplicateReview.totalCandidates, 1);
  });

  await test('missing duplicate review blocks prepare and returns a reviewable shortlist with zero writes', async () => {
    const dir = project();
    const fetch = fakeFetch(parentBugRoutes([{
      id: 8610,
      title: 'Valid card submission returns a server error',
      state: 'Closed',
      reproductionSummary: 'Submitting a valid Visa returns HTTP 500 at checkout.',
    }]));
    const plan = planPath(dir);
    const result = await run([
      'prepare', '--intent', intent(dir), '--plan', plan,
    ], { cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z' });
    assert.strictEqual(result.code, 2, JSON.stringify(result.out));
    assert.strictEqual(result.out.blocked[0].reason, 'duplicate-review-required');
    assert.strictEqual(result.out.duplicateReview.reviewId.length, 64);
    assert.deepStrictEqual(result.out.duplicateCandidates.map((candidate) => candidate.id), [8610]);
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(result.out.nothingWritten, true);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('stale duplicate review blocks prepare and returns a fresh shortlist with zero writes', async () => {
    const dir = project();
    const baseFetch = fakeFetch([
      { match: '/wit/workitems/622', json: childWorkItem(622, 'Bug', 'Sibling added after context', 'New') },
    ]);
    let expandedParentReads = 0;
    const fetch = async (url, opts = {}) => {
      const callUrl = String(url);
      const method = opts.method || 'GET';
      if (method === 'GET' && callUrl.includes('/wit/workitems/321') && callUrl.includes('$expand=all')) {
        baseFetch.calls.push({ url: callUrl, method, body: opts.body, headers: opts.headers || {} });
        expandedParentReads++;
        const relations = expandedParentReads === 1 ? [] : [childRelation(622)];
        return { ok: true, status: 200, text: async () => JSON.stringify(parentWithRelations(relations)) };
      }
      return baseFetch(url, opts);
    };
    fetch.calls = baseFetch.calls;

    const intentFile = intent(dir);
    const context = await run(['context', '--intent', intentFile], { cwd: dir, fetch });
    assert.strictEqual(context.code, 0, JSON.stringify(context.out));
    assert.deepStrictEqual(context.out.duplicateCandidates, []);

    const plan = planPath(dir);
    const prepared = await run([
      'prepare', '--intent', intentFile,
      '--duplicate-review', context.out.duplicateReview.reviewId,
      '--plan', plan,
    ], { cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z' });
    assert.strictEqual(prepared.code, 2, JSON.stringify(prepared.out));
    assert.strictEqual(prepared.out.blocked[0].reason, 'duplicate-review-stale');
    assert.notStrictEqual(prepared.out.duplicateReview.reviewId, context.out.duplicateReview.reviewId);
    assert.deepStrictEqual(prepared.out.duplicateCandidates, [{
      id: 622, type: 'Bug', title: 'Sibling added after context', state: 'New',
    }]);
    assert.strictEqual(expandedParentReads, 2);
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(prepared.out.nothingWritten, true);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('duplicate review receipt binds ranking-relevant intent fields', async () => {
    const dir = project(); const fetch = fakeFetch();
    const intentFile = intent(dir);
    const reviewed = await review(dir, fetch, intentFile);
    assert.strictEqual(reviewed.code, 0, JSON.stringify(reviewed.out));
    const changedIntent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    changedIntent.actual = 'The payment API now returns HTTP 503 instead of HTTP 500.';
    fs.writeFileSync(intentFile, JSON.stringify(changedIntent));
    const plan = planPath(dir);
    const prepared = await run([
      'prepare', '--intent', intentFile,
      '--duplicate-review', reviewed.out.duplicateReview.reviewId,
      '--plan', plan,
    ], { cwd: dir, fetch, now: () => '2026-09-08T12:00:00.000Z' });
    assert.strictEqual(prepared.code, 2, JSON.stringify(prepared.out));
    assert.strictEqual(prepared.out.blocked[0].reason, 'duplicate-review-stale');
    assert.notStrictEqual(prepared.out.duplicateReview.reviewId, reviewed.out.duplicateReview.reviewId);
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('fresh review allows prepare without re-echoing the parent candidate payload', async () => {
    const dir = project();
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: 8500 + index,
      title: `Parent candidate payload marker ${index + 1}`,
      state: index % 3 === 0 ? 'Resolved' : 'Active',
      reproductionSummary: `Large reproduction payload marker ${index + 1}`,
    }));
    const fetch = fakeFetch(parentBugRoutes(items));
    const prepared = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    assert.strictEqual(fs.existsSync(prepared.plan), true);
    assert.strictEqual(prepared.out.approval.duplicateReview.reviewId, prepared.review.duplicateReview.reviewId);
    assert.strictEqual(prepared.out.approval.duplicateReview.totalCandidates, 30);
    assert.strictEqual(prepared.out.approval.duplicateReview.shortlistCandidateIds.length, 25);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared.out.approval, 'duplicateCandidates'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared.out.approval, 'exactTitleCandidates'), false);
    assert.strictEqual(JSON.stringify(prepared.out).includes('Parent candidate payload marker'), false);
    assert.strictEqual(JSON.stringify(prepared.out).includes('Large reproduction payload marker'), false);
    const artifact = JSON.parse(fs.readFileSync(prepared.plan, 'utf8'));
    assert.strictEqual(JSON.stringify(artifact.approval).includes('Parent candidate payload marker'), false);
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'POST' && call.url.includes('/wit/workitemsbatch')).length, 2,
      'context review and prepare each use one batch for this 30-child fixture');
    assert.strictEqual(fetch.calls.some((call) =>
      call.method === 'GET' && /\/wit\/workitems\/85\d{2}\?/.test(call.url)), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('context explicitly requests a concrete assignee when the required input is unresolved', async () => {
    const dir = project({ assignee: '' }); const fetch = fakeFetch();
    const { code, out } = await run(['context', '--parent', '321'], { cwd: dir, fetch });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.defaults.assignedTo, undefined);
    assert.deepStrictEqual(out.requiredInputs.assignedTo, {
      required: true,
      resolved: false,
      needsUserInput: true,
      choices: [],
    });
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('prepare still fails closed when a required assignee is unresolved and omitted', async () => {
    const dir = project({ assignee: '' }); const fetch = fakeFetch(); const plan = planPath(dir);
    const result = await run([
      'prepare', '--intent', intent(dir, { action: 'skip' }), '--plan', plan,
    ], { cwd: dir, fetch });
    assert.strictEqual(result.code, 2, JSON.stringify(result.out));
    assert.ok(result.out.blocked.some((block) => block.reason === 'missing-input' && block.field === 'assignedTo'));
    assert.strictEqual(fs.existsSync(plan), false);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
  });

  await test('runtime failures stay actionable without exposing Azure routes or field mechanics', async () => {
    const dir = project();
    const fetch = async () => ({ ok: false, status: 502, text: async () => 'gateway unavailable' });
    const { code, out } = await run(['context', '--parent', '321'], { cwd: dir, fetch });
    assert.strictEqual(code, 1, JSON.stringify(out));
    assert.strictEqual(out.mode, 'blocked');
    assert.strictEqual(out.nothingWritten, true);
    assert.match(out.error.message, /field metadata lookup failed \(HTTP 502\)/);
    const publicJson = JSON.stringify(out);
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch|Authorization|https:\/\/dev\.azure\.com/i.test(publicJson), publicJson);
    assert.ok(!publicJson.includes(PAT));
  });

  await test('prepare writes an integrity-checked local artifact and exposes only a semantic plan', async () => {
    const dir = project(); const fetch = fakeFetch();
    const { code, out, plan } = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.ok(fs.existsSync(plan));
    assert.strictEqual(out.approval.nothingWritten, true);
    assert.deepStrictEqual(out.approval.writePlan.map((step) => step.step),
      ['upload-evidence', 'create-bug', 'link-parent', 'set-reproduction-and-evidence']);
    assert.strictEqual(actualWrites(fetch.calls).length, 0, 'validateOnly is not a board write');
    const publicJson = JSON.stringify(out);
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch|Basic \*\*\*/i.test(publicJson), publicJson);
    const artifact = JSON.parse(fs.readFileSync(plan, 'utf8'));
    assert.strictEqual(artifact.approvalId, out.approvalId);
    assert.strictEqual(artifact.attachmentProofs[0].sha256.length, 64);
  });

  await test('skill keeps the optimized agent workflow conditional, compact, and fail-closed', async () => {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
    const collectAt = skill.indexOf('### 1. Collect semantic defect content');
    const bootstrapAt = skill.indexOf('### 2. Retrieve bootstrap context');
    const classifyAt = skill.indexOf('### 3. Recommend classification');
    const duplicatesAt = skill.indexOf('### 4. Review duplicates and complete any deferred bundled input');
    const prepareAt = skill.indexOf('### 5. Prepare the exact approval plan');
    assert.ok(collectAt >= 0 && collectAt < bootstrapAt && bootstrapAt < classifyAt &&
      classifyAt < duplicatesAt && duplicatesAt < prepareAt, 'workflow sections stay ordered');

    const discovery = skill.slice(collectAt, bootstrapAt);
    assert.match(discovery, /resolve the run\s+directory once/);
    assert.match(discovery, /smallest practical number of tool calls/);
    assert.match(discovery, /do not repeatedly list an already resolved directory/);

    const bootstrap = skill.slice(bootstrapAt, classifyAt);
    const templateAt = bootstrap.indexOf('intentTemplate');
    const structuredWriteAt = bootstrap.indexOf('direct structured');
    const closedSetAt = bootstrap.indexOf('Immediately after bootstrap context returns');
    assert.ok(templateAt >= 0 && templateAt < closedSetAt, 'the runtime scaffold precedes the closed-set check');
    assert.ok(closedSetAt < structuredWriteAt, 'the early question decision precedes intent materialization');
    assert.match(bootstrap, /file-write\/edit operation on the first attempt/);
    assert.match(bootstrap, /Do not\s+use a shell heredoc or `sed` patching as the default/);
    assert.match(bootstrap, /Preserve the scaffold's exact schema and nesting; `prepare` remains the authoritative\s+validator/);
    assert.match(bootstrap, /complete question set is closed/);
    assert.match(bootstrap, /later classification, duplicate, or evidence analysis cannot introduce another required\s+question/);
    assert.match(bootstrap, /issue the single bundled input question at this\s+point/);
    assert.match(bootstrap, /continue\s+independent intent and evidence work while waiting/);
    assert.match(bootstrap, /defer the bundle until that work closes the set/);
    assert.match(bootstrap, /Never\s+auto-decide `testCase\.action` or any other explicit user choice/);

    const duplicates = skill.slice(duplicatesAt, prepareAt);
    assert.match(duplicates, /Top-25 view is the default semantic decision surface/);
    assert.match(duplicates, /truncated list or nonzero omitted count alone is not a reason/);
    assert.match(duplicates, /never invoke `--duplicate-view all` merely "to be safe/);
    assert.match(duplicates, /`duplicateReview\.lowSignal` is `true`/);
    assert.match(duplicates, /exact-title collision/);
    assert.match(duplicates, /candidate at the shortlist boundary/);
    assert.match(duplicates, /specific ambiguity is supported by the shortlist evidence/);
    assert.match(duplicates, /Before invoking the fallback, state in the operational record which trigger fired/);
    assert.match(duplicates, /full view remains available/);
    assert.match(duplicates, /does not weaken fail-closed discovery/);
    assert.match(duplicates, /never open a\s+second round after an early bundle/);
    assert.ok(!duplicates.includes('exhaustive review is warranted'));
  });

  await test('skill presents the native approval gate after the unchanged prepared summary', async () => {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
    const prepareAt = skill.indexOf('Run `prepare` with the reviewed intent');
    const summaryAt = skill.indexOf("Render each successful result's `approval` object");
    const questionAt = skill.indexOf('invoke `AskUserQuestion` once');
    const executeAt = skill.indexOf('invoke `execute` exactly once');
    const reportAt = skill.indexOf('Report the returned ledger verbatim in substance.');
    assert.ok(prepareAt >= 0 && prepareAt < summaryAt, 'prepare precedes the approval summary');
    assert.ok(summaryAt < questionAt, 'the complete summary precedes the native approval gate');
    assert.ok(questionAt < executeAt, 'the approval gate precedes execute');
    assert.ok(executeAt < reportAt, 'execute follows approval and precedes result handling');

    const gate = skill.slice(questionAt, reportAt);
    const choices = [...gate.matchAll(/^\s+\d+\. `([^`]+)`\s*$/gm)]
      .map((match) => match[1]);
    assert.deepStrictEqual(choices, ['Execute this plan', 'Cancel — no board writes']);
    assert.match(gate, /Only a returned selection of `Execute this\s+plan` is approval/);
    assert.match(gate, /Treat `prepare\.planFile` as an opaque, authoritative value/);
    assert.match(gate, /never reconstruct, normalize, retype, relocate, or infer\s+the plan path/);
    assert.match(gate, /invoke `execute` exactly once per displayed plan/);
    assert.match(gate, /passing that exact `prepare\.planFile` value verbatim as the `--plan`\s+argument/);
    assert.match(gate, /its `approvalId` binding remains authoritative/);
    assert.match(skill, /bug-report\.js execute --plan <prepare\.planFile>/);
    assert.match(gate, /stop\s+without invoking `execute`\s+and perform zero board writes/);

    const dir = project();
    const prepared = await prepare(dir, fakeFetch(), { action: 'skip' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    const approval = structuredClone(prepared.out.approval);
    for (const evidence of approval.evidence.attach) evidence.file = '<evidence-file>';
    for (const step of approval.writePlan) {
      if (step.file) step.file = '<evidence-file>';
    }
    const approvalHash = crypto.createHash('sha256')
      .update(JSON.stringify(approval)).digest('hex');
    assert.strictEqual(approvalHash, 'f25e0cdc6826942c2d1c6b62843824d68976b3a924b44990b89022915542f867');
  });

  await test('cancelling a prepared plan leaves it unconsumed and performs no board writes', async () => {
    const dir = project(); const fetch = fakeFetch();
    const prepared = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    assert.strictEqual(prepared.out.approval.nothingWritten, true);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
    assert.strictEqual(
      fs.existsSync(path.join(dir, '.agentex', 'cache', 'bug-plan-used', prepared.out.approvalId)),
      false,
      'cancel is the absence of execute: no plan reservation or board write occurs',
    );
  });

  await test('rejected evidence cannot also be attached, and unavailable evidence cannot be waived', async () => {
    const dir1 = project(); const fetch1 = fakeFetch(); const plan1 = planPath(dir1);
    const overlap = await run([
      'prepare', '--intent', intent(dir1, { action: 'skip' }, {
        evidence: {
          attach: [path.join(dir1, 'evidence.png')],
          reject: [{ file: 'evidence.png', reason: 'does not show this defect' }],
        },
      }), '--plan', plan1,
    ], { cwd: dir1, fetch: fetch1 });
    assert.strictEqual(overlap.code, 2);
    assert.strictEqual(overlap.out.blocked[0].reason, 'evidence-conflict');
    assert.strictEqual(fs.existsSync(plan1), false);
    assert.strictEqual(actualWrites(fetch1.calls).length, 0);

    const dir2 = project(); const fetch2 = fakeFetch(); const plan2 = planPath(dir2);
    const missingFile = path.join(dir2, 'missing.png');
    const missingIntent = intent(dir2, { action: 'skip' }, {
      evidence: { attach: [missingFile], reject: [], allowInvalid: true },
    });
    const missingReview = await review(dir2, fetch2, missingIntent);
    assert.strictEqual(missingReview.code, 0, JSON.stringify(missingReview.out));
    const missing = await run([
      'prepare', '--intent', missingIntent,
      '--duplicate-review', missingReview.out.duplicateReview.reviewId,
      '--plan', plan2,
    ], { cwd: dir2, fetch: fetch2 });
    assert.strictEqual(missing.code, 2);
    assert.strictEqual(missing.out.blocked[0].reason, 'evidence-unavailable');
    assert.deepStrictEqual(missing.out.blocked[0].files[0].issues, ['not-found']);
    assert.strictEqual(fs.existsSync(plan2), false);
    assert.strictEqual(actualWrites(fetch2.calls).length, 0);
  });

  await test('explicit approval passes prepare.planFile verbatim, preserves its binding, and consumes it once', async () => {
    const dir = project(); const fetch = fakeFetch();
    const requestedPlan = path.join('prepared plans', 'Plan File [OPAQUE] v1.json');
    const prepared = await prepareIntentFile(dir, fetch, intent(dir, { action: 'skip' }), requestedPlan);
    assert.strictEqual(prepared.out.planFile, path.resolve(dir, requestedPlan));
    assert.notStrictEqual(prepared.out.planFile, prepared.plan, 'prepare output, not the requested path, is authoritative');
    assert.strictEqual(path.isAbsolute(prepared.out.planFile), true);
    const before = actualWrites(fetch.calls).length;
    // This call represents the gate returning the exact "Execute this plan" choice.
    const firstArgs = ['execute', '--plan', prepared.out.planFile];
    assert.strictEqual(firstArgs[2], prepared.out.planFile, 'execute receives the exact value returned by prepare');
    const first = await run(firstArgs, { cwd: dir, fetch, now: () => '2026-09-08T12:01:00.000Z' });
    assert.strictEqual(first.code, 0, JSON.stringify(first.out));
    assert.strictEqual(first.out.approvalId, prepared.out.approvalId);
    assert.strictEqual(first.out.created.bug.bugId, 4711);
    assert.ok(first.out.ledger.every((entry) => entry.status === 'done'));
    assert.deepStrictEqual(first.out.ledger.map((entry) => entry.step), prepared.out.approval.writePlan.map((entry) => entry.step));
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch/i.test(JSON.stringify(first.out)), JSON.stringify(first.out));
    const afterFirst = actualWrites(fetch.calls).length;
    assert.ok(afterFirst > before);
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'POST' && call.url.includes('/workitems/$Bug') &&
      !call.url.includes('validateOnly=true')).length, 1);
    const replayArgs = ['execute', '--plan', prepared.out.planFile];
    assert.strictEqual(replayArgs[2], prepared.out.planFile, 'replay does not reconstruct the authoritative path');
    const second = await run(replayArgs, { cwd: dir, fetch });
    assert.strictEqual(second.code, 2);
    assert.strictEqual(second.out.blocked[0].reason, 'plan-already-used');
    assert.strictEqual(actualWrites(fetch.calls).length, afterFirst, 'replay produced no additional write');
    assert.strictEqual(fetch.calls.filter((call) =>
      call.method === 'POST' && call.url.includes('/workitems/$Bug') &&
      !call.url.includes('validateOnly=true')).length, 1);
  });

  await test('CI blocks execution without consuming the approved plan', async () => {
    const dir = project(); const fetch = fakeFetch();
    const prepared = await prepare(dir, fetch, { action: 'skip' });
    process.env.AGENTEX_CI = '1';
    let blocked;
    try {
      blocked = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    } finally {
      delete process.env.AGENTEX_CI;
    }
    assert.strictEqual(blocked.code, 2);
    assert.strictEqual(blocked.out.blocked[0].reason, 'ci-mode');
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 0, JSON.stringify(executed.out));
  });

  await test('execute-time revalidation blocks before writes and marks the approved plan consumed', async () => {
    const dir = project();
    const baseFetch = fakeFetch([{
      match: '/wit/workitems/700',
      json: {
        id: 700,
        fields: {
          'System.WorkItemType': 'Bug', 'System.Title': 'Payment fails at checkout', 'System.State': 'Active',
          'Microsoft.VSTS.TCM.ReproSteps': '<div>The same failure appeared after approval.</div>',
        },
      },
    }]);
    let duplicateReads = 0;
    const fetch = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && String(url).includes('/wiql')) {
        duplicateReads++;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ workItems: duplicateReads === 1 ? [] : [{ id: 700 }] }),
        };
      }
      return baseFetch(url, opts);
    };
    fetch.calls = baseFetch.calls;

    const prepared = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    const blocked = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(blocked.code, 2, JSON.stringify(blocked.out));
    assert.strictEqual(blocked.out.blocked[0].reason, 'duplicate-title');
    assert.strictEqual(blocked.out.planConsumed, true);
    assert.strictEqual(blocked.out.approvalId, prepared.out.approvalId);
    assert.strictEqual(blocked.out.nothingWritten, true);
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
    const replay = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(replay.out.blocked[0].reason, 'plan-already-used');
    assert.strictEqual(replay.out.planConsumed, true);
  });

  await test('tampered plans and changed evidence block before every board write', async () => {
    const dir1 = project(); const fetch1 = fakeFetch();
    const p1 = await prepare(dir1, fetch1, { action: 'skip' });
    const artifact = JSON.parse(fs.readFileSync(p1.plan, 'utf8'));
    artifact.bugSpec.title = 'silently changed after approval';
    fs.writeFileSync(p1.plan, JSON.stringify(artifact));
    const tampered = await run(['execute', '--plan', p1.plan], { cwd: dir1, fetch: fetch1 });
    assert.strictEqual(tampered.code, 2);
    assert.strictEqual(tampered.out.blocked[0].reason, 'invalid-plan');
    assert.strictEqual(actualWrites(fetch1.calls).length, 0);

    const dir2 = project(); const fetch2 = fakeFetch();
    const p2 = await prepare(dir2, fetch2, { action: 'skip' });
    fs.appendFileSync(path.join(dir2, 'evidence.png'), Buffer.from([1]));
    const changed = await run(['execute', '--plan', p2.plan], { cwd: dir2, fetch: fetch2 });
    assert.strictEqual(changed.code, 2);
    assert.strictEqual(changed.out.blocked[0].reason, 'evidence-changed');
    assert.strictEqual(actualWrites(fetch2.calls).length, 0);

    const dir3 = project(); const fetch3 = fakeFetch();
    const missingPlan = await run(['execute', '--plan', path.join(dir3, 'does-not-exist.json')], { cwd: dir3, fetch: fetch3 });
    assert.strictEqual(missingPlan.code, 2);
    assert.strictEqual(missingPlan.out.mode, 'blocked');
    assert.strictEqual(missingPlan.out.nothingWritten, true);
    assert.strictEqual(actualWrites(fetch3.calls).length, 0);
  });

  await test('fail-existing is preflighted and receives the real created Bug id automatically', async () => {
    const dir = project(); const fetch = fakeFetch();
    const prepared = await prepare(dir, fetch, { action: 'fail-existing', testCaseId: 77 });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    assert.deepStrictEqual(prepared.out.approval.writePlan.map((entry) => entry.step), [
      'upload-evidence', 'create-bug', 'link-parent', 'set-reproduction-and-evidence',
      'create-run', 'record-failed-result', 'complete-run', 'link-tested-by',
    ]);
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 0, JSON.stringify(executed.out));
    assert.strictEqual(executed.out.ledger.length, 8);
    const resultPatch = fetch.calls.find((call) => call.method === 'PATCH' && call.url.includes('/test/Runs/88/results'));
    assert.ok(resultPatch);
    assert.match(resultPatch.body, /"associatedBugs":\[\{"id":"4711"\}\]/);
    assert.ok(!resultPatch.body.includes('{new-bug-id}'));
  });

  await test('a partial Bug failure prevents every test-case write and preserves the combined ledger', async () => {
    const dir = project();
    const fetch = fakeFetch([{
      method: 'PATCH', match: '/workitems/4711', bodyMatch: 'Hierarchy-Reverse', status: 403,
      text: JSON.stringify({ message: 'parent link denied' }),
    }]);
    const prepared = await prepare(dir, fetch, { action: 'fail-existing', testCaseId: 77 });
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 1, JSON.stringify(executed.out));
    assert.strictEqual(executed.out.created.bug.bugId, 4711);
    const testEntries = executed.out.ledger.filter((entry) => entry.scope === 'test-case');
    assert.strictEqual(testEntries.length, 4);
    assert.ok(testEntries.every((entry) => entry.status === 'not-attempted'));
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'POST' && call.url.includes('/test/runs?')).length, 0);
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'PATCH' && call.url.includes('/workitems/77')).length, 0);
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch/i.test(JSON.stringify(executed.out)), JSON.stringify(executed.out));
  });

  await test('a successful create response without a Bug id fails closed before all dependent writes', async () => {
    const dir = project();
    const fetch = fakeFetch([{ method: 'POST', match: '/workitems/$Bug', json: {} }]);
    const prepared = await prepare(dir, fetch, { action: 'fail-existing', testCaseId: 77 });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 1, JSON.stringify(executed.out));
    assert.strictEqual(executed.out.ledger.find((entry) => entry.step === 'create-bug').status, 'failed');
    assert.match(executed.out.ledger.find((entry) => entry.step === 'create-bug').reason, /no positive work-item id/);
    assert.strictEqual(executed.out.created.bug.bugId, undefined);
    assert.ok(executed.out.ledger.filter((entry) => entry.step !== 'upload-evidence' && entry.step !== 'create-bug')
      .every((entry) => entry.status === 'not-attempted'));
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'PATCH').length, 0);
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'POST' && call.url.includes('/test/runs?')).length, 0);
  });

  await test('a later test-result failure is overall failure with Bug/run ids and no retry', async () => {
    const dir = project();
    const fetch = fakeFetch([{
      method: 'PATCH', match: '/test/Runs/88/results', status: 500,
      text: JSON.stringify({ message: 'result update denied' }),
    }]);
    const prepared = await prepare(dir, fetch, { action: 'fail-existing', testCaseId: 77 });
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 1, JSON.stringify(executed.out));
    assert.strictEqual(executed.out.ok, false);
    assert.strictEqual(executed.out.created.bug.bugId, 4711);
    assert.strictEqual(executed.out.created.run.id, 88);
    const failed = executed.out.ledger.find((entry) => entry.step === 'record-failed-result');
    assert.strictEqual(failed.status, 'failed');
    assert.match(failed.reason, /result update denied/);
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'PATCH' && call.url.includes('/test/Runs/88/results')).length, 1);
    assert.strictEqual(fetch.calls.filter((call) => call.method === 'PATCH' && call.url.includes('/test/runs/88?')).length, 0);
    assert.ok(!/_apis|System\.|Microsoft\.VSTS|Custom\.|json-patch/i.test(JSON.stringify(executed.out)), JSON.stringify(executed.out));
  });

  await test('create-new validates the suite and reuses the existing testplan owner', async () => {
    const dir = project(); const fetch = fakeFetch();
    const prepared = await prepare(dir, fetch, { action: 'create-new', suiteId: 4, title: 'Checkout card failure' });
    assert.strictEqual(prepared.code, 0, JSON.stringify(prepared.out));
    assert.deepStrictEqual(prepared.out.approval.writePlan.slice(-2).map((entry) => entry.step), ['create-test-case', 'add-to-suite']);
    const executed = await run(['execute', '--plan', prepared.plan], { cwd: dir, fetch });
    assert.strictEqual(executed.code, 0, JSON.stringify(executed.out));
    assert.strictEqual(executed.out.created.testCase.testCaseId, 505);
    assert.ok(fetch.calls.some((call) => call.method === 'PATCH' && call.url.includes('/testplan/suiteentry/4')));
  });

  await test('configured template and suite failures block with compact actionable runtime data', async () => {
    const dir1 = project(); const fetch1 = fakeFetch([{
      match: '/wit/workitems/99', status: 404, text: JSON.stringify({ message: 'template missing' }),
    }]);
    const context = await run(['context'], { cwd: dir1, fetch: fetch1 });
    assert.strictEqual(context.code, 2);
    assert.strictEqual(context.out.blocked[0].reason, 'template-unavailable');
    assert.strictEqual(actualWrites(fetch1.calls).length, 0);

    const dir2 = project(); const fetch2 = fakeFetch();
    const missingSuite = await prepare(dir2, fetch2, { action: 'create-new', suiteId: 999, title: 'New TC' });
    assert.strictEqual(missingSuite.code, 2);
    assert.strictEqual(missingSuite.out.blocked[0].reason, 'test-suite-not-found');
    assert.strictEqual(missingSuite.out.blocked[0].options[0].name, 'Regression');
    assert.strictEqual(actualWrites(fetch2.calls).length, 0);

    const dir3 = project(); const fetch3 = fakeFetch([{
      match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [] },
    }]);
    const missingPoint = await prepare(dir3, fetch3, { action: 'fail-existing', testCaseId: 77 });
    assert.strictEqual(missingPoint.code, 2);
    assert.strictEqual(missingPoint.out.blocked[0].reason, 'test-case-invalid');
    assert.match(missingPoint.out.blocked[0].message, /no test point for TC 77 in plan 3/);
    assert.strictEqual(actualWrites(fetch3.calls).length, 0);
  });

  await test('duplicate candidates are retrieved and compacted for semantic judgment', async () => {
    const dir = project();
    const fetch = fakeFetch([
      { method: 'POST', match: '/wiql', json: { workItems: [{ id: 700 }] } },
      {
        match: '/wit/workitems/700',
        json: {
          id: 700,
          fields: {
            'System.WorkItemType': 'Bug', 'System.Title': 'Payment fails at checkout', 'System.State': 'Active',
            'Microsoft.VSTS.TCM.ReproSteps': '<div>Card submit returns 500 for a valid Visa.</div>',
          },
        },
      },
    ]);
    const result = await prepare(dir, fetch, { action: 'skip' });
    assert.strictEqual(result.code, 2);
    assert.strictEqual(result.out.blocked[0].reason, 'duplicate-title');
    assert.deepStrictEqual(result.out.duplicateCandidates[0], {
      id: 700, type: 'Bug', title: 'Payment fails at checkout', state: 'Active',
      reproductionSummary: 'Card submit returns 500 for a valid Visa.',
    });
    const publicJson = JSON.stringify(result.out);
    assert.ok(!/Microsoft\.VSTS|System\.|_apis/.test(publicJson), publicJson);
  });

  await test('new Test Case duplicate candidates are compacted for semantic judgment', async () => {
    const dir = project();
    const baseFetch = fakeFetch([{
      match: '/wit/workitems/701',
      json: {
        id: 701,
        fields: {
          'System.WorkItemType': 'Test Case', 'System.Title': 'Checkout card failure', 'System.State': 'Ready',
        },
        _links: { html: { href: 'https://example.test/workitems/701' } },
      },
    }]);
    let duplicateReads = 0;
    const fetch = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && String(url).includes('/wiql')) {
        duplicateReads++;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ workItems: duplicateReads === 1 ? [] : [{ id: 701 }] }),
        };
      }
      return baseFetch(url, opts);
    };
    fetch.calls = baseFetch.calls;
    const result = await prepare(dir, fetch, { action: 'create-new', suiteId: 4, title: 'Checkout card failure' });
    assert.strictEqual(result.code, 2, JSON.stringify(result.out));
    assert.strictEqual(result.out.blocked[0].reason, 'duplicate-title');
    assert.deepStrictEqual(result.out.duplicateCandidates[0], {
      id: 701, type: 'Test Case', title: 'Checkout card failure', state: 'Ready',
      url: 'https://example.test/workitems/701',
    });
    assert.strictEqual(actualWrites(fetch.calls).length, 0);
    const publicJson = JSON.stringify(result.out);
    assert.ok(!/Microsoft\.VSTS|System\.|_apis/.test(publicJson), publicJson);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
