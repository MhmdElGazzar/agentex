'use strict';
// Tests for the task-estimation strategy registry (strategies/index.js).
// Run: node skills/task-estimation/scripts/strategies/registry.test.js
// Offline. Covers: registry construction and its fail-closed lookup, and the
// structural doctrine on every strategies/*.js module (no process spawning, no
// force-exit, no npm dependencies).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_MEMBERS, createRegistry, defaultRegistry, compat } = require('./index.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const stub = (provider, omit = []) => {
  const s = { provider };
  for (const m of REQUIRED_MEMBERS) if (m !== 'provider') s[m] = async () => {};
  for (const m of omit) delete s[m];
  return s;
};
const refusal = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal'); };

(async () => {
  // ── registry construction ───────────────────────────────────────────────────
  await test('REQUIRED_MEMBERS is the interface: provider + seven operations', async () => {
    assert.deepStrictEqual(REQUIRED_MEMBERS, ['provider', 'parseIds', 'openStoriesRead', 'currentSprint',
      'readStory', 'testingChildren', 'storyRow', 'validate']);
  });

  await test('defaultRegistry registers ado and jira, each a complete strategy under its own key', async () => {
    assert.deepStrictEqual(defaultRegistry.providers(), ['ado', 'jira']);
    for (const p of defaultRegistry.providers()) {
      const s = defaultRegistry.get(p);
      assert.strictEqual(s.provider, p);
      for (const m of REQUIRED_MEMBERS.slice(1)) assert.strictEqual(typeof s[m], 'function', `${p}.${m}`);
    }
  });

  await test('createRegistry: providers() in insertion order; get() returns the registered strategy', async () => {
    const a = stub('acme'); const b = stub('zeta');
    const r = createRegistry({ zeta: b, acme: a });
    assert.deepStrictEqual(r.providers(), ['zeta', 'acme']);
    assert.strictEqual(r.get('acme'), a);
  });

  await test('get(unknown) refuses with exit 2, naming the provider and listing the providers that have one', async () => {
    const e = refusal(() => createRegistry({ ado: stub('ado') }).get('jira'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /'jira'/);
    assert.match(e.message, /providers with one: ado\./);
    assert.match(e.message, /Refusing rather than falling back/);
    assert.ok(!(e instanceof TypeError));
    const proto = refusal(() => createRegistry({}).get('toString'));
    assert.strictEqual(proto.exitCode, 2, 'inherited object keys are not strategies');
    assert.match(proto.message, /providers with one: none/);
  });

  await test('get() refuses (exit 2) a registered strategy missing a required member, naming it', async () => {
    const e = refusal(() => createRegistry({ acme: stub('acme', ['storyRow', 'validate']) }).get('acme'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /missing required member\(s\): storyRow, validate/);
    const np = refusal(() => createRegistry({ acme: stub('acme', ['provider']) }).get('acme'));
    assert.match(np.message, /missing required member\(s\): provider/);
  });

  await test('get() refuses (exit 2) a strategy whose provider differs from its registry key', async () => {
    const e = refusal(() => createRegistry({ acme: stub('zeta') }).get('acme'));
    assert.strictEqual(e.exitCode, 2);
    assert.match(e.message, /registered under 'acme' declares provider 'zeta'/);
  });

  await test('compat: the pinned exports create-tasks.js keeps', async () => {
    assert.strictEqual(compat.PARENT_LINK, 'System.LinkTypes.Hierarchy-Reverse');
    assert.ok(compat.currentIterationWiql('P', 'T').includes("@CurrentIteration('[P]\\T')"));
    assert.strictEqual(compat.currentSprintJql('PROJ', 'Story'), 'project = "PROJ" AND issuetype = "Story" AND sprint in openSprints() ORDER BY key');
  });

  // ── structural doctrine on every strategy module ────────────────────────────
  const modules = fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'));
  await test('every strategies/*.js module: no child_process/spawn, no process.exit(, only node: or relative requires', async () => {
    assert.ok(modules.length >= 4, modules.join(', '));
    for (const n of modules) {
      const src = fs.readFileSync(path.join(__dirname, n), 'utf8');
      assert.ok(!/child_process|spawnSync|execSync|\bspawn\(/.test(src), `${n} must not spawn processes`);
      assert.ok(!src.includes('process.exit('), `${n} must not force-exit`);
      for (const m of src.matchAll(/require\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        // node: builtins, sibling modules, or the repo's tracker lib (path.join(LIB, …)) — never a package.
        assert.ok(/^'node:/.test(arg) || /^'\.\.?\//.test(arg) || /^path\.join\((LIB|__dirname)\b/.test(arg),
          `${n}: require(${arg}) is not a node: builtin or a repo-relative path`);
      }
    }
  });

  // ── fail-closed through the spine (create-tasks.js run) ─────────────────────
  const os = require('node:os');
  const { run } = require('../create-tasks.js');
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
  }
  const project = (config, env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-reg-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, '.env'), env);
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
      assignee: 'qa.engineer@example.com',
      stories: [{ id: 'PROJ-1', tasks: [{ title: '[Testing] Requirement Review', estimate: 1 }] }],
    }));
    return dir;
  };
  const jiraProject = () => project({ jira: { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com' } },
    'JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=SENTINEL-reg-token\n');
  const adoProject = () => project({ azure: { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com' } },
    'AZURE_PAT=SENTINEL-reg-pat\n');
  const recordingFetch = () => {
    const calls = [];
    const fn = async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method || 'GET' }); return { ok: true, status: 200, text: async () => '{}' }; };
    fn.calls = calls;
    return fn;
  };
  const RUNS = [['stories', '--current-sprint'], ['stories', '--ids', 'PROJ-1'], ['--spec', '{SPEC}'], ['--spec', '{SPEC}', '--execute']];
  const runWith = async (dir, argv, registry, extra = {}) => {
    const f = recordingFetch();
    const r = await run(argv.map((a) => a.replace('{SPEC}', path.join(dir, 'spec.json'))), { cwd: dir, fetch: f, registry, ...extra });
    return { ...r, calls: f.calls };
  };

  await test('FAIL-CLOSED: a Jira project with an ADO-only registry -> exit 2 naming jira, listing ado, ZERO requests (stories and --spec)', async () => {
    const dir = jiraProject();
    const ado = defaultRegistry.get('ado');
    for (const argv of RUNS) {
      const { code, out, calls } = await runWith(dir, argv, createRegistry({ ado }));
      assert.strictEqual(code, 2, `${argv.join(' ')}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.ok, false);
      assert.match(out.error.message, /provider 'jira'/);
      assert.match(out.error.message, /providers with one: ado\./);
      assert.strictEqual(calls.length, 0, `${argv.join(' ')}: nothing may be read — ${JSON.stringify(calls)}`);
    }
  });

  await test('FAIL-CLOSED (mirror): an ADO project with a Jira-only registry -> exit 2, ZERO requests', async () => {
    const dir = adoProject();
    const jira = defaultRegistry.get('jira');
    for (const argv of RUNS) {
      const { code, out, calls } = await runWith(dir, argv, createRegistry({ jira }));
      assert.strictEqual(code, 2, JSON.stringify(out));
      assert.match(out.error.message, /provider 'ado'/);
      assert.match(out.error.message, /providers with one: jira\./);
      assert.strictEqual(calls.length, 0);
    }
  });

  await test('FAIL-CLOSED: an incomplete or mis-keyed strategy is refused by run (exit 2, zero requests)', async () => {
    const dir = adoProject();
    const r1 = await runWith(dir, ['--spec', '{SPEC}'], createRegistry({ ado: { ...defaultRegistry.get('ado'), validate: undefined } }));
    assert.strictEqual(r1.code, 2);
    assert.match(r1.out.error.message, /missing required member\(s\): validate/);
    assert.strictEqual(r1.calls.length, 0);
    const r2 = await runWith(dir, ['stories', '--current-sprint'], createRegistry({ ado: defaultRegistry.get('jira') }));
    assert.strictEqual(r2.code, 2);
    assert.match(r2.out.error.message, /declares provider 'jira'/);
    assert.strictEqual(r2.calls.length, 0);
  });

  await test('NO DEFAULTS: a validation missing a provider value fails the run (exit 1) before any write', async () => {
    const dir = adoProject();
    const writes = [];
    const adapter = {
      name: 'acme', config: {}, capabilities: {},
      createWorkItem: async (...a) => { writes.push(a); return { method: 'POST', url: 'x' }; },
      updateWorkItem: async (...a) => { writes.push(a); return { method: 'PUT', url: 'x' }; },
    };
    const acme = stub('acme');
    acme.validate = async () => ({
      blocked: [], validation: { perStory: [{ id: 1 }] }, cacheInfo: null, cacheStale: false,
      fieldsFor: () => ({}), describeCreate: () => 'x', followUp: null, // createType and parentRel omitted
    });
    for (const argv of [['--spec', '{SPEC}'], ['--spec', '{SPEC}', '--execute']]) {
      const { code, out } = await runWith(dir, argv, createRegistry({ acme }), { resolveTracker: () => adapter });
      assert.strictEqual(code, 1, JSON.stringify(out));
      assert.match(out.error.message, /missing: createType, parentRel/);
    }
    assert.strictEqual(writes.length, 0, 'never a default create type / relation, never a write');
  });

  // ── structural decoupling of the spine (source read) ────────────────────────
  await test('create-tasks.js holds no provider dispatch, provider literal, or provider dialect', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'create-tasks.js'), 'utf8');
    assert.ok(!/adapter\.name\s*[!=]==/.test(src), 'no adapter.name comparison');
    for (const lit of ["'jira'", "'ado'", "'azure'", '"jira"', '"ado"', '"azure"']) assert.ok(!src.includes(lit), `no ${lit} literal`);
    for (const tok of ['System.', 'Microsoft.VSTS.', '@CurrentIteration', 'openSprints', 'SELECT ', "'User Story'", 'timetracking', 'accountId', 'subtasks']) {
      assert.ok(!src.includes(tok), `no ${tok}`);
    }
    for (const m of src.matchAll(/require\(([^)]*)\)/g)) {
      assert.ok(!/adapters/.test(m[1]), `no require of an adapter module: ${m[1]}`);
      assert.ok(!/cache\.js/.test(m[1]), `no require of the field cache: ${m[1]}`);
    }
    assert.ok(!/child_process|spawnSync|execSync/.test(src) && !src.includes('process.exit('), 'exit-drain doctrine');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
