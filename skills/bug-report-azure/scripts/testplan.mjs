#!/usr/bin/env node
// testplan.mjs — read test plans/suites, find/validate a test case, create a new test
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
// Subcommands:
//   list-suites  --plan <id>
//   list-cases   --plan <id> [--suite <id>]                 # read only
//   find-case    --plan <id> --testcase <id>                # validate exists + locate point (read only)
//   create-case  --plan <id> --suite <id> --title "..." [--area "..."] [--execute]
//   fail         --plan <id> --testcase <id> --bug <id> [--comment "..."] [--run-name "..."] [--execute]
//
// Auth/config come from `az` + config.json via _lib.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, orgArgs, az, parseArgs, showWorkItem, findByTitle } from "./_lib.mjs";

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const cfg = loadConfig();
const API = cfg.apiVersion;

const need = (k) => { if (!args[k]) { console.error(`ERROR: --${k} is required`); process.exit(2); } return args[k]; };
const orgFlag = cfg.org ? ["--org", cfg.org] : [];

// --- read helpers (via az devops invoke --area testplan) ---------------------
function listSuites(plan) {
  const r = az(["devops", "invoke", "--area", "testplan", "--resource", "suites",
    "--route-parameters", `project=${cfg.project || ""}`, `planId=${plan}`,
    "--api-version", API, ...orgFlag, "-o", "json"]);
  return r.json?.value || r.json || [];
}

function casesInSuite(plan, suite) {
  const r = az(["devops", "invoke", "--area", "testplan", "--resource", "test cases",
    "--route-parameters", `project=${cfg.project || ""}`, `planId=${plan}`, `suiteId=${suite}`,
    "--api-version", API, ...orgFlag, "-o", "json"]);
  return r.json?.value || [];
}

function pointForCase(plan, suite, testcase) {
  // Per-suite TestPoint lookup; the global ?testCaseId shortcut 404s on many orgs.
  try {
    const r = az(["devops", "invoke", "--area", "testplan", "--resource", "test point",
      "--route-parameters", `project=${cfg.project || ""}`, `planId=${plan}`, `suiteId=${suite}`,
      "--query-parameters", `testCaseId=${testcase}`, "--api-version", API, ...orgFlag, "-o", "json"]);
    return (r.json?.value || [])[0] || null;
  } catch { return null; }
}

function findPoint(plan, testcase) {
  for (const s of listSuites(plan)) {
    const pt = pointForCase(plan, s.id, testcase);
    if (pt) return { suite: s, point: pt };
  }
  return null;
}

(async () => {
  if (cmd === "list-suites") {
    const plan = need("plan");
    const suites = listSuites(plan);
    console.log(`Suites in plan ${plan}:`);
    for (const s of suites) console.log(`  suite ${s.id}  ${s.name}  (${s.suiteType || ""})`);
    return;
  }

  if (cmd === "list-cases") {
    const plan = need("plan");
    const suites = args.suite ? [{ id: args.suite, name: "(given)" }] : listSuites(plan);
    for (const s of suites) {
      let cases = [];
      try { cases = casesInSuite(plan, s.id); } catch { continue; }
      if (!cases.length) continue;
      console.log(`\nSuite ${s.id}  ${s.name}:`);
      for (const c of cases) {
        const wi = c.workItem || c;
        console.log(`  TC ${wi.id}  ${wi.name || wi.fields?.["System.Title"] || ""}`);
      }
    }
    return;
  }

  if (cmd === "find-case") {
    // Validate the TC exists as a Test Case work item, then locate its point in the plan.
    const plan = need("plan"); const tc = need("testcase");
    let wi;
    try { wi = showWorkItem(cfg, tc); } catch (e) {
      console.error(`ERROR: test case #${tc} not found via az.\n${e.message}`); process.exit(1);
    }
    const type = wi?.fields?.["System.WorkItemType"];
    if (type !== "Test Case") {
      console.error(`ERROR: #${tc} is a "${type}", not a Test Case. Ask the user for a valid test case id.`);
      process.exit(1);
    }
    console.log(`TC #${tc} exists: "${wi.fields["System.Title"]}" [${wi.fields["System.State"]}]`);
    const hit = findPoint(plan, tc);
    if (!hit) { console.log(`(no test point for TC ${tc} in plan ${plan} — it may not be assigned to a suite there)`); process.exit(0); }
    console.log(`TC ${tc} -> plan ${plan} / suite ${hit.suite.id} (${hit.suite.name}) / point ${hit.point.id}`);
    return;
  }

  if (cmd === "create-case") {
    // Only on the user's explicit "create a new test case" choice.
    const plan = need("plan"); const suite = need("suite"); const title = need("title");
    const area = args.area || cfg.areaPath || null;

    // idempotency: an identically-titled Test Case already there?
    let dupes = [];
    try { dupes = findByTitle(cfg, "Test Case", title); } catch { /* non-fatal */ }

    console.log("=== PLAN (create test case) ===");
    console.log("Title :", title);
    console.log("Plan  :", plan, " Suite:", suite);
    console.log("Area  :", area || "(project default)");
    if (dupes.length) {
      console.log(`⚠ IDEMPOTENCY: existing Test Case(s) with this title: #${dupes.join(", #")}`);
      if (args.execute && !args["allow-duplicate"]) {
        console.error("REFUSING possible duplicate. Confirm with the user, then pass --allow-duplicate.");
        process.exit(2);
      }
    }

    const createArgv = ["boards", "work-item", "create", "--type", "Test Case", "--title", title, ...orgArgs(cfg)];
    if (area) { createArgv.push("--fields", `System.AreaPath=${area}`); }
    createArgv.push("-o", "json");

    if (!args.execute) {
      console.log("\n--- az write commands ---");
      az(createArgv, { write: true, execute: false });
      az(["devops", "invoke", "--area", "testplan", "--resource", "suite entries",
        "--route-parameters", `project=${cfg.project || ""}`, `suiteId=${suite}`,
        "--http-method", "PATCH", "--api-version", API, "--in-file", "<[{ \"id\": <newTcId> }]>",
        ...orgFlag], { write: true, execute: false });
      console.log("\nDRY RUN — nothing written. Re-run with --execute after user confirms.");
      return;
    }

    console.log("\n--- az write commands ---");
    const created = az(createArgv, { write: true, execute: true });
    const tcId = created.json?.id;
    if (!tcId) { console.error("FAILED: could not read new test case id."); process.exit(1); }

    // add to the suite
    const tmp = path.join(os.tmpdir(), `suite-add-${tcId}.json`);
    fs.writeFileSync(tmp, JSON.stringify([{ id: Number(tcId) }]));
    az(["devops", "invoke", "--area", "testplan", "--resource", "suite entries",
      "--route-parameters", `project=${cfg.project || ""}`, `suiteId=${suite}`,
      "--http-method", "PATCH", "--api-version", API, "--in-file", tmp, ...orgFlag, "-o", "json"],
      { write: true, execute: true });
    fs.rmSync(tmp, { force: true });

    console.log(`\n✅ Created Test Case #${tcId} and added it to suite ${suite}.`);
    console.log("TC_ID=" + tcId);
    return;
  }

  if (cmd === "fail") {
    const plan = need("plan"); const tc = need("testcase"); const bug = need("bug");
    const comment = args.comment || `Failed during automated regression run; see Bug #${bug}.`;
    const hit = findPoint(plan, tc);
    if (!hit) {
      console.error(`ERROR: no test point for TC ${tc} in plan ${plan}; cannot record a Failed result.`);
      process.exit(1);
    }
    console.log("=== PLAN (fail existing test case) ===");
    console.log(`TC ${tc} -> plan ${plan} / suite ${hit.suite.id} / point ${hit.point.id}`);
    console.log(`Outcome    : Failed`);
    console.log(`Bug link   : associatedBugs=[#${bug}]  +  TC->bug "tested by" work-item link`);
    console.log(`Comment    : ${comment}`);

    const runBody = { name: args["run-name"] || `Regression fail — TC ${tc} (Bug ${bug})`,
      plan: { id: String(plan) }, pointIds: [Number(hit.point.id)], automated: false, state: "InProgress" };

    if (!args.execute) {
      console.log("\n--- az write commands ---");
      az(["devops", "invoke", "--area", "test", "--resource", "runs", "--http-method", "POST",
        "--route-parameters", `project=${cfg.project || ""}`, "--api-version", API,
        "--in-file", `<${JSON.stringify(runBody)}>`, ...orgFlag], { write: true, execute: false });
      az(["devops", "invoke", "--area", "test", "--resource", "results", "--http-method", "PATCH",
        "--route-parameters", `project=${cfg.project || ""}`, "runId=<runId>", "--api-version", API,
        "--in-file", "<[{id,outcome:Failed,state:Completed,associatedBugs:[{id:bug}]}]>", ...orgFlag],
        { write: true, execute: false });
      az(["boards", "work-item", "relation", "add", "--id", String(tc), "--relation-type", "tested by",
        "--target-id", String(bug), ...orgArgs(cfg)], { write: true, execute: false });
      console.log("\nDRY RUN — nothing written. Re-run with --execute after user confirms.");
      return;
    }

    console.log("\n--- az write commands ---");
    // 1) create a manual run over the point
    let tmp = path.join(os.tmpdir(), `run-${tc}.json`);
    fs.writeFileSync(tmp, JSON.stringify(runBody));
    const run = az(["devops", "invoke", "--area", "test", "--resource", "runs", "--http-method", "POST",
      "--route-parameters", `project=${cfg.project || ""}`, "--api-version", API,
      "--in-file", tmp, ...orgFlag, "-o", "json"], { write: true, execute: true });
    fs.rmSync(tmp, { force: true });
    const runId = run.json?.id;

    // 2) read the result id, then PATCH it to Failed + associate the bug
    const results = az(["devops", "invoke", "--area", "test", "--resource", "results",
      "--route-parameters", `project=${cfg.project || ""}`, `runId=${runId}`,
      "--api-version", API, ...orgFlag, "-o", "json"]);
    const rid = results.json?.value?.[0]?.id || 100000;
    tmp = path.join(os.tmpdir(), `result-${tc}.json`);
    fs.writeFileSync(tmp, JSON.stringify([{ id: rid, outcome: "Failed", state: "Completed",
      comment, associatedBugs: [{ id: String(bug) }] }]));
    az(["devops", "invoke", "--area", "test", "--resource", "results", "--http-method", "PATCH",
      "--route-parameters", `project=${cfg.project || ""}`, `runId=${runId}`, "--api-version", API,
      "--in-file", tmp, ...orgFlag, "-o", "json"], { write: true, execute: true });
    fs.rmSync(tmp, { force: true });

    // 3) complete the run
    tmp = path.join(os.tmpdir(), `run-complete-${tc}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ state: "Completed" }));
    az(["devops", "invoke", "--area", "test", "--resource", "runs", "--http-method", "PATCH",
      "--route-parameters", `project=${cfg.project || ""}`, `runId=${runId}`, "--api-version", API,
      "--in-file", tmp, ...orgFlag, "-o", "json"], { write: true, execute: true });
    fs.rmSync(tmp, { force: true });

    // 4) durable work-item link TC -> bug ("tested by" == TestedBy-Reverse on the TC)
    az(["boards", "work-item", "relation", "add", "--id", String(tc), "--relation-type", "tested by",
      "--target-id", String(bug), ...orgArgs(cfg), "-o", "json"], { write: true, execute: true });

    console.log(`\n✅ Recorded Failed result for TC ${tc} (run ${runId}, result ${rid}); linked to Bug #${bug}.`);
    return;
  }

  console.error("Usage: testplan.mjs <list-suites|list-cases|find-case|create-case|fail> [options]");
  process.exit(2);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
