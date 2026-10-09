'use strict';
// Shared conformance suite: the properties EVERY registered task-estimation
// strategy must have (the golden suite pins the bytes; this pins the contract).
// Run: node skills/task-estimation/scripts/strategies/conformance.test.js
//
// It iterates defaultRegistry.providers() — no hand-maintained list — and
// requires conformance/<provider>.fixture.js for each; a registered strategy
// without a fixture FAILS. Then it registers a synthetic third provider
// ('acme': an in-memory adapter + a stub strategy built only from rules.js) and
// runs it through the UNMODIFIED create-tasks.js spine and the same checks —
// a new tracker is an adapter, a strategy, and one registry line.
//
// Fixture contract (conformance/<provider>.fixture.js):
//   refs           { story, story2, nonStory, withTestingChild }
//   project(dir)   writes config/project.json and a .env with sentinel credentials
//   routes(s)      fake-fetch routes for s = 'happy' | 'non-story' (refs.story
//                  becomes a non-story item) | 'existing-children' |
//                  'children-unreadable' (refs.withTestingChild's children
//                  cannot be read) | { failWriteAt: k } (the k-th board write fails)
//   spec(refs[])   a valid spec over those story refs
//   isWrite(call)  true for a board write request
//   nonStoryReason the blocked reason this provider emits for a non-story item
// Offline: every request goes to an injected fake fetch (or the in-memory acme
// adapter). No network, ever.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../create-tasks.js');
const { REQUIRED_MEMBERS, createRegistry, defaultRegistry } = require('./index.js');
const rules = require('./rules.js');
const { resolveTracker } = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tracker', 'index.js'));

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

for (const k of Object.keys(process.env)) {
  if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
}

// Fake fetch: method + url substring (+ body substring); `respond(call, n)` sees
// the nth match of its route. Unmatched requests answer 200 '{}'. Records all.
function fakeFetch(routes) {
  const calls = []; const hits = new Map();
  const fn = async (url, opts = {}) => {
    const call = { method: opts.method || 'GET', url: String(url), body: opts.body };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method || !call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const n = (hits.get(r) || 0) + 1; hits.set(r, n);
      const resp = r.respond ? r.respond(call, n) : r;
      const status = resp.status || 200;
      const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.json ?? {});
      return { ok: status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

// One run of the spine against a fixture scenario. `fixture.inMemory(scenario)`
// (acme) supplies { adapter, calls } instead of fake routes.
async function exec(fixture, registry, scenario, argv, spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-conf-'));
  fixture.project(dir);
  const specFile = path.join(dir, 'spec.json');
  if (spec) fs.writeFileSync(specFile, JSON.stringify(spec));
  const args = argv.map((a) => (a === '{SPEC}' ? specFile : a));
  if (fixture.inMemory) {
    const { adapter, calls } = fixture.inMemory(scenario);
    const r = await run(args, { cwd: dir, registry, resolveTracker: () => adapter });
    return { ...r, calls, adapter, dir };
  }
  const f = fakeFetch(fixture.routes(scenario));
  const r = await run(args, { cwd: dir, fetch: f, registry });
  return { ...r, calls: f.calls, dir };
}

async function adapterFor(fixture, scenario) {
  if (fixture.inMemory) return fixture.inMemory(scenario).adapter;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-conf-'));
  fixture.project(dir);
  return resolveTracker(dir, { fetch: fakeFetch(fixture.routes(scenario)) });
}

const NEUTRAL_KEYS = ['id', 'type', 'title', 'state', 'url', 'raw', 'isStory', 'storyPoints'];
const strOrNull = (v) => v === null || typeof v === 'string';

// Assertions 1–7, per strategy.
async function conformance(key, strategy, fixture, registry) {
  const { refs } = fixture;
  const writes = (r) => r.calls.filter(fixture.isWrite);

  await test(`[${key}] 1. every interface member exists with the right type; provider === its registry key`, async () => {
    for (const m of REQUIRED_MEMBERS) {
      assert.strictEqual(typeof strategy[m], m === 'provider' ? 'string' : 'function', `${key}.${m}`);
    }
    assert.strictEqual(strategy.provider, key);
    assert.strictEqual(registry.get(key), strategy);
  });

  await test(`[${key}] 2. the normalized story read returns the neutral story shape`, async () => {
    const adapter = await adapterFor(fixture, 'happy');
    const ctx = await strategy.openStoriesRead(adapter, {});
    const s = await strategy.readStory(adapter, refs.story, ctx);
    assert.deepStrictEqual(Object.keys(s), NEUTRAL_KEYS);
    assert.ok(typeof s.id === 'string' || typeof s.id === 'number', `id ${s.id}`);
    assert.ok(strOrNull(s.type) && strOrNull(s.title) && strOrNull(s.state), 'type/title/state are string|null');
    assert.strictEqual(typeof s.url, 'string');
    assert.ok(s.storyPoints === null || typeof s.storyPoints === 'number', `storyPoints ${s.storyPoints}`);
    assert.strictEqual(s.isStory, true);
    const n = await strategy.readStory(adapter, refs.nonStory, ctx);
    assert.deepStrictEqual(Object.keys(n), NEUTRAL_KEYS);
    assert.strictEqual(n.isStory, false);
    const r = await exec(fixture, registry, 'happy', ['stories', '--ids', String(refs.story)]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.stories[0].id, refs.story);
  });

  await test(`[${key}] 3. a valid dry run: exit 0, a non-empty plan, ZERO write requests`, async () => {
    const r = await exec(fixture, registry, 'happy', ['--spec', '{SPEC}'], fixture.spec([refs.story, refs.story2]));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(Array.isArray(r.out.plan) && r.out.plan.length > 0);
    assert.deepStrictEqual(writes(r), []);
  });

  await test(`[${key}] 4. existing [Testing] children block without --allow-existing (ids listed); pass with it`, async () => {
    const spec = fixture.spec([refs.withTestingChild]);
    const r1 = await exec(fixture, registry, 'existing-children', ['--spec', '{SPEC}'], spec);
    assert.strictEqual(r1.code, 2, JSON.stringify(r1.out));
    const b = r1.out.blocked.find((x) => x.reason === 'existing-testing-tasks');
    assert.ok(b && b.story === refs.withTestingChild && Array.isArray(b.ids) && b.ids.length > 0, JSON.stringify(r1.out.blocked));
    const r2 = await exec(fixture, registry, 'existing-children', ['--spec', '{SPEC}', '--allow-existing'], spec);
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(writes(r1).concat(writes(r2)), []);
  });

  await test(`[${key}] 5. a children scan that cannot complete blocks (fails closed) — even with --allow-existing — zero writes`, async () => {
    const spec = fixture.spec([refs.withTestingChild]);
    for (const argv of [['--spec', '{SPEC}'], ['--spec', '{SPEC}', '--allow-existing'], ['--spec', '{SPEC}', '--allow-existing', '--execute']]) {
      const r = await exec(fixture, registry, 'children-unreadable', argv, spec);
      assert.strictEqual(r.code, 2, `${argv.join(' ')}: ${JSON.stringify(r.out)}`);
      assert.ok(r.out.blocked.some((x) => x.reason === 'children-check-failed' && x.story === refs.withTestingChild), JSON.stringify(r.out.blocked));
      assert.deepStrictEqual(writes(r), []);
    }
  });

  await test(`[${key}] 6. a non-story work item blocks with the provider's reason`, async () => {
    const r = await exec(fixture, registry, 'non-story', ['--spec', '{SPEC}'], fixture.spec([refs.story]));
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.ok(r.out.blocked.some((x) => x.reason === fixture.nonStoryReason && x.story === refs.story), JSON.stringify(r.out.blocked));
    const n = await exec(fixture, registry, 'happy', ['--spec', '{SPEC}'], fixture.spec([refs.nonStory]));
    assert.strictEqual(n.code, 2);
    assert.ok(n.out.blocked.some((x) => x.reason === fixture.nonStoryReason && x.story === refs.nonStory));
    assert.deepStrictEqual(writes(r).concat(writes(n)), []);
  });

  await test(`[${key}] 7. --execute stops at the first failure; the ledger accounts for every intended write with created ids`, async () => {
    const spec = fixture.spec([refs.story, refs.story2]);
    const plan = await exec(fixture, registry, 'happy', ['--spec', '{SPEC}'], spec);
    assert.strictEqual(plan.code, 0, JSON.stringify(plan.out));
    const done = await exec(fixture, registry, 'happy', ['--spec', '{SPEC}', '--execute'], spec);
    assert.strictEqual(done.code, 0, JSON.stringify(done.out));
    assert.strictEqual(done.out.ledger.length, plan.out.plan.length, 'one ledger entry per planned write');
    assert.ok(done.out.ledger.every((l) => l.status === 'done'));
    assert.strictEqual(writes(done).length, plan.out.plan.length);

    const r = await exec(fixture, registry, { failWriteAt: 2 }, ['--spec', '{SPEC}', '--execute'], spec);
    assert.strictEqual(r.code, 1, JSON.stringify(r.out));
    assert.strictEqual(r.out.ok, false);
    const { ledger } = r.out;
    assert.strictEqual(ledger.length, plan.out.plan.length, 'every intended write is accounted for');
    const failedAt = ledger.findIndex((l) => l.status === 'failed');
    assert.strictEqual(ledger.filter((l) => l.status === 'failed').length, 1);
    assert.strictEqual(failedAt, 1, 'the second write failed');
    assert.ok(ledger.slice(0, failedAt).every((l) => l.status === 'done' && l.id !== undefined), 'everything before it is done, with ids');
    assert.ok(ledger.slice(failedAt + 1).every((l) => l.status === 'not-attempted'), 'everything after it is not-attempted');
    const doneCreates = ledger.filter((l) => l.status === 'done' && l.step === 'create-task').map((l) => l.id);
    assert.deepStrictEqual(r.out.created.tasks.map((t) => t.id), doneCreates, 'created.tasks = the done creates');
    assert.strictEqual(writes(r).length, failedAt + 1, 'no write request follows the failing one');
  });
}

// ════ the synthetic third provider: 'acme' ══════════════════════════════════
// An in-memory adapter (no fetch at all) and a stub strategy built only from
// rules.js helpers — the minimal shape that satisfies the contract.
function acmeInMemory(scenario) {
  const failAt = scenario && typeof scenario === 'object' ? scenario.failWriteAt : null;
  const items = {
    'ACME-1': { id: 'ACME-1', type: scenario === 'non-story' ? 'Bug' : 'Story', title: 'Checkout', points: 5, children: [] },
    'ACME-2': { id: 'ACME-2', type: 'Story', title: 'Login', points: null,
      children: scenario === 'children-unreadable' ? null : [{ id: 'ACME-21', title: '[Testing] Test Execution' }, { id: 'ACME-22', title: 'Build it' }] },
    'ACME-3': { id: 'ACME-3', type: 'Story', title: 'Search', points: 2, children: [] },
    'ACME-4': { id: 'ACME-4', type: 'Bug', title: 'Crash', points: null, children: [] },
  };
  const calls = []; let writes = 0; let created = 0;
  const webUrl = (id) => `https://tracker.example/acme/${id}`;
  const write = (op, describe, execute, result) => {
    if (!execute) return { op, method: describe.method, url: describe.url, body: describe.body };
    calls.push({ op, execute: true });
    writes++;
    if (writes === failAt) throw new Error(`${op} failed: injected failure`);
    return result();
  };
  const adapter = {
    name: 'acme',
    config: { project: 'ACME', assignees: ['qa.engineer@example.com'] },
    capabilities: {},
    webUrl,
    async getStory(ref) {
      calls.push({ op: 'getStory', ref });
      const raw = items[ref];
      if (!raw) throw new Error(`getStory failed: no item ${ref}`);
      return { id: raw.id, type: raw.type, title: raw.title, state: 'Open', url: webUrl(raw.id), raw };
    },
    async listChildren(story) {
      calls.push({ op: 'listChildren', ref: story.id });
      if (!Array.isArray(story.raw.children)) throw new Error(`listChildren failed: children of ${story.id} are unreadable`);
      return story.raw.children.map((c) => ({ id: c.id, title: c.title, state: null }));
    },
    async listSprintStories() {
      calls.push({ op: 'listSprintStories' });
      return { ok: true, sprint: { id: 1, name: 'Sprint 1' }, refs: ['ACME-1', 'ACME-3'] };
    },
    async createWorkItem(type, payload, { execute = false } = {}) {
      return write('createWorkItem', { method: 'POST', url: `https://tracker.example/acme/items?type=${type}`, body: payload }, execute,
        () => { created++; const id = `ACME-${100 + created}`; return { id, url: webUrl(id) }; });
    },
    async updateWorkItem(id, payload, { execute = false } = {}) {
      return write('updateWorkItem', { method: 'PUT', url: `https://tracker.example/acme/items/${id}`, body: payload }, execute,
        () => ({ id, url: webUrl(id) }));
    },
  };
  return { adapter, calls };
}

const acme = {
  provider: 'acme',
  parseIds: (csv) => String(csv).split(',').map((s) => s.trim()).filter(Boolean),
  openStoriesRead: async () => ({}),
  async currentSprint(adapter) {
    const r = await adapter.listSprintStories({ storyType: 'Story' });
    if (!r.ok) return { stop: { code: 2, out: { ok: false, mode: 'stories', blocked: [{ reason: r.condition, message: `sprint read stopped: ${r.condition}` }] } } };
    return { refs: r.refs };
  },
  async readStory(adapter, ref) {
    const s = await adapter.getStory(ref);
    return { ...s, isStory: s.type === 'Story', storyPoints: s.raw.points ?? null };
  },
  testingChildren: async (adapter, story) => (await adapter.listChildren(story)).filter((c) => rules.isTestingTitle(c.title)),
  storyRow: (story, { ref, children, childrenError }) => ({
    id: story.id, type: story.type, title: story.title, storyPoints: story.storyPoints, url: story.url,
    ...(story.isStory ? {} : { warning: `${ref} is not a Story` }),
    existingTestingTasks: childrenError ? null : children,
  }),
  async validate(adapter, spec, args) {
    const { assignee, blocked } = rules.resolveAssignee({ spec, configured: adapter.config.assignees, configKey: 'acme.assignee' });
    blocked.push(...rules.structuralBlocks(spec, String));
    const perStory = [];
    for (const st of spec.stories) {
      const entry = { id: st.id, tasks: st.tasks.length };
      try {
        const story = await acme.readStory(adapter, st.id);
        entry.title = story.title;
        if (!story.isStory) blocked.push({ reason: 'not-a-story', story: st.id, message: `${st.id} is a "${story.type}", not a Story` });
        try {
          entry.existingTestingTasks = await acme.testingChildren(adapter, story);
          if (entry.existingTestingTasks.length && !args['allow-existing']) {
            blocked.push(rules.existingTasksBlock({ storyId: st.id, tasks: entry.existingTestingTasks, formatRef: String, taskNoun: 'task' }));
          }
        } catch (e) {
          blocked.push({ reason: 'children-check-failed', story: st.id, message: `children of ${st.id} could not be checked: ${e.message}` });
        }
      } catch (e) {
        blocked.push({ reason: 'story-not-found', story: st.id, message: `story ${st.id} could not be read: ${e.message}` });
      }
      perStory.push(entry);
    }
    return {
      blocked, validation: { assignee, perStory }, cacheInfo: null, cacheStale: false,
      createType: 'Task', parentRel: 'parent',
      fieldsFor: (entry, task) => ({ title: task.title, assignee }),
      describeCreate: (task, storyId) => `create "${task.title}" under ${storyId}`,
      // A follow-up per create, to prove the spine's follow-up path is generic.
      followUp: {
        step: 'set-estimate',
        fieldsFor: (entry, task) => ({ estimate: Number(task.estimate) }),
        plannedTarget: '<new id>',
        describe: (task) => `set the estimate on "${task.title}"`,
      },
    };
  },
};

const acmeFixture = {
  refs: { story: 'ACME-1', story2: 'ACME-3', nonStory: 'ACME-4', withTestingChild: 'ACME-2' },
  nonStoryReason: 'not-a-story',
  project(dir) { fs.writeFileSync(path.join(dir, '.env'), ''); }, // no config: resolveTracker is injected
  inMemory: acmeInMemory,
  spec: (storyRefs) => ({ assignee: 'qa.engineer@example.com', stories: storyRefs.map((id) => ({ id, tasks: [
    { title: '[Testing] Test Creation', estimate: 2 }, { title: '[Testing] Test Execution', estimate: 3 },
  ] })) }),
  isWrite: (c) => c.execute === true,
};

(async () => {
  // ── every registered strategy, from the registry itself ──────────────────
  const providers = defaultRegistry.providers();
  await test('the registry is the iteration source (ado and jira registered today)', async () => {
    assert.ok(providers.includes('ado') && providers.includes('jira'), providers.join(', '));
  });
  for (const p of providers) {
    const file = path.join(__dirname, 'conformance', `${p}.fixture.js`);
    if (!fs.existsSync(file)) {
      await test(`[${p}] has a conformance fixture`, async () => {
        throw new Error(`registered strategy '${p}' has no conformance fixture (expected ${path.relative(__dirname, file)})`);
      });
      continue;
    }
    await conformance(p, defaultRegistry.get(p), require(file), defaultRegistry);
  }

  // ── a synthetic third provider through the UNMODIFIED spine ─────────────────
  const withAcme = createRegistry({ ...Object.fromEntries(providers.map((p) => [p, defaultRegistry.get(p)])), acme });

  await test('[acme] stories --ids, --current-sprint, a dry run, and --execute run through the unmodified create-tasks.js', async () => {
    const s = await exec(acmeFixture, withAcme, 'happy', ['stories', '--ids', 'ACME-1,ACME-2']);
    assert.strictEqual(s.code, 0, JSON.stringify(s.out));
    assert.deepStrictEqual(s.out.stories.map((x) => [x.id, x.existingTestingTasks.length]), [['ACME-1', 0], ['ACME-2', 1]]);
    const c = await exec(acmeFixture, withAcme, 'happy', ['stories', '--current-sprint']);
    assert.deepStrictEqual(c.out.stories.map((x) => x.id), ['ACME-1', 'ACME-3']);
    const spec = acmeFixture.spec(['ACME-1', 'ACME-3']);
    const d = await exec(acmeFixture, withAcme, 'happy', ['--spec', '{SPEC}'], spec);
    assert.strictEqual(d.code, 0, JSON.stringify(d.out));
    assert.deepStrictEqual(d.out.plan.map((p) => p.step), ['create-task', 'set-estimate', 'create-task', 'set-estimate', 'create-task', 'set-estimate', 'create-task', 'set-estimate']);
    assert.strictEqual(d.out.plan[0].describe, 'POST https://tracker.example/acme/items?type=Task (parent -> ACME-1 inline — atomic)');
    assert.strictEqual(d.out.plan[1].request.url, 'https://tracker.example/acme/items/<new id>');
    assert.strictEqual(d.out.cache, null);
    const x = await exec(acmeFixture, withAcme, 'happy', ['--spec', '{SPEC}', '--execute'], spec);
    assert.strictEqual(x.code, 0, JSON.stringify(x.out));
    assert.deepStrictEqual(x.out.created.tasks.map((t) => [t.id, t.storyId]), [['ACME-101', 'ACME-1'], ['ACME-102', 'ACME-1'], ['ACME-103', 'ACME-3'], ['ACME-104', 'ACME-3']]);
    assert.deepStrictEqual(x.out.ledger.map((l) => l.describe).slice(0, 2), ['create "[Testing] Test Creation" under ACME-1', 'set the estimate on "[Testing] Test Creation"']);
  });

  await conformance('acme', acme, acmeFixture, withAcme);

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
