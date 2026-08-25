#!/usr/bin/env node
// testplan.js — test-case mechanics on the tracker layer: read test
// plans/suites, find/validate a test case, create a new test case (only on the
// user's explicit choice), and record a Failed outcome for an existing test
// case associated with a bug.
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

const USAGE = 'usage: testplan.js <list-suites|list-cases|find-case|create-case|fail> [options]';

// Per-suite TestPoint lookup; the global ?testCaseId shortcut 404s on many orgs.
async function findPoint(adapter, planId, testCaseId) {
  for (const s of await adapter.listSuites(planId)) {
    const pt = await adapter.getPoint(planId, s.id, testCaseId);
    if (pt) return { suiteId: s.id, suiteName: s.name, pointId: pt.id };
  }
  return null;
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
    if (cmd === 'list-suites') {
      const plan = need('plan');
      const adapter = resolveTracker(cwd, { fetch });
      const suites = await adapter.listSuites(plan);
      return { code: 0, out: { ok: true, planId: plan, suites: suites.map((s) => ({ id: s.id, name: s.name, suiteType: s.suiteType })) } };
    }

    if (cmd === 'list-cases') {
      const plan = need('plan');
      const adapter = resolveTracker(cwd, { fetch });
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
      const adapter = resolveTracker(cwd, { fetch });
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
      const adapter = resolveTracker(cwd, { fetch });
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
          describe: `add the Test Case to suite ${suite} (PATCH _apis/testplan/suiteentry/${suite})`,
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
      const plan = need('plan'); const tc = need('testcase'); const bug = need('bug');
      const comment = args.comment || `Failed during automated regression run; see Bug #${bug}.`;
      const adapter = resolveTracker(cwd, { fetch });

      // Read phase: locate the test point (fail closed when there is none).
      const point = await findPoint(adapter, plan, tc);
      if (!point) {
        return {
          code: 2,
          out: { ok: false, mode: args.execute ? 'executed' : 'plan', blocked: [{ reason: 'no-test-point', message: `no test point for TC ${tc} in plan ${plan} — a Failed result needs the case assigned to a suite there` }] },
        };
      }
      const runBody = {
        name: args['run-name'] || `Regression fail — TC ${tc} (Bug ${bug})`,
        plan: { id: String(plan) }, pointIds: [Number(point.pointId)], automated: false, state: 'InProgress',
      };

      if (!args.execute) {
        const dRun = await adapter.createRun(runBody, { execute: false });
        const dResult = await adapter.updateRunResults('{run-id}', [{ id: '{result-id}', outcome: 'Failed', state: 'Completed', comment, associatedBugs: [{ id: String(bug) }] }], { execute: false });
        const dComplete = await adapter.updateRun('{run-id}', { state: 'Completed' }, { execute: false });
        const dLink = await adapter.addRelation(tc, TESTED_BY_LINK, bug, { execute: false });
        return {
          code: 0,
          out: {
            ok: true, mode: 'plan', point,
            plan: [
              { step: 'create-run', describe: `${dRun.method} ${dRun.url}`, request: dRun },
              { step: 'record-failed-result', describe: `${dResult.method} ${dResult.url}`, request: dResult },
              { step: 'complete-run', describe: `${dComplete.method} ${dComplete.url}`, request: dComplete },
              { step: 'link-tested-by', describe: `${dLink.method} ${dLink.url} (${TESTED_BY_LINK} TC #${tc} -> Bug #${bug})`, request: dLink },
            ],
          },
        };
      }

      let runId = null; let resultId = null;
      const manualNote = () => `run ${runId} is left InProgress — complete or delete it manually in Azure DevOps; nothing was retried`;
      const ledger = await new WritePlan([
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
          step: 'record-failed-result',
          describe: 'mark the run result Failed + associate the bug (PATCH _apis/test/Runs/{run}/results)',
          run: async () => {
            try {
              // Read the real result id first — PATCHing a guessed id could
              // corrupt an unrelated record.
              const results = await adapter.listRunResults(runId);
              resultId = results[0] && results[0].id;
              if (!resultId) throw new Error(`run ${runId} was created but no test result was found to mark Failed`);
              await adapter.updateRunResults(runId, [{ id: resultId, outcome: 'Failed', state: 'Completed', comment, associatedBugs: [{ id: String(bug) }] }], { execute: true });
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
        {
          step: 'link-tested-by',
          describe: `durable TC -> bug link (${TESTED_BY_LINK})`,
          run: async () => {
            await adapter.addRelation(tc, TESTED_BY_LINK, bug, { execute: true });
            return { id: Number(tc) };
          },
        },
      ]).execute();
      const allDone = ledger.every((l) => l.status === 'done');
      return {
        code: allDone ? 0 : 1,
        out: {
          ok: allDone, mode: 'executed', ledger, point,
          ...(runId ? { run: { id: runId } } : {}),
          ...(resultId ? { resultId } : {}),
          testCaseId: Number(tc), bugId: Number(bug),
        },
      };
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
    process.exit(code);
  });
}
