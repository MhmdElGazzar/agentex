#!/usr/bin/env node
// create-bug.js — file a defect as an Azure DevOps Bug: validate EVERYTHING
// first (zero board writes), then — only behind --execute — run the fixed
// fail-closed write sequence with an exact per-write ledger.
//
// Rebuilt on the tracker layer (scripts/lib/tracker/): direct ADO REST over
// Node's built-in fetch. No az CLI, no process spawning, zero npm dependencies.
// The PAT is read from .env by the adapter (AZURE_PAT, legacy
// AZURE_DEVOPS_EXT_PAT / AZURE_DEVOPS_PAT) and sent only in the Authorization
// header — never printed, logged, or placed on a command line (invariant 5).
//
// DRY RUN (default) — the validation gate behind the skill's ONE approval:
//   parent exists and is a User Story; duplicate check (WIQL) — a dup-check
//   FAILURE blocks (fails CLOSED), a dup found blocks without --allow-duplicate;
//   every picklist value checked against the project's field cache
//   (.agentex/cache/tracker-fields-ado.json, rebuilt on --refresh-fields);
//   attachment structural check; a server-side validateOnly create. Output is
//   the full plan JSON: validated facts + every intended write with its route.
//   If the server rejects a value the cache accepted, the REAL current
//   allowedValues are re-fetched live and returned with cacheStale:true — the
//   refresh stays the user's call; nothing is retried.
//
// --execute — the write phase (D-5 order): re-validate (cheap stale-plan
//   guard; validateOnly was proven in the dry run) -> upload attachments ->
//   create the Bug -> link the parent (System.LinkTypes.Hierarchy-Reverse, the
//   ONLY link) -> one json-patch setting ReproSteps HTML + AttachedFile
//   relations. First failure stops the sequence; the ledger reports every
//   intended write as done (id + url) or not-done (reason); created IDs are in
//   the JSON even when a later step throws. No auto-retry, no cleanup writes.
//
// Output: ONE JSON line (invariant 9). Exit codes:
//   dry run   0 = plan valid and ready | 2 = BLOCKED by validation | 1 = unexpected
//   --execute 0 = every intended write done | 1 = partial/failed (see ledger)
//             | 2 = refused before any write
//
// Flags: --spec <file.json> (required), --execute, --allow-duplicate,
//        --no-screenshots (deliberate evidence waiver), --force (attachment
//        structural-check override), --refresh-fields (rebuild the field cache).
//
// Spec JSON shape — see SKILL.md. Required: title, severity, priority,
// parentStoryId, assignedTo, summary, steps, expected, actual. Severity and
// priority come from the user's choice at the gate — this script never invents
// them, and validates them against the PROJECT'S real picklist values.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker');
const { resolveTracker, TrackerError } = require(path.join(LIB, 'index.js'));
const fieldCache = require(path.join(LIB, 'cache.js'));
const { WritePlan } = require(path.join(LIB, 'ledger.js'));

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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Last-line STRUCTURAL guard on an attachment (valid PNG/JPEG header + non-zero
// dims + not tiny). The thorough pass (blankness + bug-relatedness) lives in
// check-image.js + the agent's vision pass.
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

// ReproSteps HTML mirroring the template (timestamp+summary / steps / expected /
// actual + embedded screenshots / test config). Travels as a request BODY — no
// command-line length limit applies.
function buildReproHtml(spec, uploaded) {
  const ts = spec.timestamp || '';
  const stepsLi = spec.steps.map((s) => `<li>${esc(s)}</li>`).join('');
  const imgs = uploaded.map((u) => `<div><img src="${u.url}" alt="${esc(u.name)}"></div>`).join('');
  return [
    '<hr style="border-color:black;">',
    '<table><tbody><tr>',
    `<td style="vertical-align:top;padding:2px 7px;font-weight:bold;">${esc(ts)}</td>`,
    `<td style="vertical-align:top;padding:2px 7px 2px 10px;">${esc(spec.summary)}</td>`,
    '</tr></tbody></table>',
    '<hr style="border-color:black;">',
    '<table><tbody>',
    '<tr><td style="vertical-align:top;padding:2px 7px;font-weight:bold;">Steps:</td></tr>',
    `<tr><td style="vertical-align:top;padding:2px 7px;"><ol>${stepsLi}</ol></td></tr>`,
    '<tr><td style="vertical-align:top;padding:2px 7px;">',
    '<div style="padding-top:10px;text-decoration:underline;">Expected Result</div>',
    `<div>${esc(spec.expected)}</div>`,
    '<div><br></div>',
    '<div style="text-decoration:underline;">Actual Result</div>',
    `<div>${esc(spec.actual)}</div>`,
    imgs,
    '</td></tr>',
    '</tbody></table>',
    '<hr style="border-color:white;">',
    '<table><tbody><tr>',
    '<td style="vertical-align:top;padding:2px 7px;font-weight:bold;">Test Configuration:</td>',
    `<td style="vertical-align:top;padding:2px 7px 2px 100px;">${esc(spec.testConfig || 'Windows 11 / Chrome')}</td>`,
    '</tr></tbody></table>',
  ].join('');
}

const REQUIRED = ['title', 'severity', 'priority', 'parentStoryId', 'assignedTo', 'summary', 'steps', 'expected', 'actual'];
const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse'; // the ONLY link this script creates

// ---- validation phase (shared by dry run and the pre-write guard) ------------
// Reads + local checks only — NOTHING here writes to the board.
async function validate(adapter, spec, args, cwd) {
  const cfg = adapter.config;
  const blocked = [];
  const validation = {};
  let cacheStale = false;

  // 1) parent exists and is a User Story
  let parentFields = {};
  try {
    const parent = await adapter.getWorkItem(spec.parentStoryId);
    parentFields = (parent && parent.fields) || {};
    const type = parentFields['System.WorkItemType'];
    if (type !== 'User Story') {
      blocked.push({
        reason: 'parent-not-a-user-story',
        message: `parent #${spec.parentStoryId} is a "${type || '?'}", not a User Story — a Bug may only hang off a User Story`,
      });
    }
    validation.parent = {
      id: spec.parentStoryId, type: type || null,
      title: parentFields['System.Title'] || null, state: parentFields['System.State'] || null,
    };
  } catch (e) {
    blocked.push({ reason: 'parent-not-found', message: `parent story #${spec.parentStoryId} could not be read: ${e.message}` });
  }

  // 2) duplicate check — FAILS CLOSED: an unanswerable dup check blocks the filing.
  try {
    const dupes = await adapter.findByTitle('Bug', spec.title);
    validation.duplicates = dupes;
    if (dupes.length && !args['allow-duplicate']) {
      blocked.push({
        reason: 'duplicate-title', ids: dupes,
        message: `${dupes.length} existing Bug(s) share this exact title (#${dupes.join(', #')}) — confirm with the user, then pass --allow-duplicate`,
      });
    }
  } catch (e) {
    blocked.push({ reason: 'dup-check-failed', message: `duplicate check failed — refusing to file blind (fails closed): ${e.message}` });
  }

  // 3) field cache + picklist validation against the PROJECT'S real values
  let cacheInfo = null; let fieldMap = {};
  try {
    cacheInfo = await fieldCache.ensure(cwd, adapter, { types: ['Bug'], refresh: Boolean(args['refresh-fields']) });
    fieldMap = (cacheInfo.cache.types.Bug && cacheInfo.cache.types.Bug.fields) || {};
  } catch (e) {
    blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
  }

  const areaPath = spec.areaPath || cfg.areaPath || parentFields['System.AreaPath'] || null;
  const iterationPath = spec.iterationPath || cfg.iterationPath || parentFields['System.IterationPath'] || null;
  const envVal = spec.environment || cfg.environment || null;
  const catVal = spec.bugCategory || cfg.bugCategory || null;
  // ValueArea: an explicit value (spec/config) is validated as-is; the historic
  // 'Business' default is applied only when the project's Bug type HAS the field.
  const valueAreaExplicit = spec.valueArea || cfg.valueArea || null;
  const valueArea = valueAreaExplicit || (fieldMap['Microsoft.VSTS.Common.ValueArea'] ? 'Business' : null);

  const toValidate = [
    { field: 'Microsoft.VSTS.Common.Severity', value: spec.severity },
    { field: 'Microsoft.VSTS.Common.Priority', value: spec.priority },
    ...(valueArea ? [{ field: 'Microsoft.VSTS.Common.ValueArea', value: valueArea }] : []),
    ...(envVal ? [{ field: 'Custom.Environment', value: envVal }] : []),
    ...(catVal ? [{ field: 'Custom.BugCategory', value: catVal }] : []),
  ];
  if (cacheInfo) {
    const results = fieldCache.validateValues(cacheInfo.cache, 'Bug', toValidate);
    validation.fields = results;
    for (const r of results) {
      if (r.ok) continue;
      // An invalid value blocks the run; the correction is for the run only —
      // the consumer's config is never rewritten (invariant 11).
      blocked.push({
        reason: r.reason, field: r.field, value: r.value,
        ...(r.allowedValues ? { allowedValues: r.allowedValues } : {}),
        message: r.reason === 'field-not-on-type'
          ? `field ${r.field} does not exist on this project's Bug type — drop it from the spec/config for this run`
          : `"${r.value}" is not a valid value for ${r.field} — valid: ${r.allowedValues.join(' | ')}`,
      });
    }
  }

  // 4) attachment structural checks + evidence policy
  const atts = spec.attachments || [];
  validation.attachments = atts.map((a) => {
    const c = structuralCheck(a);
    return { file: a, ok: c.ok, ...(c.fmt ? { format: c.fmt } : {}), ...(c.w ? { width: c.w, height: c.h } : {}), ...(c.reason ? { reason: c.reason } : {}) };
  });
  const bad = validation.attachments.filter((a) => !a.ok);
  if (bad.length && !args.force) {
    blocked.push({
      reason: 'attachment-invalid', files: bad,
      message: `${bad.length} attachment(s) failed the structural check (${bad.map((b) => `${b.file}: ${b.reason}`).join('; ')}) — fix/drop them or pass --force`,
    });
  }
  if (atts.length === 0 && !args['no-screenshots']) {
    blocked.push({
      reason: 'no-evidence',
      message: 'no screenshots attached — bugs carry evidence; pass --no-screenshots only as a deliberate, user-confirmed waiver',
    });
  }

  // The fields the create will send (title always; paths only when resolvable).
  const fields = {
    'System.Title': spec.title,
    ...(areaPath ? { 'System.AreaPath': areaPath } : {}),
    ...(iterationPath ? { 'System.IterationPath': iterationPath } : {}),
    'System.AssignedTo': spec.assignedTo,
    'Microsoft.VSTS.Common.Priority': Number(spec.priority),
    'Microsoft.VSTS.Common.Severity': spec.severity,
    ...(valueArea ? { 'Microsoft.VSTS.Common.ValueArea': valueArea } : {}),
    ...(envVal ? { 'Custom.Environment': envVal } : {}),
    ...(catVal ? { 'Custom.BugCategory': catVal } : {}),
  };

  // 5) server-side validateOnly create — dry run only (D-5: proven once, not re-proven
  // during --execute, where the real create carries the same validation server-side).
  if (!args.execute && blocked.length === 0 && adapter.capabilities.validateOnly) {
    try {
      await adapter.createWorkItem('Bug', { fields }, { validateOnly: true, execute: true });
      validation.validateOnly = 'passed';
    } catch (e) {
      // The server rejected what the cache accepted — re-fetch the REAL current
      // allowedValues live (no error-prose parsing, no cache write, no retry).
      const staleFields = [];
      try {
        const live = await fieldCache.liveFieldMap(adapter, 'Bug');
        for (const { field } of toValidate) {
          const cached = fieldMap[field] && fieldMap[field].allowedValues;
          const cur = live[field] && live[field].allowedValues;
          if (JSON.stringify(cached) !== JSON.stringify(cur)) {
            staleFields.push({ field, allowedValues: cur || null });
          }
        }
      } catch { /* live read failed — the server message still blocks the run */ }
      cacheStale = staleFields.length > 0;
      validation.validateOnly = 'rejected';
      blocked.push({
        reason: 'server-rejected-create',
        status: e.status ?? null,
        serverMessage: e.serverMessage || e.message,
        ...(staleFields.length ? { fields: staleFields } : {}),
        message: cacheStale
          ? 'the server rejected a value the cache accepted — the field cache is stale; the real current options are included, ask the user and offer --refresh-fields'
          : 'the server rejected the create during validateOnly — nothing was written',
      });
    }
  }

  return { blocked, validation, fields, atts, cacheInfo, cacheStale };
}

// ---- main ---------------------------------------------------------------------
// Returns { code, out }; prints nothing. opts.fetch is the offline-test seam.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const mode = args.execute ? 'executed' : 'plan';
  try {
    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: '--spec <file.json> is required' } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    // Required fields are never inferred — missing means BLOCKED, before any read.
    const missing = REQUIRED.filter((k) => spec[k] === undefined || spec[k] === null || spec[k] === '');
    if (!missing.includes('steps') && (!Array.isArray(spec.steps) || spec.steps.length === 0)) missing.push('steps');
    if (missing.length) {
      return {
        code: 2,
        out: { ok: false, mode, blocked: missing.map((k) => ({ reason: 'missing-required-field', field: k, message: `spec.${k} is required — ask the user, never infer it` })) },
      };
    }

    const adapter = resolveTracker(cwd, { fetch });
    const { blocked, validation, fields, atts, cacheInfo, cacheStale } = await validate(adapter, spec, args, cwd);
    const cacheOut = cacheInfo
      ? { file: cacheInfo.file, rebuilt: cacheInfo.rebuilt, builtAt: cacheInfo.cache.builtAt, ...(cacheInfo.reason ? { reason: cacheInfo.reason } : {}) }
      : null;

    if (blocked.length) {
      return { code: 2, out: { ok: false, mode, blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}), ...(cacheStale ? { cacheStale: true } : {}) } };
    }

    if (!args.execute) {
      // The PLAN: every intended write, in order, with its exact route — rendered
      // by the agent on the consolidated screen. Nothing has been written.
      const plannedUploads = atts.map((a) => ({ name: path.basename(a), url: '{attachment-url}' }));
      const plan = [];
      for (const a of atts) {
        const d = await adapter.uploadAttachment(a, { execute: false });
        plan.push({ step: 'upload-attachment', describe: `${d.method} ${d.url}`, file: a, request: d });
      }
      const dCreate = await adapter.createWorkItem('Bug', { fields }, { execute: false });
      plan.push({ step: 'create-bug', describe: `${dCreate.method} ${dCreate.url}`, request: dCreate });
      const dLink = await adapter.addRelation('{new-bug-id}', PARENT_LINK, spec.parentStoryId, { execute: false });
      plan.push({ step: 'link-parent', describe: `${dLink.method} ${dLink.url} (${PARENT_LINK} -> #${spec.parentStoryId}, the only link)`, request: dLink });
      const dPatch = await adapter.updateWorkItem('{new-bug-id}', {
        fields: { 'Microsoft.VSTS.TCM.ReproSteps': buildReproHtml(spec, plannedUploads) },
        addRelations: plannedUploads.map((u) => ({ rel: 'AttachedFile', url: u.url, attributes: { comment: u.name } })),
      }, { execute: false });
      plan.push({ step: 'set-repro-and-evidence', describe: `${dPatch.method} ${dPatch.url}`, request: dPatch });
      return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const uploaded = [];
    let bugId = null; let bugUrl = null;
    const intents = [
      ...atts.map((a) => ({
        step: 'upload-attachment',
        describe: `upload ${path.basename(a)} (POST _apis/wit/attachments)`,
        run: async () => {
          const u = await adapter.uploadAttachment(a, { execute: true });
          uploaded.push(u);
          return { id: u.id, url: u.url };
        },
      })),
      {
        step: 'create-bug',
        describe: 'create the Bug (POST _apis/wit/workitems/$Bug)',
        run: async () => {
          const r = await adapter.createWorkItem('Bug', { fields }, { execute: true });
          bugId = r.id; bugUrl = r.url;
          return { id: r.id, url: r.url };
        },
      },
      {
        step: 'link-parent',
        describe: `link parent User Story #${spec.parentStoryId} (${PARENT_LINK} — the only link)`,
        run: async () => {
          await adapter.addRelation(bugId, PARENT_LINK, spec.parentStoryId, { execute: true });
          return { id: bugId, url: bugUrl };
        },
      },
      {
        step: 'set-repro-and-evidence',
        describe: 'set ReproSteps HTML + attach evidence (PATCH _apis/wit/workitems/{id}, json-patch)',
        run: async () => {
          await adapter.updateWorkItem(bugId, {
            fields: { 'Microsoft.VSTS.TCM.ReproSteps': buildReproHtml(spec, uploaded) },
            addRelations: uploaded.map((u) => ({ rel: 'AttachedFile', url: u.url, attributes: { comment: u.name } })),
          }, { execute: true });
          return { id: bugId, url: bugUrl };
        },
      },
    ];

    const ledger = await new WritePlan(intents).execute();
    const allDone = ledger.every((l) => l.status === 'done');
    return {
      code: allDone ? 0 : 1,
      out: {
        ok: allDone,
        mode: 'executed',
        ledger,
        // Created IDs are ALWAYS surfaced, even when a later step threw.
        created: { ...(bugId ? { bugId, url: bugUrl } : {}), attachments: uploaded },
        ...(cacheOut ? { cache: cacheOut } : {}),
      },
    };
  } catch (e) {
    if (e instanceof TrackerError) {
      return { code: 1, out: { ok: false, mode, error: { message: e.message, op: e.op, status: e.status, serverMessage: e.serverMessage, ...(e.credentialHint ? { credentialHint: e.credentialHint } : {}) } } };
    }
    return { code: e.exitCode === 2 ? 2 : 1, out: { ok: false, mode, error: { message: e.message } } };
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    process.exit(code);
  });
}
