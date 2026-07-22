#!/usr/bin/env node
// create-bug.mjs — Create an Azure DevOps Bug that mirrors a configurable team
// template and link it as a CHILD of a parent User Story. GENERIC / team-agnostic:
// org, project, area path, assignees, template, custom fields all come from config
// or the spec — nothing team-specific is hardcoded.
//
// TOOLING: everything runs through the Azure CLI (`az boards`, and `az devops invoke`
// for attachment upload/relations that `az boards` can't do). No direct REST calls.
//
// SAFE BY DEFAULT: with no --execute it only prints the PLAN + the exact `az` commands
// it WOULD run (a dry run). Nothing is written to Azure until --execute is passed. This
// is the tooling-level enforcement of the skill's single-confirmation gate.
//
// Usage:
//   node create-bug.mjs --spec bug.json            # dry run (plan + idempotency + attachment checks + az cmds)
//   node create-bug.mjs --spec bug.json --execute  # upload attachments + create bug + parent link
//   flags: --no-screenshots  create with no evidence (deliberate waiver)
//          --force           proceed even if an attachment fails the structural check
//          --allow-duplicate proceed even if a same-title Bug already exists (after user says so)
//
// The ONLY link it ever creates is the parent User Story link
// (az boards work-item relation add --relation-type parent). It never edits the parent
// story's fields and never touches any test artifact.
//
// spec JSON fields — see SKILL.md "Spec JSON shape". Required:
//   title, severity, priority, parentStoryId, assignedTo, summary, steps, expected, actual
// Optional: environment, bugCategory, valueArea, areaPath, iterationPath, testConfig,
//           timestamp, attachments[]
//
// Priority and Severity are NOT invented here — they come from the user's choice (SKILL
// step 4) and the script errors if either is missing or invalid. (Requirement: never
// infer/auto-fill required fields.)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig, orgArgs, az, parseArgs, showWorkItem, findByTitle,
  VALID_SEVERITY, VALID_PRIORITY,
} from "./_lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.spec) { console.error("ERROR: --spec <file.json> is required"); process.exit(2); }

const spec = JSON.parse(fs.readFileSync(args.spec, "utf8"));
const cfg = loadConfig();

// ---- validate spec ----------------------------------------------------------
const req = ["title", "severity", "priority", "parentStoryId", "assignedTo", "summary", "steps", "expected", "actual"];
for (const k of req) {
  if (spec[k] === undefined || spec[k] === null || spec[k] === "")
    { console.error(`ERROR: spec.${k} is required (do not infer it — ask the user).`); process.exit(2); }
}
if (!VALID_SEVERITY.includes(spec.severity)) {
  console.error(`ERROR: severity must be one of: ${VALID_SEVERITY.join(", ")}`); process.exit(2);
}
if (!VALID_PRIORITY.includes(Number(spec.priority))) {
  console.error(`ERROR: priority must be one of: ${VALID_PRIORITY.join(", ")}`); process.exit(2);
}
if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
  console.error("ERROR: spec.steps must be a non-empty array"); process.exit(2);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Last-line STRUCTURAL guard on an attachment (valid PNG/JPEG header + non-zero dims + not tiny).
// The thorough check (blankness + bug-relatedness) lives in check-image.mjs / the vision pass.
function structuralCheck(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: "not-found" };
  const buf = fs.readFileSync(file);
  if (buf.length < 2 * 1024) return { ok: false, reason: `too-small (${buf.length}b)` };
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h) return { ok: false, reason: "zero-dimension" };
    return { ok: true, fmt: "png", w, h };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ok: true, fmt: "jpeg" };
  return { ok: false, reason: "not-an-image (bad magic)" };
}

// Build ReproSteps HTML mirroring the template (timestamp+summary / steps / expected /
// actual + embedded screenshots / test config).
function buildReproHtml(uploaded) {
  const ts = spec.timestamp || "";
  const stepsLi = spec.steps.map((s) => `<li>${esc(s)}</li>`).join("");
  const imgs = uploaded.map((u) => `<div><img src="${u.url}" alt="${esc(u.name)}"></div>`).join("");
  return [
    `<hr style="border-color:black;">`,
    `<table><tbody><tr>`,
    `<td style="vertical-align:top;padding:2px 7px;font-weight:bold;">${esc(ts)}</td>`,
    `<td style="vertical-align:top;padding:2px 7px 2px 10px;">${esc(spec.summary)}</td>`,
    `</tr></tbody></table>`,
    `<hr style="border-color:black;">`,
    `<table><tbody>`,
    `<tr><td style="vertical-align:top;padding:2px 7px;font-weight:bold;">Steps:</td></tr>`,
    `<tr><td style="vertical-align:top;padding:2px 7px;"><ol>${stepsLi}</ol></td></tr>`,
    `<tr><td style="vertical-align:top;padding:2px 7px;">`,
    `<div style="padding-top:10px;text-decoration:underline;">Expected Result</div>`,
    `<div>${esc(spec.expected)}</div>`,
    `<div><br></div>`,
    `<div style="text-decoration:underline;">Actual Result</div>`,
    `<div>${esc(spec.actual)}</div>`,
    imgs,
    `</td></tr>`,
    `</tbody></table>`,
    `<hr style="border-color:white;">`,
    `<table><tbody><tr>`,
    `<td style="vertical-align:top;padding:2px 7px;font-weight:bold;">Test Configuration:</td>`,
    `<td style="vertical-align:top;padding:2px 7px 2px 100px;">${esc(spec.testConfig || "Windows 11 / Chrome")}</td>`,
    `</tr></tbody></table>`,
  ].join("");
}

// Upload one attachment via `az devops invoke` (az boards has no attachment verb) → {id,url}.
function uploadAttachment(cfg, filePath, execute) {
  const name = path.basename(filePath);
  const argv = [
    "devops", "invoke",
    "--area", "wit", "--resource", "attachments",
    "--http-method", "POST",
    "--route-parameters", `project=${cfg.project || ""}`,
    "--query-parameters", `fileName=${name}`,
    "--in-file", filePath,
    "--api-version", cfg.apiVersion,
    ...(cfg.org ? ["--org", cfg.org] : []),
    "-o", "json",
  ];
  const r = az(argv, { write: true, execute });
  if (!r.ran) return { name, id: "<dry-run>", url: "<dry-run-attachment-url>" };
  return { name, id: r.json?.id, url: r.json?.url };
}

// ---- main -------------------------------------------------------------------
(async () => {
  // 1) validate + inherit from parent story (READ)
  const parent = showWorkItem(cfg, spec.parentStoryId);
  const pf = parent?.fields || {};
  if (pf["System.WorkItemType"] !== "User Story") {
    console.error(`ERROR: parent #${spec.parentStoryId} is a "${pf["System.WorkItemType"] || "?"}", not a User Story. `
      + `Per skill constraints a Bug may only be a child of a User Story.`);
    process.exit(2);
  }
  const areaPath = spec.areaPath || cfg.areaPath || pf["System.AreaPath"];
  const iterationPath = spec.iterationPath || cfg.iterationPath || pf["System.IterationPath"];

  // 2) idempotency check (READ) — same-title Bug already on the board?
  let dupes = [];
  try { dupes = findByTitle(cfg, "Bug", spec.title); } catch (e) {
    console.log("(idempotency check skipped — query failed:", e.message.split("\n")[0], ")");
  }

  console.log("=== PLAN (Bug create) ===");
  console.log("Org / Project :", cfg.org || "(az default)", "/", cfg.project || "(az default)");
  console.log("Title         :", spec.title);
  console.log("Parent story  :", `#${spec.parentStoryId}  "${pf["System.Title"]}"  [${pf["System.State"]}]`);
  console.log("Link type     : parent (System.LinkTypes.Hierarchy-Reverse)  [ONLY link created]");
  console.log("Assigned to   :", spec.assignedTo);
  console.log("Priority      :", spec.priority, " (from user choice)");
  console.log("Severity      :", spec.severity, " (from user choice)");
  console.log("Area Path     :", areaPath, spec.areaPath ? "" : "(inherited/config)");
  console.log("Iteration     :", iterationPath, spec.iterationPath ? "" : "(inherited/config)");
  if (spec.environment || cfg.environment) console.log("Environment   :", spec.environment || cfg.environment);
  if (spec.bugCategory || cfg.bugCategory) console.log("Bug Category  :", spec.bugCategory || cfg.bugCategory);
  console.log("Value Area    :", spec.valueArea || cfg.valueArea);
  console.log("Attachments   :", (spec.attachments || []).join(", ") || "(none)");
  console.log("\n--- Repro (rendered text) ---");
  console.log(spec.timestamp ? `[${spec.timestamp}] ${spec.summary}` : spec.summary);
  console.log("Steps:"); spec.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log("Expected Result:", spec.expected);
  console.log("Actual Result  :", spec.actual);

  if (dupes.length) {
    console.log(`\n⚠ IDEMPOTENCY: ${dupes.length} existing Bug(s) with this exact title: #${dupes.join(", #")}`);
    if (args.execute && !args["allow-duplicate"]) {
      console.error("REFUSING to create a possible duplicate. Confirm with the user, then pass --allow-duplicate.");
      process.exit(2);
    }
  }

  // 3) attachment structural checks (dry run included)
  const atts = spec.attachments || [];
  const badAtts = [];
  for (const a of atts) {
    const c = structuralCheck(a);
    const dim = c.w ? `${c.w}x${c.h}` : (c.fmt || "");
    console.log(`  attachment: ${a} -> ${c.ok ? "OK " + dim : "INVALID (" + c.reason + ")"}`);
    if (!c.ok) badAtts.push(a);
  }
  if (badAtts.length && !args.force) {
    console.error(`\nERROR: ${badAtts.length} attachment(s) failed the structural check. `
      + `Fix or drop them (run check-image.mjs + the vision pass), or pass --force to override.`);
    process.exit(2);
  }
  if (atts.length === 0) {
    console.log("\n⚠ No screenshots attached. Bugs should include evidence — validate & attach some.");
    if (args.execute && !args["no-screenshots"]) {
      console.error("REFUSING to create an evidence-less bug. Pass --no-screenshots to do it deliberately.");
      process.exit(2);
    }
  }

  // 4) show the exact az write commands (transparency), always — dry or execute.
  console.log("\n--- az write commands ---");

  if (!args.execute) {
    // Print representative commands without running them.
    uploadAttachment(cfg, "<each attachment>", false);
    az(["boards", "work-item", "create", "--type", "Bug", "--title", spec.title, ...orgArgs(cfg),
        "--fields", "System.AreaPath=" + areaPath, "…(+ severity/priority/assignedTo/repro)"],
       { write: true, execute: false });
    az(["boards", "work-item", "relation", "add", "--id", "<newBugId>",
        "--relation-type", "parent", "--target-id", String(spec.parentStoryId), ...orgArgs(cfg)],
       { write: true, execute: false });
    console.log("\nDRY RUN — nothing written. Re-run with --execute after the user confirms the summary.");
    return;
  }

  // ---- WRITE PATH (only past explicit --execute) ----
  const uploaded = [];
  for (const a of atts) uploaded.push(uploadAttachment(cfg, a, true));

  // Assemble --fields. Custom.* only when a value exists (stock processes won't have them).
  const fields = [
    `System.AreaPath=${areaPath}`,
    `System.IterationPath=${iterationPath}`,
    `System.AssignedTo=${spec.assignedTo}`,
    `Microsoft.VSTS.Common.Priority=${Number(spec.priority)}`,
    `Microsoft.VSTS.Common.Severity=${spec.severity}`,
    `Microsoft.VSTS.Common.ValueArea=${spec.valueArea || cfg.valueArea}`,
    `Microsoft.VSTS.TCM.ReproSteps=${buildReproHtml(uploaded)}`,
  ];
  const envVal = spec.environment || cfg.environment;
  const catVal = spec.bugCategory || cfg.bugCategory;
  if (envVal) fields.push(`Custom.Environment=${envVal}`);
  if (catVal) fields.push(`Custom.BugCategory=${catVal}`);

  const createArgv = ["boards", "work-item", "create", "--type", "Bug", "--title", spec.title,
    ...orgArgs(cfg)];
  for (const f of fields) createArgv.push("--fields", f);
  createArgv.push("-o", "json");

  const created = az(createArgv, { write: true, execute: true });
  const id = created.json?.id;
  if (!id) { console.error("FAILED: could not read new work item id from az output."); process.exit(1); }

  // parent link (the ONLY relation)
  az(["boards", "work-item", "relation", "add", "--id", String(id),
      "--relation-type", "parent", "--target-id", String(spec.parentStoryId),
      ...orgArgs(cfg), "-o", "json"], { write: true, execute: true });

  // attach each uploaded file as an AttachedFile relation via az devops invoke PATCH
  for (const u of uploaded) {
    const patch = [{ op: "add", path: "/relations/-",
      value: { rel: "AttachedFile", url: u.url, attributes: { comment: u.name } } }];
    const tmp = path.join(os.tmpdir(), `attach-${id}-${u.name}.json`);
    fs.writeFileSync(tmp, JSON.stringify(patch));
    az(["devops", "invoke", "--area", "wit", "--resource", "workitems",
        "--route-parameters", `id=${id}`, "--http-method", "PATCH",
        "--api-version", cfg.apiVersion, "--in-file", tmp,
        ...(cfg.org ? ["--org", cfg.org] : []), "-o", "json"], { write: true, execute: true });
    fs.rmSync(tmp, { force: true });
  }

  const webUrl = cfg.org
    ? `${cfg.org}/${encodeURIComponent(cfg.project || "")}/_workitems/edit/${id}`
    : `(open work item #${id} in your org)`;
  console.log(`\n✅ Created Bug #${id}`);
  console.log("   ", webUrl);
  console.log(`   Parent: #${spec.parentStoryId}  |  Severity: ${spec.severity}  |  Priority: ${spec.priority}`);
  console.log("BUG_ID=" + id); // machine-readable line for the caller
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
