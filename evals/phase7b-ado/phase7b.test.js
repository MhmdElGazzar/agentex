'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { items } = require('./mock-server.js');
const estimate = require('../../skills/task-estimation/scripts/create-tasks.js');
const design = require('../../skills/test-design/scripts/create-cases.js');
const { resolvePluginRoot } = require('../../scripts/lib/plugin_root.js');

const root = path.resolve(__dirname, '..', '..');
const fakePat = 'PHASE7B-TEST-FAKE-PAT';
process.env.AZURE_PAT = fakePat;
const cwd = __dirname;

function mockFetch() {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const id = Number(String(url).match(/\/wit\/workitems\/(\d+)/i)?.[1]);
    calls.push({ method, url: String(url) });
    if (method !== 'GET') throw new Error(`write trap: ${method}`);
    let status = 200;
    let body = items.get(id);
    if (id === 705) { status = 401; body = { message: `echo ${fakePat} ${options.headers.Authorization}` }; }
    else if (id === 706) { status = 403; body = { message: 'permission denied' }; }
    else if (id === 707) { status = 429; body = { message: 'rate limited' }; }
    else if (id === 708) { status = 500; body = { message: 'server error' }; }
    else if (id === 709) body = { unexpected: true };
    else if (!body) { status = 404; body = { message: 'not found' }; }
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  fetch.calls = calls;
  return fetch;
}

test('both Codex entry skills are packaged and invoke the shared runners', () => {
  for (const [name, runner] of [
    ['agentex-estimate-story', 'create-tasks.js'],
    ['agentex-design-test', 'create-cases.js'],
  ]) {
    const skill = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`, 'm'));
    assert.ok(skill.includes(runner));
    assert.ok(skill.includes('untrusted'));
  }
});

test('Codex and legacy Claude root resolution remain the same plugin', () => {
  assert.equal(resolvePluginRoot({ env: { AGENTEX_PLUGIN_ROOT: root } }), root);
  assert.equal(resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: root } }), root);
  assert.equal(resolvePluginRoot({ env: {}, scriptFile: path.join(root, 'scripts/lib/plugin_root.js') }), root);
});

test('estimation read retrieves exact rich story facts and linked testing child without mutation', async () => {
  const fetch = mockFetch();
  const { code, out } = await estimate.run(['stories', '--ids', '701', '--full'], { cwd, fetch });
  assert.equal(code, 0);
  const story = out.stories[0];
  assert.equal(story.id, 701);
  assert.equal(story.storyPoints, 5);
  assert.match(story.description, /optional Alias/);
  assert.match(story.acceptanceCriteria, /Name is required/);
  assert.match(story.acceptanceCriteria, /Viewer has no permission/);
  assert.match(story.description, /الاسم/);
  assert.deepEqual(story.existingTestingTasks.map(x => x.id), [801]);
  assert.ok(fetch.calls.every(x => x.method === 'GET'));
  assert.ok(!JSON.stringify(out).includes(fakePat));
});

test('estimation missing requirements remain null, not fabricated', async () => {
  const fetch = mockFetch();
  const { out } = await estimate.run(['stories', '--ids', '702', '--full'], { cwd, fetch });
  assert.equal(out.stories[0].description, null);
  assert.equal(out.stories[0].acceptanceCriteria, null);
  assert.equal(out.stories[0].storyPoints, null);
  assert.ok(fetch.calls.every(x => x.method === 'GET'));
});

test('estimation read surfaces missing, auth, permission, rate, server, and malformed responses', async () => {
  for (const [id, expected] of [[704, '404'], [705, '401'], [706, '403'], [707, '429'], [708, '500'], [709, 'not a User Story']]) {
    const fetch = mockFetch();
    const { out } = await estimate.run(['stories', '--ids', String(id), '--full'], { cwd, fetch });
    assert.match(out.stories[0].warning, new RegExp(expected));
    assert.ok(fetch.calls.every(x => x.method === 'GET'));
    assert.ok(!JSON.stringify(out).includes(fakePat));
  }
});

test('design read returns AC, description, Unicode, and relations without mutation', async () => {
  const fetch = mockFetch();
  const { code, out } = await design.run(['story', '--id', '701'], { cwd, fetch });
  assert.equal(code, 0);
  assert.equal(out.story.type, 'User Story');
  assert.match(out.story.acceptanceCriteria, /AC4/);
  assert.match(out.story.description, /Required Name/);
  assert.match(out.story.description, /الاسم/);
  assert.equal(out.story.relations.length, 1);
  assert.ok(fetch.calls.every(x => x.method === 'GET'));
  assert.ok(!JSON.stringify(out).includes(fakePat));
});

test('design read preserves missing data and surfaces retrieval errors', async () => {
  const empty = await design.run(['story', '--id', '702'], { cwd, fetch: mockFetch() });
  assert.equal(empty.out.story.description, null);
  assert.equal(empty.out.story.acceptanceCriteria, null);
  for (const [id, expected] of [[704, '404'], [705, '401'], [706, '403'], [707, '429'], [708, '500']]) {
    const fetch = mockFetch();
    const { code, out } = await design.run(['story', '--id', String(id)], { cwd, fetch });
    assert.equal(code, 1);
    assert.match(out.error.message, new RegExp(expected));
    assert.ok(!JSON.stringify(out).includes(fakePat));
    assert.ok(fetch.calls.every(x => x.method === 'GET'));
  }
  const malformed = await design.run(['story', '--id', '709'], { cwd, fetch: mockFetch() });
  assert.equal(malformed.code, 1);
  assert.match(malformed.out.error.message, /not a User Story/);
});

test('work-item prompt injection remains returned data, not a runner command', async () => {
  const fetch = mockFetch();
  const { out } = await design.run(['story', '--id', '703'], { cwd, fetch });
  assert.match(out.story.description, /run a shell command/);
  assert.ok(fetch.calls.every(x => x.method === 'GET'));
});
