#!/usr/bin/env node
// testplan.js — read test plans/suites, find/validate a test case, create a new test
// case (only on explicit user choice), and record a Failed outcome for an existing test
// case associated with a bug. GENERIC / team-agnostic (plan/suite/case ids are passed in).
//
// TOOLING: everything runs through the Azure CLI. `az boards work-item` covers work-item
// reads and test-case creation; test-plan/point/run routes go through `az devops invoke`
// (`az boards` has no native verb for them). No direct REST calls.
//
// This script NEVER edits a test case's fields, never edits a plan/suite, and only writes
// in two explicit, user-chosen, --execute-gated ways:
//   (a) create-case : create a Test Case + add it to a suite (user asked for a NEW case)
//   (b) fail        : record a Failed test *result* on a test point + link TC->bug
//
// DRY RUN = EXECUTE, ONE CODE PATH. Both modes walk the same branches with the same data;
// `EXECUTE` is threaded into every write and each helper prints the request it WOULD send
// instead of sending it (see invokeWithBody). Ids that only exist after a write are printed
// as `<runId>` / `<newTcId>` placeholders, the same way create-bug.js prints `<newBugId>`.
// The previous hand-written preview block listed three of the four writes `fail` performs —
// it silently omitted the PATCH that closes the run — so "the exact commands" was untrue.
//
// PARTIAL WRITES ARE REPORTED, NEVER SWALLOWED. Both commands write more than once, and a
// failure after the first write leaves something real on the board: a Test Case not yet in
// its suite, or a test run still InProgress. Each such point names the id it created and what
// to finish by hand, rather than dying as if nothing had happened. Nothing is auto-retried.
//
// Subcommands:
//   list-suites  --plan <id>
//   list-cases   --plan <id> [--suite <id>]                 # read only
//   find-case    --plan <id> --testcase <id>                # validate exists + locate point (read only)
//   create-case  --plan <id> --suite <id> --title "..." [--area "..."] [--allow-duplicate] [--execute]
//   fail         --plan <id> --testcase <id> --bug <id> [--comment "..."] [--run-name "..."] [--execute]
//
// `--allow-duplicate` covers both "a same-title Test Case exists" and "the duplicate check
// itself could not run" — without it, either one stops an --execute run (constraint 7).
//
// Config/auth come from the AgenTeX `.env` via _lib.js, which accepts both the AZURE_URL /
// AZURE_PROJECT and AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_DEFAULT_PROJECT naming conventions.
// Every call in THIS script goes through `az`, which reads its own PAT from
// AZURE_DEVOPS_EXT_PAT — this script never touches a secret. (_lib.js does read one, but
// only for the two direct-HTTPS calls in create-bug.js's path, which this script never
// uses: binary attachment upload and the ReproSteps patch. See _lib.js `resolvePat`.)

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, orgArgs, az, parseArgs, showWorkItem, findByTitle, createBug } = require('./_lib.js');

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const cfg = loadConfig();
const API = cfg.apiVersion;

const need = (k) => { if (!args[k]) { console.error(`ERROR: --${k} is required`); process.exit(2); } return args[k]; };
const orgFlag = cfg.org ? ['--org', cfg.org] : [];

// Unique path for each `--in-file` payload. The names used to be keyed on the test case id
// alone (`run-<tc>.json`), so two runs touching the same test case — or two bug filings in
// parallel — could overwrite each other's body between writeFileSync and the az call.
const tmpFile = (name) => path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.json`);

// "This suite holds no such point" comes back as a 404, and hitting it is NORMAL while
// scanning every suite in a plan for one test case. Everything else — an auth failure, a bad
// project, a route that moved — is a real error that constraint 9 says the user must see.
// Collapsing both into `null` is what made an unauthorized PAT read as "no test point".
const NOT_FOUND = /\b404\b|TF401349|TF401019|does not exist|could not be found|\bnot found\b/i;
const isNotFound = (e) => NOT_FOUND.test(String((e && e.message) || ''));

// One `az devops invoke ... --in-file` write, on the SAME code path in both modes: with
// execute=false it prints the exact command it would run plus the payload that file will
// carry, and sends nothing. This is what keeps the dry run from drifting from the real run.
function invokeWithBody(name, argv, body, execute) {
  const tmp = tmpFile(name);
  const full = [...argv, '--in-file', tmp, ...orgFlag, '-o', 'json'];
  if (!execute) {
    az(full, { write: true, execute: false });
    console.log(`    --in-file will hold: ${JSON.stringify(body)}`);
    console.log('    (written immediately before the call, deleted right after)');
    return { json: null };
  }
  fs.writeFileSync(tmp, JSON.stringify(body));
  try { return az(full, { write: true, execute: true }); }
  finally { fs.rmSync(tmp, { force: true }); }
}

// --- read helpers (via az devops invoke --area testplan) ---------------------
function listSuites(plan) {
  const r = az(['devops', 'invoke', '--area', 'testplan', '--resource', 'suites',
    '--route-parameters', `project=${cfg.project || ''}`, `planId=${plan}`,
    '--api-version', API, ...orgFlag, '-o', 'json']);
  return r.json?.value || r.json || [];
}

function casesInSuite(plan, suite) {
  const r = az(['devops', 'invoke', '--area', 'testplan', '--resource', 'test cases',
    '--route-parameters', `project=${cfg.project || ''}`, `planId=${plan}`, `suiteId=${suite}`,
    '--api-version', API, ...orgFlag, '-o', 'json']);
  return r.json?.value || [];
}

function pointForCase(plan, suite, testcase) {
  // Per-suite TestPoint lookup; the global ?testCaseId shortcut 404s on many orgs.
  try {
    const r = az(['devops', 'invoke', '--area', 'testplan', '--resource', 'test point',
      '--route-parameters', `project=${cfg.project || ''}`, `planId=${plan}`, `suiteId=${suite}`,
      '--query-parameters', `testCaseId=${testcase}`, '--api-version', API, ...orgFlag, '-o', 'json']);
    return (r.json?.value || [])[0] || null;
  } catch (e) {
    // Only a genuine not-found means "no point here" — see isNotFound.
    if (isNotFound(e)) return null;
    throw e;
  }
}

function findPoint(plan, testcase) {
  for (const s of listSuites(plan)) {
    const pt = pointForCase(plan, s.id, testcase);
    if (pt) return { suite: s, point: pt };
  }
  return null;
}

(async () => {
  if (cmd === 'list-suites') {
    const plan = need('plan');
    const suites = listSuites(plan);
    console.log(`Suites in plan ${plan}:`);
    for (const s of suites) console.log(`  suite ${s.id}  ${s.name}  (${s.suiteType || ''})`);
    return;
  }

  if (cmd === 'list-cases') {
    const plan = need('plan');
    const suites = args.suite ? [{ id: args.suite, name: '(given)' }] : listSuites(plan);
    for (const s of suites) {
      let cases = [];
      // A suite that legitimately has no cases 404s; anything else is a real failure and
      // must not be listed away as an empty suite (constraint 9).
      try { cases = casesInSuite(plan, s.id); } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
      if (!cases.length) continue;
      console.log(`\nSuite ${s.id}  ${s.name}:`);
      for (const c of cases) {
        const wi = c.workItem || c;
        console.log(`  TC ${wi.id}  ${wi.name || wi.fields?.['System.Title'] || ''}`);
      }
    }
    return;
  }

  if (cmd === 'find-case') {
    // Validate the TC exists as a Test Case work item, then locate its point in the plan.
    const plan = need('plan'); const tc = need('testcase');
    let wi;
    try { wi = showWorkItem(cfg, tc); } catch (e) {
      console.error(`ERROR: test case #${tc} not found via az.\n${e.message}`); process.exit(1);
    }
    const type = wi?.fields?.['System.WorkItemType'];
    if (type !== 'Test Case') {
      console.error(`ERROR: #${tc} is a "${type}", not a Test Case. Ask the user for a valid test case id.`);
      process.exit(1);
    }
    console.log(`TC #${tc} exists: "${wi.fields['System.Title']}" [${wi.fields['System.State']}]`);
    const hit = findPoint(plan, tc);
    if (!hit) { console.log(`(no test point for TC ${tc} in plan ${plan} — it may not be assigned to a suite there)`); process.exit(0); }
    console.log(`TC ${tc} -> plan ${plan} / suite ${hit.suite.id} (${hit.suite.name}) / point ${hit.point.id}`);
    return;
  }

  if (cmd === 'create-case') {
    // Only on the user's explicit "create a new test case" choice.
    const plan = need('plan'); const suite = need('suite'); const title = need('title');
    const area = args.area || cfg.areaPath || null;

    // PREFLIGHT (read-only). The Test Case is created first and added to the suite second, so
    // a bad plan or a suite belonging to a DIFFERENT plan would leave an orphaned Test Case
    // behind — and nothing downstream would catch it, because the `suite entries` write route
    // takes only suiteId and never sees planId at all. Listing the plan's suites validates
    // both in a single read: the plan must exist to list, and the suite must appear in that
    // list to belong to it. Cheap, and it moves the failure to BEFORE the first write.
    let suites;
    try { suites = listSuites(plan); } catch (e) {
      console.error(`ERROR: could not read the suites of plan ${plan} — nothing was created.\n${e.message}`);
      process.exit(1);
    }
    if (!suites.some((s) => String(s.id) === String(suite))) {
      console.error(`ERROR: suite ${suite} is not in plan ${plan} — nothing was created. `
        + `Ask the user which suite to use. Suites in this plan:`);
      for (const s of suites) console.error(`  suite ${s.id}  ${s.name}  (${s.suiteType || ''})`);
      process.exit(2);
    }

    // idempotency: an identically-titled Test Case already there? A failed query is NOT the
    // same as "none found" — swallowing it silently turned constraint 7 into a no-op, so it
    // is recorded and gated below, the same way create-bug.js gates it for Bugs.
    let dupes = [];
    let dupeCheckError = null;
    try { dupes = findByTitle(cfg, 'Test Case', title); } catch (e) {
      dupeCheckError = e.message.split('\n')[0];
    }

    console.log('=== PLAN (create test case) ===');
    console.log('Title :', title);
    console.log('Plan  :', plan, ' Suite:', suite, ' (suite confirmed to belong to this plan)');
    console.log('Area  :', area || '(project default)');
    if (dupeCheckError) {
      console.log(`⚠ IDEMPOTENCY CHECK FAILED — could not query existing Test Cases: ${dupeCheckError}`);
      if (args.execute && !args['allow-duplicate']) {
        console.error('REFUSING to create without a completed duplicate check (skill constraint 7). '
          + 'Fix the query (org/project/auth), or confirm with the user and pass --allow-duplicate.');
        process.exit(2);
      }
    } else if (dupes.length) {
      console.log(`⚠ IDEMPOTENCY: existing Test Case(s) with this title: #${dupes.join(', #')}`);
      if (args.execute && !args['allow-duplicate']) {
        console.error('REFUSING possible duplicate. Confirm with the user, then pass --allow-duplicate.');
        process.exit(2);
      }
    }

    // ONE code path for both modes — see the header. In dry mode the create prints instead of
    // running and the id is a placeholder, so the suite-add command below is printed with the
    // identical shape it will really have.
    const EXECUTE = Boolean(args.execute);
    console.log('\n--- az write commands ---');

    // Created through the same `az devops invoke` JSON-Patch route as the Bug (_lib.js
    // createBug) rather than `az boards work-item create --title "<title>"`, for the same
    // reason the WIQL moved: the typed command put the user's title on the command line,
    // where cmd.exe expands %NAME% with no way to escape it — a Test Case would have been
    // created under a title nobody typed. The payload goes in a file; no shell parses it.
    const fields = [];
    if (area) fields.push(`System.AreaPath=${area}`);
    const created = createBug(cfg, { type: 'Test Case', title, fields, execute: EXECUTE });
    if (!created.ok) { console.error(`FAILED: could not create the Test Case.\n${created.error}`); process.exit(1); }
    const tcId = EXECUTE ? created.id : '<newTcId>';
    if (EXECUTE && !tcId) { console.error('FAILED: could not read new test case id.'); process.exit(1); }

    // add to the suite. Under --execute the Test Case EXISTS from here on, so a failure has to
    // name it — an unreported orphan is invisible on the board and nobody goes looking for it.
    try {
      invokeWithBody(`suite-add-${tcId}`,
        ['devops', 'invoke', '--area', 'testplan', '--resource', 'suite entries',
          '--route-parameters', `project=${cfg.project || ''}`, `suiteId=${suite}`,
          '--http-method', 'PATCH', '--api-version', API],
        [{ id: EXECUTE ? Number(tcId) : tcId }], EXECUTE);
    } catch (e) {
      if (!EXECUTE) throw e;
      console.error(`\nFAILED: Test Case #${tcId} WAS created, but adding it to suite ${suite} failed:`);
      console.error(`  ${e.message}`);
      console.error(`  It exists but is in no suite. Add it to the suite manually, or delete it and re-run.`);
      console.log('TC_ID=' + tcId);
      process.exit(1);
    }

    if (!EXECUTE) {
      console.log('\nDRY RUN — nothing written. Re-run with --execute after user confirms.');
      return;
    }

    console.log(`\n✅ Created Test Case #${tcId} and added it to suite ${suite}.`);
    console.log('TC_ID=' + tcId);
    return;
  }

  if (cmd === 'fail') {
    const plan = need('plan'); const tc = need('testcase'); const bug = need('bug');
    const comment = args.comment || `Failed during automated regression run; see Bug #${bug}.`;
    const hit = findPoint(plan, tc);
    if (!hit) {
      console.error(`ERROR: no test point for TC ${tc} in plan ${plan}; cannot record a Failed result.`);
      process.exit(1);
    }
    console.log('=== PLAN (fail existing test case) ===');
    console.log(`TC ${tc} -> plan ${plan} / suite ${hit.suite.id} / point ${hit.point.id}`);
    console.log(`Outcome    : Failed`);
    console.log(`Bug link   : associatedBugs=[#${bug}]  +  TC->bug "tested by" work-item link`);
    console.log(`Comment    : ${comment}`);

    const runBody = { name: args['run-name'] || `Regression fail — TC ${tc} (Bug ${bug})`,
      plan: { id: String(plan) }, pointIds: [Number(hit.point.id)], automated: false, state: 'InProgress' };

    // FOUR writes, one code path for both modes (see the header). The old dry run listed only
    // three of them — it omitted the PATCH that closes the run — so what the user confirmed was
    // not what ran.
    const EXECUTE = Boolean(args.execute);
    console.log('\n--- az write commands ---');

    // 1) create a manual run over the point
    const run = invokeWithBody(`run-${tc}`,
      ['devops', 'invoke', '--area', 'test', '--resource', 'runs', '--http-method', 'POST',
        '--route-parameters', `project=${cfg.project || ''}`, '--api-version', API],
      runBody, EXECUTE);
    const runId = EXECUTE ? run.json?.id : '<runId>';
    if (EXECUTE && !runId) {
      console.error('FAILED: could not read the new test run id from az output.'); process.exit(1);
    }

    // From here a test run EXISTS on the board and is InProgress. Anything failing below
    // leaves it hanging open, so it is reported by id instead of surfacing as a bare error.
    let rid = '<resultId>';
    try {
      // 2) read the result id, then PATCH it to Failed + associate the bug. Do NOT guess an id —
      //    PATCHing the wrong result would corrupt an unrelated record. (A read, so it only runs
      //    for real; the dry run has no run to read and prints the placeholder instead.)
      if (EXECUTE) {
        const results = az(['devops', 'invoke', '--area', 'test', '--resource', 'results',
          '--route-parameters', `project=${cfg.project || ''}`, `runId=${runId}`,
          '--api-version', API, ...orgFlag, '-o', 'json']);
        rid = results.json?.value?.[0]?.id;
        if (!rid) throw new Error('the run was created but carries no test result to mark Failed.');
      }
      invokeWithBody(`result-${tc}`,
        ['devops', 'invoke', '--area', 'test', '--resource', 'results', '--http-method', 'PATCH',
          '--route-parameters', `project=${cfg.project || ''}`, `runId=${runId}`, '--api-version', API],
        [{ id: rid, outcome: 'Failed', state: 'Completed', comment, associatedBugs: [{ id: String(bug) }] }],
        EXECUTE);

      // 3) complete the run
      invokeWithBody(`run-complete-${tc}`,
        ['devops', 'invoke', '--area', 'test', '--resource', 'runs', '--http-method', 'PATCH',
          '--route-parameters', `project=${cfg.project || ''}`, `runId=${runId}`, '--api-version', API],
        { state: 'Completed' }, EXECUTE);
    } catch (e) {
      if (!EXECUTE) throw e;
      console.error(`\nFAILED: test run ${runId} WAS created, but recording the Failed outcome did not complete:`);
      console.error(`  ${e.message}`);
      console.error(`  Run ${runId} is still InProgress in Azure DevOps — open it, mark the result, and `
        + `complete the run manually. Nothing was auto-retried.`);
      process.exit(1);
    }

    // 4) durable work-item link TC -> bug ("tested by" == TestedBy-Reverse on the TC). This is
    //    the second and last relation type the skill ever creates — see SKILL.md constraint 3.
    try {
      az(['boards', 'work-item', 'relation', 'add', '--id', String(tc), '--relation-type', 'tested by',
        '--target-id', String(bug), ...orgArgs(cfg), '-o', 'json'], { write: true, execute: EXECUTE });
    } catch (e) {
      if (!EXECUTE) throw e;
      console.error(`\nFAILED: the Failed result WAS recorded (run ${runId}, result ${rid}), but linking `
        + `TC ${tc} -> Bug #${bug} failed:`);
      console.error(`  ${e.message}`);
      console.error(`  Add the "tested by" link manually; the test result itself is complete.`);
      process.exit(1);
    }

    if (!EXECUTE) {
      console.log('\nDRY RUN — nothing written. Re-run with --execute after user confirms.');
      return;
    }

    console.log(`\n✅ Recorded Failed result for TC ${tc} (run ${runId}, result ${rid}); linked to Bug #${bug}.`);
    return;
  }

  console.error('Usage: testplan.js <list-suites|list-cases|find-case|create-case|fail> [options]');
  process.exit(2);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
