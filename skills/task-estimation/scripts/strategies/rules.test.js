'use strict';
// Tests for the shared, provider-neutral estimation rules (rules.js).
// Run: node skills/task-estimation/scripts/strategies/rules.test.js
// Each rendered message is pinned for BOTH providers' parameter sets against the
// values recorded from 319619c in ../golden/ (the inputs below are those cases'
// specs), so one shared template provably renders each provider's exact bytes.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('./rules.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const golden = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'golden', `${p}.json`), 'utf8')).out;
const ADO = { formatRef: (id) => `#${id}`, configKey: 'azure.assignee', taskNoun: 'task' };
const JIRA = { formatRef: (id) => String(id), configKey: 'jira.assignee', taskNoun: 'sub-task' };
const FIVE = [{ title: '[Testing] Requirement Review', estimate: 1 }];

(async () => {
  await test('TITLE_PREFIX and isTestingTitle: the template marker', async () => {
    assert.strictEqual(rules.TITLE_PREFIX, '[Testing] ');
    assert.strictEqual(rules.isTestingTitle('[Testing] Automation'), true);
    assert.strictEqual(rules.isTestingTitle('[Testing]Automation'), true, 'the marker, not the prefix with its space');
    for (const t of ['Testing', ' [Testing] x', '', null, undefined]) assert.strictEqual(rules.isTestingTitle(t), false, String(t));
  });

  await test('resolveAssignee: spec value (trimmed) wins; a single configured value resolves; nothing is invented', async () => {
    assert.deepStrictEqual(rules.resolveAssignee({ spec: { assignee: '  a@example.com ' }, configured: ['b@example.com', 'c@example.com'], configKey: 'x' }),
      { assignee: 'a@example.com', blocked: [] });
    assert.deepStrictEqual(rules.resolveAssignee({ spec: {}, configured: ['b@example.com'], configKey: 'x' }),
      { assignee: 'b@example.com', blocked: [] });
  });

  await test('resolveAssignee: missing-assignee renders the golden bytes on both providers (with and without options)', async () => {
    const none = (p) => rules.resolveAssignee({ spec: { assignee: '' }, configured: [], configKey: p.configKey });
    const many = (p) => rules.resolveAssignee({ spec: {}, configured: ['a@example.com', 'b@example.com'], configKey: p.configKey });
    assert.strictEqual(none(ADO).assignee, null);
    assert.deepStrictEqual(none(ADO).blocked, golden('ado/A15').blocked);
    assert.deepStrictEqual(many(ADO).blocked, golden('ado/A16').blocked);
    assert.deepStrictEqual(none(JIRA).blocked, golden('jira/J25').blocked);
    assert.deepStrictEqual(many(JIRA).blocked, golden('jira/J26').blocked);
  });

  await test('structuralBlocks: bad-task-title renders the golden bytes on both providers', async () => {
    const ado = { stories: [{ id: 101, tasks: [{ title: 'Test Creation', estimate: 1 }, { estimate: 2 }] }] };
    assert.deepStrictEqual(rules.structuralBlocks(ado, ADO.formatRef), golden('ado/A17').blocked);
    const jira = { stories: [{ id: 'PROJ-1', tasks: [{ title: 'Test Creation', estimate: 1 }, { title: null, estimate: 1 }] }] };
    assert.deepStrictEqual(rules.structuralBlocks(jira, JIRA.formatRef), golden('jira/J30').blocked);
  });

  await test('structuralBlocks: bad-estimate renders the golden bytes on both providers, every bad task at once', async () => {
    const ado = { stories: [{ id: 101, tasks: [{ title: '[Testing] A', estimate: '2h' }, { title: '[Testing] B', estimate: 0 }, { title: '[Testing] C' }] }] };
    assert.deepStrictEqual(rules.structuralBlocks(ado, ADO.formatRef), golden('ado/A18').blocked);
    const jira = { stories: [{ id: 'PROJ-1', tasks: [{ title: '[Testing] A', estimate: '2h' }, { title: '[Testing] B', estimate: 0 }, { title: '[Testing] C', estimate: null }] }] };
    assert.deepStrictEqual(rules.structuralBlocks(jira, JIRA.formatRef), golden('jira/J31').blocked);
  });

  await test('structuralBlocks: title then estimate per task, nested in spec order; a valid spec yields nothing', async () => {
    const out = rules.structuralBlocks({ stories: [{ id: 1, tasks: [{ title: 'x', estimate: -1 }] }, { id: 2, tasks: FIVE }] }, String);
    assert.deepStrictEqual(out.map((b) => b.reason), ['bad-task-title', 'bad-estimate']);
    assert.deepStrictEqual(rules.structuralBlocks({ stories: [{ id: 1, tasks: FIVE }] }, String), []);
  });

  await test('existingTasksBlock: renders the golden bytes on both providers', async () => {
    const ado = rules.existingTasksBlock({ storyId: 102, tasks: [{ id: 555, title: '[Testing] Test Execution', state: 'Active' }], formatRef: ADO.formatRef, taskNoun: ADO.taskNoun });
    assert.deepStrictEqual([ado], golden('ado/A21').blocked);
    const jira = rules.existingTasksBlock({ storyId: 'PROJ-2', tasks: [{ id: 'PROJ-55' }, { id: 'PROJ-57' }], formatRef: JIRA.formatRef, taskNoun: JIRA.taskNoun });
    assert.deepStrictEqual([jira], golden('jira/J39').blocked);
  });

  await test('rules.js is pure: no requires at all, no provider names', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'rules.js'), 'utf8');
    assert.ok(!/require\(/.test(src), 'no dependencies');
    assert.ok(!/\b(ado|jira|azure)\b/i.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no provider names in code');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
