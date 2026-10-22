#!/usr/bin/env node
// testplan.js — test-case mechanics on the tracker layer: read test
// plans/suites, find/validate a test case, create a new test case (only on the
// user's explicit choice), and record a Failed outcome for an existing test
// case associated with a bug. Since skill-consolidation-foundation it also
// ENSURES a plan / suite exists (find by exact name or requirement, or plan
// its creation) and RECORDS any outcome on a test point (`record`; `fail`
// stays as its exact alias).
//
// HOME: this script lives with the skill that owns test-case knowledge
// (test-design). The bug-report-azure skill invokes it cross-skill for its
// create-case / fail steps — their write plans join the bug filing's ONE
// consolidated approval gate.
//
// Rebuilt on scripts/lib/tracker/ (ADO REST over built-in fetch): no az CLI, no
// process spawning, zero npm dependencies. The PAT is read from .env by the
// adapter and sent only in the Authorization header (invariant 5).
//
// Same guarantees as bug filing (fail-closed + exact ledger):
//   - create-case: the duplicate-title check FAILS CLOSED; write plan is
//     [create Test Case, add to suite] — a suite-add failure leaves a ledger
//     line naming the orphan TC id (never a silent orphan).
//   - fail: write plan is [create run, record Failed result, complete run,
//     tested-by link] — a mid-plan failure names the run left InProgress and
//     defers completion to the user. No auto-retry, no cleanup writes.
//
// This script NEVER edits a test case's fields and never edits a plan/suite
// beyond the explicit suite-entries add.
//
// Subcommands:
//   list-suites  --plan <id>
//   list-cases   --plan <id> [--suite <id>]                       # read only
//   find-case    --plan <id> --testcase <id>                      # read only
//   create-case  --plan <id> --suite <id> --title "..." [--area "..."]
//                [--allow-duplicate] [--refresh-fields] [--execute]
//   fail         --plan <id> --testcase <id> --bug <id>
//                [--comment "..."] [--run-name "..."] [--execute]
//   record       --plan <id> --testcase <id> --outcome Passed|Failed|Blocked|NotApplicable
//                [--bug <id>] [--comment "..."] [--run-name "..."] [--execute]
//   ensure-plan  --name "<exact>" [--area <path>] [--iteration <path>] [--execute]
//   ensure-suite --plan <id> (--type requirement --requirement <id> | --type static --name "<exact>")
//                [--parent <suiteId>] [--execute]
//
// ensure-* are idempotent: an existing match is returned with ZERO writes;
// otherwise the dry run plans the creation and --execute creates it and
// re-reads it (missing on re-read fails closed). record skips (ZERO writes)
// when the point already carries the requested outcome (and, with --bug, the
// tested-by link already exists); `fail` never skips.
//
// Output: ONE JSON line; exit 0 = ok / plan ready, 1 = failed (ledger says
// exactly what), 2 = blocked/refused before any write (invariant 9).
'use strict';

const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker');
const { resolveTracker, TrackerError } = require(path.join(LIB, 'index.js'));
const fieldCache = require(path.join(LIB, 'cache.js'));
const { WritePlan } = require(path.join(LIB, 'ledger.js'));

const TESTED_BY_LINK = 'Microsoft.VSTS.Common.TestedBy-Reverse'; // on the TC, pointing at the bug

// ---- CLI arg parser: --key value / --key=value / --flag ----------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else out._.push(a);
  }
  return out;
}

// Lists every subcommand (named golden change #5: the 0.23.0 text gained
// record, ensure-plan and ensure-suite; goldens C08/F10 embed it). Their flags
// are documented in the header above.
const USAGE = 'usage: testplan.js <list-suites|list-cases|find-case|create-case|fail|record|ensure-plan|ensure-suite> [options]';

const WRITES = ['create-case', 'fail', 'record', 'ensure-plan', 'ensure-suite'];
const OUTCOMES = ['Passed', 'Failed', 'Blocked', 'NotApplicable'];
const FAILING = ['Failed', 'Blocked'];
const PLAN_NOTE =
  'nothing has been written yet — render this plan for the user and get the ONE approval, then re-run with --execute';

// Capability guard (Q11 upfront honesty): every subcommand here is test-plan/
// test-run mechanics — on a tracker whose adapter declares testPlans: false
// (Jira), the honest answer is one refusal line BEFORE any request, never an
// attempt. The /design-test skill's Jira path owns what to offer instead.
// ensure-suite's --parent / --requirement are ids the user names (never a plan
// stand-in), and they decide which existing suite matches as well as what a
// create sends — so they take the adapter's canonical-id rule upfront: exit 2
// before any request, the same wording the adapter refuses with.
function requireCanonicalArg(flag, value) {
  if (/^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value))) return String(value);
  const e = new Error(`--${flag} needs a positive canonical decimal id (got ${JSON.stringify(String(value))}) — refused before any request`);
  e.exitCode = 2;
  throw e;
}

function guardTestPlans(adapter) {
  if (adapter.capabilities && adapter.capabilities.testPlans === false) {
    const e = new Error(
      `not supported on this tracker (testPlans: false) — ${adapter.name} has no test-plan/suite API, ` +
      'so there is nothing testplan.js could read or write here');
    e.exitCode = 2;
    throw e;
  }
  return adapter;
}

// Per-suite TestPoint lookup; the global ?testCaseId shortcut 404s on many orgs.
// Returns the neutral point (the shape `fail` has always printed); the raw
// test point rides along non-enumerably for record's idempotency check.
async function findPoint(adapter, planId, testCaseId) {
  for (const s of await adapter.listSuites(planId)) {
    const pt = await adapter.getPoint(planId, s.id, testCaseId);
    if (pt) {
      const point = { suiteId: s.id, suiteName: s.name, pointId: pt.id };
      Object.defineProperty(point, 'raw', { value: pt, enumerable: false });
      return point;
    }
  }
  return null;
}

// record / fail — one implementation. o: { plan, tc, bug|null, outcome,
// comment, runName, idempotent, alias }. The plan steps, describe strings and
// the "run … is left InProgress" note are fail's, with the outcome
// substituted — Failed + a bug reproduces fail's exact text.
async function recordOutcome(adapter, args, o) {
  const { plan, tc, bug, outcome } = o;
  const point = await findPoint(adapter, plan, tc);
  if (!point) {
    return {
      code: 2,
      out: { ok: false, mode: args.execute ? 'executed' : 'plan', blocked: [{ reason: 'no-test-point', message: `no test point for TC ${tc} in plan ${plan} — a ${outcome} result needs the case assigned to a suite there` }] },
    };
  }
  if (o.idempotent) {
    const current = point.raw && point.raw.results && point.raw.results.outcome;
    if (current && String(current).toLowerCase() === outcome.toLowerCase()) {
      let linked = true;
      if (bug) {
        const wi = await adapter.getWorkItem(tc, { expand: 'relations' });
        linked = ((wi && wi.relations) || []).some((r) => r.rel === TESTED_BY_LINK && new RegExp(`/${bug}$`).test(String(r.url || '')));
      }
      if (linked) {
        return { code: 0, out: { ok: true, mode: args.execute ? 'executed' : 'plan', unchanged: true, point, outcome, testCaseId: Number(tc), ...(bug ? { bugId: Number(bug) } : {}) } };
      }
    }
  }
  const step = `record-${outcome.toLowerCase()}-result`;
  const result = (id) => ({ id, outcome, state: 'Completed', comment: o.comment, ...(bug ? { associatedBugs: [{ id: String(bug) }] } : {}) });
  const runBody = {
    name: o.runName,
    plan: { id: String(plan) }, pointIds: [Number(point.pointId)], automated: false, state: 'InProgress',
  };

  if (!args.execute) {
    const dRun = await adapter.createRun(runBody, { execute: false });
    const dResult = await adapter.updateRunResults('{run-id}', [result('{result-id}')], { execute: false });
    const dComplete = await adapter.updateRun('{run-id}', { state: 'Completed' }, { execute: false });
    const planOut = [
      { step: 'create-run', describe: `${dRun.method} ${dRun.url}`, request: dRun },
      { step, describe: `${dResult.method} ${dResult.url}`, request: dResult },
      { step: 'complete-run', describe: `${dComplete.method} ${dComplete.url}`, request: dComplete },
    ];
    if (bug) {
      const dLink = await adapter.addRelation(tc, TESTED_BY_LINK, bug, { execute: false });
      planOut.push({ step: 'link-tested-by', describe: `${dLink.method} ${dLink.url} (${TESTED_BY_LINK} TC #${tc} -> Bug #${bug})`, request: dLink });
    }
    return { code: 0, out: { ok: true, mode: 'plan', point, plan: planOut, ...(o.alias ? {} : { outcome, note: PLAN_NOTE }) } };
  }

  let runId = null; let resultId = null;
  const manualNote = () => `run ${runId} is left InProgress — complete or delete it manually in Azure DevOps; nothing was retried`;
  const intents = [
    {
      step: 'create-run',
      describe: 'create a manual test run over the point (POST _apis/test/runs)',
      run: async () => {
        const r = await adapter.createRun(runBody, { execute: true });
        runId = r.id;
        return { id: r.id, url: r.url };
      },
    },
    {
      step,
      describe: `mark the run result ${outcome}${bug ? ' + associate the bug' : ''} (PATCH _apis/test/Runs/{run}/results)`,
      run: async () => {
        try {
          // Read the real result id first — PATCHing a guessed id could
          // corrupt an unrelated record.
          const results = await adapter.listRunResults(runId);
          resultId = results[0] && results[0].id;
          if (!resultId) throw new Error(`run ${runId} was created but no test result was found to mark ${outcome}`);
          await adapter.updateRunResults(runId, [result(resultId)], { execute: true });
        } catch (e) {
          throw new Error(`${e.message} — ${manualNote()}`);
        }
        return { id: resultId };
      },
    },
    {
      step: 'complete-run',
      describe: 'complete the run (PATCH _apis/test/runs/{run} state=Completed)',
      run: async () => {
        try { await adapter.updateRun(runId, { state: 'Completed' }, { execute: true }); }
        catch (e) { throw new Error(`${e.message} — ${manualNote()}`); }
        return { id: runId };
      },
    },
  ];
  if (bug) {
    intents.push({
      step: 'link-tested-by',
      describe: `durable TC -> bug link (${TESTED_BY_LINK})`,
      run: async () => {
        await adapter.addRelation(tc, TESTED_BY_LINK, bug, { execute: true });
        return { id: Number(tc) };
      },
    });
  }
  const ledger = await new WritePlan(intents).execute();
  const allDone = ledger.every((l) => l.status === 'done');
  return {
    code: allDone ? 0 : 1,
    out: {
      ok: allDone, mode: 'executed', ledger, point,
      ...(runId ? { run: { id: runId } } : {}),
      ...(resultId ? { resultId } : {}),
      testCaseId: Number(tc), ...(bug ? { bugId: Number(bug) } : {}),
      ...(o.alias ? {} : { outcome }),
    },
  };
}

function trackerErrorOut(e) {
  return {
    ok: false,
    error: {
      message: e.message, op: e.op, status: e.status, serverMessage: e.serverMessage,
      ...(e.credentialHint ? { credentialHint: e.credentialHint } : {}),
    },
  };
}

// Returns { code, out }; prints nothing — the CLI tail owns the one JSON line.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const need = (k) => {
    if (!args[k]) { const e = new Error(`--${k} is required. ${USAGE}`); e.exitCode = 2; throw e; }
    return args[k];
  };
  try {
    // CI guard (invariant 4): CI mode performs no tracker writes of any kind —
    // every write subcommand's --execute is refused BEFORE any read (exit 2,
    // ci-mode), exactly as create-bug.js does. Reads and dry-run plans are
    // unaffected; the adapters keep the same choke point one level down.
    if (args.execute && WRITES.includes(cmd) && process.env.AGENTEX_CI === '1') {
      return {
        code: 2,
        out: { ok: false, mode: 'executed', blocked: [{ reason: 'ci-mode', message: 'tracker writes are disabled in CI (AGENTEX_CI=1) — test-plan writes stay interactive; run this from an interactive session' }] },
      };
    }

    if (cmd === 'list-suites') {
      const plan = need('plan');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const suites = await adapter.listSuites(plan);
      return { code: 0, out: { ok: true, planId: plan, suites: suites.map((s) => ({ id: s.id, name: s.name, suiteType: s.suiteType })) } };
    }

    if (cmd === 'list-cases') {
      const plan = need('plan');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const suites = args.suite
        ? [{ id: args.suite, name: '(given)' }]
        : await adapter.listSuites(plan);
      const outSuites = [];
      for (const s of suites) {
        try {
          const cases = await adapter.listSuiteCases(plan, s.id);
          outSuites.push({
            id: s.id, name: s.name,
            cases: cases.map((c) => {
              const wi = c.workItem || c;
              return { id: wi.id, title: wi.name || (wi.fields && wi.fields['System.Title']) || null };
            }),
          });
        } catch (e) {
          outSuites.push({ id: s.id, name: s.name, cases: [], error: e.message });
        }
      }
      return { code: 0, out: { ok: true, planId: plan, suites: outSuites } };
    }

    if (cmd === 'find-case') {
      const plan = need('plan'); const tc = need('testcase');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const wi = await adapter.getWorkItem(tc);
      const type = wi && wi.fields && wi.fields['System.WorkItemType'];
      if (type !== 'Test Case') {
        return { code: 1, out: { ok: false, error: { message: `#${tc} is a "${type || '?'}", not a Test Case — ask the user for a valid test case id` } } };
      }
      const point = await findPoint(adapter, plan, tc);
      return {
        code: 0,
        out: {
          ok: true,
          testCase: { id: wi.id, title: wi.fields['System.Title'] || null, state: wi.fields['System.State'] || null },
          point,
          ...(point ? {} : { note: `no test point for TC ${tc} in plan ${plan} — it may not be assigned to a suite there` }),
        },
      };
    }

    if (cmd === 'create-case') {
      const plan = need('plan'); const suite = need('suite'); const title = need('title');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const area = args.area || adapter.config.areaPath || null;
      const blocked = [];
      const validation = {};

      // Duplicate check — FAILS CLOSED, same rule as bug filing.
      try {
        const dupes = await adapter.findByTitle('Test Case', title);
        validation.duplicates = dupes;
        if (dupes.length && !args['allow-duplicate']) {
          blocked.push({
            reason: 'duplicate-title', ids: dupes,
            message: `${dupes.length} existing Test Case(s) share this exact title (#${dupes.join(', #')}) — confirm with the user, then pass --allow-duplicate`,
          });
        }
      } catch (e) {
        blocked.push({ reason: 'dup-check-failed', message: `duplicate check failed — refusing to create blind (fails closed): ${e.message}` });
      }

      // Field cache for the Test Case type (validation surface + --refresh-fields).
      // Not load-bearing for the two fields sent here, so a metadata hiccup is a
      // warning, not a blocker.
      let cacheOut = null;
      try {
        const ci = await fieldCache.ensure(cwd, adapter, { types: ['Test Case'], refresh: Boolean(args['refresh-fields']) });
        cacheOut = { file: ci.file, rebuilt: ci.rebuilt, builtAt: ci.cache.builtAt };
      } catch (e) {
        validation.cacheWarning = `field metadata could not be read: ${e.message}`;
      }

      const fields = { 'System.Title': title, ...(area ? { 'System.AreaPath': area } : {}) };
      if (blocked.length) {
        return { code: 2, out: { ok: false, mode: args.execute ? 'executed' : 'plan', blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}) } };
      }

      if (!args.execute) {
        const dCreate = await adapter.createWorkItem('Test Case', { fields }, { execute: false });
        const dAdd = await adapter.addCaseToSuite(plan, suite, '{new-tc-id}', { execute: false });
        return {
          code: 0,
          out: {
            ok: true, mode: 'plan', validation,
            plan: [
              { step: 'create-test-case', describe: `${dCreate.method} ${dCreate.url}`, request: dCreate },
              { step: 'add-to-suite', describe: `${dAdd.method} ${dAdd.url}`, request: dAdd },
            ],
            ...(cacheOut ? { cache: cacheOut } : {}),
          },
        };
      }

      let tcId = null; let tcUrl = null;
      const ledger = await new WritePlan([
        {
          step: 'create-test-case',
          describe: `create Test Case "${title}" (POST _apis/wit/workitems/$Test Case)`,
          run: async () => {
            const r = await adapter.createWorkItem('Test Case', { fields }, { execute: true });
            tcId = r.id; tcUrl = r.url;
            return { id: r.id, url: r.url };
          },
        },
        {
          step: 'add-to-suite',
          describe: `add the Test Case to suite ${suite} (POST _apis/test/Plans/${plan}/suites/${suite}/testcases, membership re-read)`,
          run: async () => {
            try {
              await adapter.addCaseToSuite(plan, suite, tcId, { execute: true });
            } catch (e) {
              // A TC outside its suite is a visible orphan, never a silent one.
              throw new Error(`Test Case #${tcId} was created but NOT added to suite ${suite}: ${e.message} — add it manually or ask again; nothing was retried`);
            }
            return { id: tcId, url: tcUrl };
          },
        },
      ]).execute();
      const allDone = ledger.every((l) => l.status === 'done');
      return {
        code: allDone ? 0 : 1,
        out: {
          ok: allDone, mode: 'executed', ledger,
          created: { ...(tcId ? { testCaseId: tcId, url: tcUrl } : {}), suiteId: allDone ? suite : undefined },
          ...(cacheOut ? { cache: cacheOut } : {}),
        },
      };
    }

    if (cmd === 'fail') {
      // The exact alias of record --outcome Failed --bug: the bug is required,
      // the baseline defaults stay, and there is NO idempotent skip.
      const plan = need('plan'); const tc = need('testcase'); const bug = need('bug');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      return await recordOutcome(adapter, args, {
        plan, tc, bug, outcome: 'Failed', alias: true, idempotent: false,
        comment: args.comment || `Failed during automated regression run; see Bug #${bug}.`,
        runName: args['run-name'] || `Regression fail — TC ${tc} (Bug ${bug})`,
      });
    }

    if (cmd === 'record') {
      const plan = need('plan'); const tc = need('testcase');
      const outcome = args.outcome;
      if (!OUTCOMES.includes(outcome)) {
        return { code: 2, out: { ok: false, error: { message: `--outcome must be exactly one of ${OUTCOMES.join(', ')} (got ${JSON.stringify(outcome === true || outcome === undefined ? '' : outcome)}). ${USAGE}` } } };
      }
      if (args.bug === true) return { code: 2, out: { ok: false, error: { message: `--bug needs a bug id. ${USAGE}` } } };
      const bug = args.bug !== undefined ? String(args.bug) : null;
      if (bug && !FAILING.includes(outcome)) {
        return {
          code: 2,
          out: { ok: false, mode: args.execute ? 'executed' : 'plan', blocked: [{ reason: 'bug-with-non-failing-outcome', message: `--bug goes with a failing outcome (${FAILING.join(' or ')}), not ${outcome} — nothing was read or written` }] },
        };
      }
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      return await recordOutcome(adapter, args, {
        plan, tc, bug, outcome, alias: false, idempotent: true,
        comment: args.comment || (bug ? `${outcome} during automated regression run; see Bug #${bug}.` : `${outcome} recorded by AgenTeX`),
        runName: args['run-name'] || `${outcome} — TC ${tc}${bug ? ` (Bug ${bug})` : ''}`,
      });
    }

    if (cmd === 'ensure-plan') {
      const name = need('name');
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const mode = args.execute ? 'executed' : 'plan';
      const { plans, truncated } = await adapter.listPlans();
      const view = (p) => ({ id: p.id, name: p.name, rootSuiteId: p.rootSuite ? p.rootSuite.id : (p.rootSuiteId ?? null) });
      const hits = plans.filter((p) => p.name === name);
      if (hits.length === 1) return { code: 0, out: { ok: true, mode, exists: true, plan: view(hits[0]) } };
      if (hits.length > 1) {
        return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'ambiguous-plan', ids: hits.map((p) => p.id), message: `${hits.length} test plans are named "${name}" (ids ${hits.map((p) => p.id).join(', ')}) — pick one by id; nothing was written` }] } };
      }
      if (truncated) {
        return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'cannot-prove-absent', message: `the plan list was cut at its page cap, so "${name}" cannot be proven absent — refusing to create a possible duplicate; nothing was written` }] } };
      }
      const spec = { name, ...(args.area ? { areaPath: String(args.area) } : {}), ...(args.iteration ? { iteration: String(args.iteration) } : {}) };
      if (!args.execute) {
        const d = await adapter.createPlan(spec, { execute: false });
        return { code: 0, out: { ok: true, mode, exists: false, plan: [{ step: 'create-plan', describe: `${d.method} ${d.url}`, request: d }], note: PLAN_NOTE } };
      }
      let created = null;
      const ledger = await new WritePlan([{
        step: 'create-plan',
        describe: `create test plan "${name}" (POST _apis/testplan/plans), then re-read the plan list`,
        run: async () => {
          created = await adapter.createPlan(spec, { execute: true });
          const after = await adapter.listPlans();
          if (!after.plans.some((p) => String(p.id) === String(created.id) && p.name === name)) {
            throw new Error(`test plan ${created.id} was created but is not listed on re-read — check it in the tracker; nothing was retried`);
          }
          return { id: created.id };
        },
      }]).execute();
      const allDone = ledger.every((l) => l.status === 'done');
      return { code: allDone ? 0 : 1, out: { ok: allDone, mode, exists: false, ledger, ...(created ? { created } : {}) } };
    }

    if (cmd === 'ensure-suite') {
      const plan = need('plan');
      const type = args.type;
      if (type !== 'requirement' && type !== 'static') {
        return { code: 2, out: { ok: false, error: { message: `--type must be requirement or static. ${USAGE}` } } };
      }
      const requirement = type === 'requirement' ? need('requirement') : null;
      const name = type === 'static' ? need('name') : null;
      const adapter = guardTestPlans(resolveTracker(cwd, { fetch }));
      const mode = args.execute ? 'executed' : 'plan';
      if (requirement !== null) requireCanonicalArg('requirement', requirement);
      let parent = args.parent !== undefined && args.parent !== true ? requireCanonicalArg('parent', args.parent) : null;
      if (!parent) {
        const p = await adapter.getPlan(plan);
        parent = p && p.rootSuite ? String(p.rootSuite.id) : null;
        if (!parent) return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'no-root-suite', message: `test plan ${plan} reported no root suite — pass --parent <suiteId>; nothing was written` }] } };
      }
      const matches = (x) => Boolean(x && x.parentSuite && String(x.parentSuite.id) === parent && (type === 'requirement'
        ? x.suiteType === 'requirementTestSuite' && String(x.requirementId) === String(requirement)
        : x.suiteType === 'staticTestSuite' && x.name === name));
      const view = (x) => ({ id: x.id, name: x.name, suiteType: x.suiteType, parentId: x.parentSuite ? x.parentSuite.id : null, ...(x.requirementId !== undefined ? { requirementId: x.requirementId } : {}) });
      const hits = (await adapter.listSuites(plan)).filter(matches);
      if (hits.length === 1) return { code: 0, out: { ok: true, mode, exists: true, suite: view(hits[0]) } };
      if (hits.length > 1) {
        return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'ambiguous-suite', ids: hits.map((x) => x.id), message: `${hits.length} suites match under parent ${parent} (ids ${hits.map((x) => x.id).join(', ')}) — pick one by id; nothing was written` }] } };
      }
      const spec = { type, ...(type === 'requirement' ? { requirementId: requirement } : { name }), parent };
      if (!args.execute) {
        const d = await adapter.createSuite(plan, spec, { execute: false });
        return { code: 0, out: { ok: true, mode, exists: false, plan: [{ step: 'create-suite', describe: `${d.method} ${d.url}`, request: d }], note: PLAN_NOTE } };
      }
      let created = null;
      const ledger = await new WritePlan([{
        step: 'create-suite',
        describe: `create the ${type} suite under suite ${parent} (POST _apis/testplan/Plans/${plan}/suites), then re-read the suites`,
        run: async () => {
          created = await adapter.createSuite(plan, spec, { execute: true });
          const after = await adapter.listSuites(plan);
          if (!after.some((x) => String(x.id) === String(created.id) && matches(x))) {
            throw new Error(`suite ${created.id} was created but is not listed under suite ${parent} on re-read — check it in the tracker; nothing was retried`);
          }
          return { id: created.id };
        },
      }]).execute();
      const allDone = ledger.every((l) => l.status === 'done');
      return { code: allDone ? 0 : 1, out: { ok: allDone, mode, exists: false, ledger, ...(created ? { created } : {}) } };
    }

    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  } catch (e) {
    if (e instanceof TrackerError) return { code: 1, out: trackerErrorOut(e) };
    return { code: e.exitCode === 2 ? 2 : 1, out: { ok: false, error: { message: e.message } } };
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
