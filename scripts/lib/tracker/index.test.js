'use strict';
// Unit tests for tracker resolution (provider detection). Run: node scripts/lib/tracker/index.test.js
// Offline: fetch is injected; no provider is ever contacted here.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTracker, TrackerError } = require('./index.js');

let passed = 0; const failures = []; const queue = [];
function test(name, fn) { queue.push([name, fn]); }
async function flush() {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
  }
}

for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT']) delete process.env[n];

function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-trk-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const noFetch = async () => { throw new Error('resolution must not fetch'); };

test('an azure block resolves to the ADO adapter', () => {
  const dir = proj({ 'config/project.json': { azure: { org: 'exampleorg', project: 'Sample' } } });
  const a = resolveTracker(dir, { fetch: noFetch });
  assert.strictEqual(a.name, 'ado');
  assert.strictEqual(a.config.base, 'https://dev.azure.com/exampleorg');
});

test('legacy AZURE_* keys in .env resolve to the ADO adapter (no config/project.json)', () => {
  const dir = proj({ '.env': 'AZURE_URL=https://dev.azure.com/legacy\nAZURE_PROJECT=Old Proj\n' });
  const a = resolveTracker(dir, { fetch: noFetch });
  assert.strictEqual(a.name, 'ado');
  assert.strictEqual(a.config.project, 'Old Proj');
});

test('no tracker configured: exit-2 error naming the keys looked for (invariant 10)', () => {
  const dir = proj({ 'config/project.json': { kb: {} } });
  assert.throws(() => resolveTracker(dir, { fetch: noFetch }), (e) => {
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /azure/);
    assert.match(e.message, /config\/project\.json/);
    assert.match(e.message, /AZURE_URL/);
    assert.match(e.message, /AZURE_PROJECT/);
    return true;
  });
});

test('two provider blocks: Phase 1 fails closed, listing both (D-10)', () => {
  const dir = proj({
    'config/project.json': {
      azure: { org: 'o', project: 'p' },
      jira: { site: 'https://example.atlassian.net', project: 'PROJ' },
    },
  });
  assert.throws(() => resolveTracker(dir, { fetch: noFetch }), (e) => {
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /azure/);
    assert.match(e.message, /jira/);
    return true;
  });
});

test('a lone unsupported provider block is an explicit error, not a silent fallback', () => {
  const dir = proj({ 'config/project.json': { jira: { site: 'x', project: 'PROJ' } } });
  assert.throws(() => resolveTracker(dir, { fetch: noFetch }), (e) => {
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /jira/);
    assert.match(e.message, /not supported|Phase 3/i);
    return true;
  });
});

test('capability flags are present and a consumer can branch on a false flag (Q11)', () => {
  const dir = proj({ 'config/project.json': { azure: { org: 'o', project: 'p' } } });
  const a = resolveTracker(dir, { fetch: noFetch });
  assert.strictEqual(typeof a.capabilities, 'object');
  // A Phase-3 adapter without test plans must be representable without interface
  // changes — consumers detect the gap and trigger inform-and-ask, never a
  // silent substitute. Simulate exactly that consumer branch:
  const jiraLike = { ...a.capabilities, testPlans: false, testRuns: false, relations: { ...a.capabilities.relations, testedBy: false } };
  const gaps = [];
  if (!jiraLike.testPlans) gaps.push('test plans');
  if (!jiraLike.relations.testedBy) gaps.push('tested-by link');
  assert.deepStrictEqual(gaps, ['test plans', 'tested-by link']);
  assert.strictEqual(a.capabilities.testPlans, true, 'the real ADO flags are unchanged');
});

test('the injected fetch reaches the adapter (O6 seam)', async () => {
  const dir = proj({
    'config/project.json': { azure: { org: 'o', project: 'p' } },
    '.env': 'AZURE_PAT=x\n',
  });
  let called = 0;
  const a = resolveTracker(dir, {
    fetch: async () => { called++; return { ok: true, status: 200, text: async () => '{"id":1}' }; },
  });
  await a.getWorkItem(1);
  assert.strictEqual(called, 1);
});

test('TrackerError is re-exported for consumers', () => {
  assert.strictEqual(typeof TrackerError, 'function');
});

flush().then(() => {
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
});
