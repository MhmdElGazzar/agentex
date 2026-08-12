#!/usr/bin/env node
// create-bug.js — Create an Azure DevOps Bug in the team's standard layout and link it as a
// CHILD of a parent User Story. GENERIC / team-agnostic: org, project, area path, assignees,
// custom fields all come from the AgenTeX `.env` (AZURE_* keys) or the spec — nothing
// team-specific is hardcoded.
//
// The LAYOUT — which fields are sent, and the ReproSteps HTML built by buildReproHtml() — lives
// here in code and is the same for every run. The configured `{{TEMPLATE_BUG_ID}}` is only a
// REFERENCE bug the workflow opens to show the user what that layout looks like on the board;
// nothing is read from it or copied off it. What varies per bug is the spec's field VALUES.
//
// TOOLING: reads, the Bug create and the parent link all go through the Azure CLI. Exactly
// TWO calls go over direct HTTPS, because `az` provably cannot make them — both diagnosed
// live, both stated in SKILL.md's "Tooling" section (keep code and doc in sync):
//  - Uploading a screenshot as a Work Item attachment (_lib.js `uploadAttachmentBinary`):
//    `az devops invoke --in-file` always text-decodes the file first, so it can never
//    carry raw binary bytes, and `az boards` has no attachment verb at all.
//  - The post-create JSON Patch that sets ReproSteps and adds the AttachedFile relations
//    (_lib.js `patchWorkItem`). Neither `az` route works here: `az devops invoke ... PATCH
//    --route-parameters id=<id>` always resolves the "workitems" resource to the work-item
//    CREATE location (whose route template needs a `type` parameter) because its location
//    lookup (azext_devops/dev/team/invoke.py) matches purely on (area, resource) and never
//    looks at route_parameters or http_method — so every PATCH-by-id dies with
//    `KeyError: 'type'` (reproducible from a brand-new `az` process, so it isn't a stale
//    location cache). And the typed
//    `az boards work-item update --fields` alternative puts the entire ReproSteps HTML on
//    the command line, where cmd.exe silently truncates past 8191 characters — a rich
//    12-step repro with 3 screenshots already measures ~4.5k, a 20-step one ~7.6k.
//    Sending the patch over HTTPS from memory removes that ceiling instead of living under
//    it, and lets each attachment keep its filename caption (attributes.comment), which the
//    typed `relation add` command could not set.
// The Bug itself is created with `az devops invoke` (_lib.js `createBug`) rather than
// `az boards work-item create`, which has a confirmed bug on this project's Bug type:
// Custom.Environment + Custom.BugCategory together get rejected with a fabricated Rule
// Error even on a minimal payload that validateOnly accepts cleanly. The parent link still
// goes through `az boards work-item relation add --relation-type parent`, unchanged.
//
// SAFE BY DEFAULT: with no --execute it only prints the PLAN + the exact commands it WOULD
// run (a dry run). Nothing is written to Azure until --execute is passed. The dry run and
// the real run walk the SAME code path with the same conditionals — each step is issued by
// the same call with execute=false, which prints instead of sending — so what the user
// confirms cannot drift from what executes. This is the tooling-level enforcement of the
// skill's single-confirmation gate.
//
// FAIL-CLOSED under --execute: anything that would produce a silently wrong Bug stops the
// run rather than degrading it. A screenshot that failed to upload, or an idempotency check
// that could not complete, aborts BEFORE the Bug is created — each behind its own override
// flag, so continuing anyway is always a deliberate, logged choice.
//
// Both modes first ask Azure to validate the payload (`validateOnly`, which creates nothing),
// so picklist and required-field errors surface before the user confirms — and, on rejection,
// the offending field's real allowed values are printed for the user to choose from (see
// explainRejection / _lib.js workItemTypeFields). Tests: create-bug.test.js.
//
// Usage:
//   node create-bug.js --spec bug.json            # dry run (plan + idempotency + attachments + validation + commands)
//   node create-bug.js --spec bug.json --execute  # upload attachments + create bug + parent link + repro
//   flags: --no-screenshots       create with no evidence (deliberate waiver)
//          --force                keep going when an attachment fails the structural check;
//                                 the invalid ones are SKIPPED, never uploaded
//          --allow-duplicate      proceed although a same-title Bug exists, OR although the
//                                 duplicate check itself could not run
//          --allow-failed-upload  proceed although one or more screenshots failed to upload
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

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  loadConfig, orgArgs, az, parseArgs, showWorkItem, findByTitle,
  uploadAttachmentBinary, patchWorkItem, createBug, describeFieldRejection,
  VALID_SEVERITY, VALID_PRIORITY,
} = require('./_lib.js');

const args = parseArgs(process.argv.slice(2));
if (!args.spec) { console.error('ERROR: --spec <file.json> is required'); process.exit(2); }

// Strip a UTF-8 BOM before parsing. Windows tools that write the spec — PowerShell's
// Set-Content/Out-File in particular — prepend one by default, and JSON.parse rejects it
// with a bare "Unexpected token" that says nothing about the real cause. Also give a
// readable error instead of a stack trace when the file isn't valid JSON at all.
let spec;
try {
  spec = JSON.parse(fs.readFileSync(args.spec, 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error(`ERROR: could not read the spec at ${args.spec}\n  ${e.message}`);
  process.exit(2);
}
const cfg = loadConfig();

// ---- validate spec ----------------------------------------------------------
const req = ['title', 'severity', 'priority', 'parentStoryId', 'assignedTo', 'summary', 'steps', 'expected', 'actual'];
for (const k of req) {
  if (spec[k] === undefined || spec[k] === null || spec[k] === '') {
    console.error(`ERROR: spec.${k} is required (do not infer it — ask the user).`); process.exit(2);
  }
}
if (!VALID_SEVERITY.includes(spec.severity)) {
  console.error(`ERROR: severity must be one of: ${VALID_SEVERITY.join(', ')}`); process.exit(2);
}
if (!VALID_PRIORITY.includes(Number(spec.priority))) {
  console.error(`ERROR: priority must be one of: ${VALID_PRIORITY.join(', ')}`); process.exit(2);
}
if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
  console.error('ERROR: spec.steps must be a non-empty array'); process.exit(2);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Last-line STRUCTURAL guard on an attachment (valid PNG/JPEG header + non-zero dims + not tiny).
// The thorough check (blankness + bug-relatedness) lives in check-image.js / the vision pass.
function structuralCheck(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'not-found' };
  const buf = fs.readFileSync(file);
  if (buf.length < 2 * 1024) return { ok: false, reason: `too-small (${buf.length}b)` };
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h) return { ok: false, reason: 'zero-dimension' };
    return { ok: true, fmt: 'png', w, h };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ok: true, fmt: 'jpeg' };
  return { ok: false, reason: 'not-an-image (bad magic)' };
}

// Build ReproSteps HTML mirroring the template (timestamp+summary / steps / expected /
// actual + embedded screenshots / test config).
function buildReproHtml(uploaded) {
  const ts = spec.timestamp || '';
  const stepsLi = spec.steps.map((s) => `<li>${esc(s)}</li>`).join('');
  const imgs = uploaded.map((u) => `<div><img src="${u.url}" alt="${esc(u.name)}"></div>`).join('');
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
    `<td style="vertical-align:top;padding:2px 7px 2px 100px;">${esc(spec.testConfig || 'Windows 11 / Chrome')}</td>`,
    `</tr></tbody></table>`,
  ].join('');
}

// Upload one attachment (direct HTTPS — see _lib.js `uploadAttachmentBinary` for why `az`
// can't make this call) → {name,id,url}, or null if the upload failed.
//
// It does not throw, so that ONE bad screenshot doesn't hide the state of the others: the
// loop below attempts every attachment and the user sees the full failure list in one pass.
// That is NOT the same as tolerating failure — the caller checks the list and aborts before
// creating anything (see the --allow-failed-upload gate). Uploading first also means an
// abort here leaves nothing on the board to clean up.
async function uploadAttachment(cfg, filePath, execute) {
  try {
    return await uploadAttachmentBinary(cfg, filePath, { execute });
  } catch (e) {
    console.log(`  ⚠ attachment upload FAILED for ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

// Which spec key feeds which field, so the guidance below can name the thing the caller
// actually has to edit rather than the Azure reference name.
const SPEC_KEY_FOR_FIELD = {
  'Custom.Environment': 'spec.environment',
  'Custom.BugCategory': 'spec.bugCategory',
  'Microsoft.VSTS.Common.Severity': 'spec.severity',
  'Microsoft.VSTS.Common.Priority': 'spec.priority',
  'Microsoft.VSTS.Common.ValueArea': 'spec.valueArea',
  'System.AreaPath': 'spec.areaPath',
  'System.IterationPath': 'spec.iterationPath',
  'System.AssignedTo': 'spec.assignedTo',
};

// Print a rejection the way a human can act on it: the exact Azure error (constraint 9),
// then — when the error names a field — that field's REAL allowed values, fetched from the
// process. This is deliberately reactive: no picklist is looked up before the first attempt,
// so the common path stays one call, but the moment Azure says no we answer with data
// instead of another guess. Guessing is what this replaces; the caller still asks the user.
function explainRejection(errText) {
  const errLine = (String(errText).match(/^ERROR:.*$/m) || [String(errText).trim().split('\n').pop()])[0];
  console.error('\nAzure REJECTED this payload — nothing was uploaded or created.');
  console.error('  ' + errLine.trim());

  let info = null;
  try { info = describeFieldRejection(cfg, 'Bug', errText); } catch { /* best effort only */ }

  if (!info) {
    console.error('\n  This is not a recognised field rejection. Surface the error above to the '
      + 'user as-is and ask how to proceed — do not retry with an altered payload.');
    return;
  }
  if (info.lookupError) {
    console.error(`\n  Could not read the allowed values for "${info.field}" (${info.lookupError}).`);
    console.error('  Ask the user for the correct value — do not guess.');
    return;
  }
  if (!info.meta) {
    console.error(`\n  Azure named the field "${info.field}", which is not on this work item type's `
      + 'field list. Ask the user for the correct value — do not guess.');
    return;
  }

  const specKey = SPEC_KEY_FOR_FIELD[info.meta.referenceName] || `the "${info.meta.referenceName}" field`;
  if (info.kind === 'required') {
    console.error(`\n  "${info.meta.name}" (${info.meta.referenceName}) is REQUIRED on this process `
      + `and no value was sent. Set ${specKey}.`);
  } else {
    console.error(`\n  "${info.meta.name}" (${info.meta.referenceName}) rejected the value `
      + `"${info.value}". Set ${specKey} to one of the values below.`);
  }
  if (info.meta.allowedValues.length) {
    console.error('  Allowed values on this project:');
    info.meta.allowedValues.forEach((v) => console.error(`    - ${v}`));
    console.error('\n  ASK THE USER to pick one of these. Never choose on their behalf — the list '
      + 'is the project\'s vocabulary, but which value is correct is a judgement about the run.');
  } else {
    console.error('  (This field has no fixed value list — ask the user what it should contain.)');
  }
}

// ---- main -------------------------------------------------------------------
(async () => {
  // 1) validate + inherit from parent story (READ)
  const parent = showWorkItem(cfg, spec.parentStoryId);
  const pf = parent?.fields || {};
  if (pf['System.WorkItemType'] !== 'User Story') {
    console.error(`ERROR: parent #${spec.parentStoryId} is a "${pf['System.WorkItemType'] || '?'}", not a User Story. `
      + `Per skill constraints a Bug may only be a child of a User Story.`);
    process.exit(2);
  }
  // Area Path: spec override -> inherit from the parent story -> AZURE_AREA_PATH -> hard
  // error. Never falls back to Azure DevOps' own default: omitting it lands the Bug at the
  // bare project root, not the team's actual area — silently wrong, not an acceptable default.
  let areaPath = null, areaSource = null;
  if (spec.areaPath) { areaPath = spec.areaPath; areaSource = 'spec override'; }
  else if (pf['System.AreaPath']) { areaPath = pf['System.AreaPath']; areaSource = `parent #${spec.parentStoryId}`; }
  else if (cfg.areaPath) { areaPath = cfg.areaPath; areaSource = 'AZURE_AREA_PATH'; }
  if (!areaPath) {
    console.error(`ERROR: no Area Path resolved. Parent #${spec.parentStoryId} has none set, `
      + `no spec.areaPath override, and AZURE_AREA_PATH is not configured. Azure DevOps' own `
      + `default is the bare project root, which is not an acceptable silent fallback here — `
      + `set one of the three explicitly.`);
    process.exit(2);
  }

  // Iteration Path: spec override -> inherit from the parent story -> AZURE_ITERATION_PATH
  // -> omit (Azure DevOps applies its own default, which is acceptable for Iteration,
  // unlike Area Path). The configured value used to be resolved into cfg but never
  // consulted here, so AZURE_ITERATION_PATH was advertised in .env.example and silently did
  // nothing; it now sits between the parent and the ADO default, which is where a
  // project-wide setting belongs — specific beats general, and both beat the fallback.
  let iterationPath = null, iterationSource = null;
  if (spec.iterationPath) { iterationPath = spec.iterationPath; iterationSource = 'spec override'; }
  else if (pf['System.IterationPath']) { iterationPath = pf['System.IterationPath']; iterationSource = `parent #${spec.parentStoryId}`; }
  else if (cfg.iterationPath) { iterationPath = cfg.iterationPath; iterationSource = 'AZURE_ITERATION_PATH'; }

  // 2) idempotency check (READ) — same-title Bug already on the board?
  // A failure here is NOT the same as "no duplicates found": the skill's constraint 7 makes
  // a successful check a precondition for creating, so a failed query is recorded and gated
  // below rather than swallowed into an empty result.
  let dupes = [];
  let dupeCheckError = null;
  try { dupes = findByTitle(cfg, 'Bug', spec.title); } catch (e) {
    dupeCheckError = e.message.split('\n')[0];
  }

  console.log('=== PLAN (Bug create) ===');
  console.log('Org / Project :', cfg.org || '(az default)', '/', cfg.project || '(az default)');
  console.log('Title         :', spec.title);
  console.log('Parent story  :', `#${spec.parentStoryId}  "${pf['System.Title']}"  [${pf['System.State']}]`);
  console.log('Link type     : parent (System.LinkTypes.Hierarchy-Reverse)  [ONLY link created]');
  console.log('Assigned to   :', spec.assignedTo);
  console.log('Priority      :', spec.priority, ' (from user choice)');
  console.log('Severity      :', spec.severity, ' (from user choice)');
  console.log('Area Path     :', `${areaPath} (${areaSource})`);
  console.log('Iteration     :', iterationPath ? `${iterationPath} (${iterationSource})` : '(ADO default — not set)');
  if (spec.environment || cfg.environment) console.log('Environment   :', spec.environment || cfg.environment);
  if (spec.bugCategory || cfg.bugCategory) console.log('Bug Category  :', spec.bugCategory || cfg.bugCategory);
  console.log('Value Area    :', spec.valueArea || cfg.valueArea);
  console.log('Attachments   :', (spec.attachments || []).join(', ') || '(none)');
  console.log('\n--- Repro (rendered text) ---');
  console.log(spec.timestamp ? `[${spec.timestamp}] ${spec.summary}` : spec.summary);
  console.log('Steps:'); spec.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('Expected Result:', spec.expected);
  console.log('Actual Result  :', spec.actual);

  if (dupeCheckError) {
    console.log(`\n⚠ IDEMPOTENCY CHECK FAILED — could not query existing Bugs: ${dupeCheckError}`);
    if (args.execute && !args['allow-duplicate']) {
      console.error('REFUSING to create without a completed duplicate check (skill constraint 7): '
        + 'an unchecked title may already be on the board. Fix the query (org/project/auth), or '
        + 'confirm with the user and pass --allow-duplicate to create anyway.');
      process.exit(2);
    }
  } else if (dupes.length) {
    console.log(`\n⚠ IDEMPOTENCY: ${dupes.length} existing Bug(s) with this exact title: #${dupes.join(', #')}`);
    if (args.execute && !args['allow-duplicate']) {
      console.error('REFUSING to create a possible duplicate. Confirm with the user, then pass --allow-duplicate.');
      process.exit(2);
    }
  }

  // 3) attachment structural checks (dry run included). Splits into the list that will
  // actually be uploaded and the list that won't — `--force` means "don't block the bug on
  // these", not "upload them anyway", so an invalid file is never sent to the board.
  const atts = spec.attachments || [];
  const goodAtts = [];
  const badAtts = [];
  for (const a of atts) {
    const c = structuralCheck(a);
    const dim = c.w ? `${c.w}x${c.h}` : (c.fmt || '');
    console.log(`  attachment: ${a} -> ${c.ok ? 'OK ' + dim : 'INVALID (' + c.reason + ')'}`);
    (c.ok ? goodAtts : badAtts).push(a);
  }
  if (badAtts.length && !args.force) {
    console.error(`\nERROR: ${badAtts.length} attachment(s) failed the structural check. `
      + `Fix or drop them (run check-image.js + the vision pass), or pass --force to override.`);
    process.exit(2);
  }
  if (badAtts.length) {
    console.log(`  (--force: ${badAtts.length} invalid attachment(s) will be SKIPPED, not uploaded: `
      + badAtts.map((a) => path.basename(a)).join(', ') + ')');
  }
  // The evidence gate counts what can actually be attached, not what the spec listed — a
  // spec naming three unreadable files must not buy its way past it.
  if (goodAtts.length === 0) {
    console.log('\n⚠ No valid screenshots to attach. Bugs should include evidence — validate & attach some.');
    if (args.execute && !args['no-screenshots']) {
      console.error('REFUSING to create an evidence-less bug. Pass --no-screenshots to do it deliberately.');
      process.exit(2);
    }
  }

  // Same field set the create step has always sent — built once, shared by the dry-run
  // preview and the real create below so the preview can't drift from what actually runs.
  const fields = [
    `System.AssignedTo=${spec.assignedTo}`,
    `Microsoft.VSTS.Common.Priority=${Number(spec.priority)}`,
    `Microsoft.VSTS.Common.Severity=${spec.severity}`,
    `Microsoft.VSTS.Common.ValueArea=${spec.valueArea || cfg.valueArea}`,
  ];
  if (areaPath) fields.push(`System.AreaPath=${areaPath}`);
  if (iterationPath) fields.push(`System.IterationPath=${iterationPath}`);
  const envVal = spec.environment || cfg.environment;
  const catVal = spec.bugCategory || cfg.bugCategory;
  if (envVal) fields.push(`Custom.Environment=${envVal}`);
  if (catVal) fields.push(`Custom.BugCategory=${catVal}`);

  // 3d) SERVER-SIDE VALIDATION — ask Azure whether this exact payload is acceptable before
  // anything is uploaded or created. `validateOnly=true` runs the real rule engine (picklist
  // values, required fields, process rules) and creates nothing.
  //
  // This runs in BOTH modes on purpose. In a dry run it means a bad field value surfaces
  // while the user is still reviewing, instead of after they have confirmed. Under --execute
  // it runs before the first upload, so a rejection costs nothing at all. Previously the
  // first thing to notice a bad picklist value was the real create — which happened after
  // the attachments were already uploaded and after the user's single confirmation had been
  // spent, and left an orphaned blob behind on every retry.
  console.log('\n--- validation (validateOnly — creates nothing) ---');
  const check = createBug(cfg, { type: 'Bug', title: spec.title, fields, validateOnly: true, execute: true });
  if (!check.ok) { explainRejection(check.error); process.exit(2); }
  console.log('  Azure accepts these fields.');

  // 4) the write sequence — ONE code path for both modes.
  //
  // `EXECUTE` is threaded into every call below. With execute=false each helper prints the
  // request it WOULD send and returns a placeholder instead of sending it, so the dry run
  // walks the identical branches with the identical data: the same attachments, the same
  // conditionals, the same commands. The previous split (a separate "print representative
  // commands" block) drifted from reality — it showed an upload and an Attached File
  // relation even when the spec had no attachments at all, and printed a REST URL for a
  // create that actually runs through `az devops invoke`. A confirmation is only worth
  // anything if it shows what will really happen.
  const EXECUTE = Boolean(args.execute);
  console.log('\n--- write commands ---');

  // 4a) attachments FIRST, before anything exists on the board. If any upload fails we can
  // still abort having written nothing to the board (an orphaned blob in ADO's attachment
  // store is invisible and harmless; a Bug missing its evidence is neither).
  const uploaded = [];
  const failedAttachments = [];
  for (const a of goodAtts) {
    const result = await uploadAttachment(cfg, a, EXECUTE);
    if (result) uploaded.push(result);
    else failedAttachments.push(a);
  }
  if (failedAttachments.length && EXECUTE && !args['allow-failed-upload']) {
    console.error(`\nREFUSING to create the Bug: ${failedAttachments.length} of ${goodAtts.length} `
      + `screenshot(s) failed to upload (${failedAttachments.map((a) => path.basename(a)).join(', ')}). `
      + `The evidence the user approved would be missing from the Bug. Nothing has been written to `
      + `the board. Fix the upload (auth / network / file), or confirm with the user and pass `
      + `--allow-failed-upload to file the Bug without them.`);
    process.exit(2);
  }

  // 4b) the Bug itself — see _lib.js `createBug` for why this goes through
  // `az devops invoke` instead of `az boards work-item create`.
  const created = createBug(cfg, { type: 'Bug', title: spec.title, fields, execute: EXECUTE });
  if (!created.ok) {
    // validateOnly above already cleared this payload, so reaching here means something
    // changed underneath us (a rule edit, a permissions change) — still explain it with the
    // real field data rather than dumping a raw error.
    explainRejection(created.error);
    process.exit(1);
  }
  // In dry mode there is no real id yet; a readable placeholder keeps the printed commands
  // copy-pasteable-with-substitution while the structure stays identical to the real run.
  const id = EXECUTE ? created.id : '<newBugId>';

  // 4c) parent link (the ONLY relation of that type)
  az(['boards', 'work-item', 'relation', 'add', '--id', String(id),
    '--relation-type', 'parent', '--target-id', String(spec.parentStoryId),
    ...orgArgs(cfg), '-o', 'json'], { write: true, execute: EXECUTE });

  // 4d) ReproSteps + the AttachedFile relations, in ONE JSON Patch over direct HTTPS (see
  // the header for why neither `az` route can carry this). Content/formatting of the HTML
  // is byte-for-byte what it has always been — buildReproHtml() is unchanged. Sending the
  // relations in the same patch also restores each attachment's filename caption
  // (attributes.comment), which the typed `relation add` command could not set.
  const reproHtml = buildReproHtml(uploaded);
  const patch = [
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: reproHtml },
    ...uploaded.map((u) => ({
      op: 'add',
      path: '/relations/-',
      value: { rel: 'AttachedFile', url: u.url, attributes: { comment: u.name } },
    })),
  ];
  try {
    await patchWorkItem(cfg, id, patch, { execute: EXECUTE });
  } catch (e) {
    // The Bug exists by now — say so plainly instead of dying as if nothing happened, so
    // the user knows exactly what to finish by hand. Never auto-retried (constraint 9).
    console.error(`\nFAILED: Bug #${id} WAS created, but setting its ReproSteps/attachments failed:`);
    console.error(`  ${e.message}`);
    console.error(`  Open work item #${id} and add the repro + screenshots manually, or delete it and re-run.`);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with --execute after the user confirms the summary.');
    return;
  }

  console.log(`\n✅ Created Bug #${id}`);
  console.log('   ', created.url || `(open work item #${id} in your org)`);
  console.log(`   Parent: #${spec.parentStoryId}  |  Severity: ${spec.severity}  |  Priority: ${spec.priority}`);
  if (uploaded.length) console.log(`   Attached & embedded: ${uploaded.map((u) => u.name).join(', ')}`);
  // Only reachable with --allow-failed-upload; without it the run aborted before creating.
  if (failedAttachments.length) {
    console.log(`   ⚠ ${failedAttachments.length} screenshot(s) FAILED to upload and were NOT attached/embedded `
      + `(--allow-failed-upload): ` + failedAttachments.map((a) => path.basename(a)).join(', '));
  }
  if (badAtts.length) {
    console.log(`   ⚠ ${badAtts.length} attachment(s) skipped as structurally invalid (--force): `
      + badAtts.map((a) => path.basename(a)).join(', '));
  }
  console.log('BUG_ID=' + id); // machine-readable line for the caller
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
