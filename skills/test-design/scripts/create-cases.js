#!/usr/bin/env node
// create-cases.js — the test-design flow's mechanics: read a User Story for
// analysis, then validate EVERYTHING first (zero board writes) and — only
// behind --execute — create the Test Cases, one atomic create per case with
// the Steps XML in the body and the Tested-By link inline, behind an exact
// per-write ledger.
//
// Built on the tracker layer (scripts/lib/tracker/): direct ADO REST over
// Node's built-in fetch. No az CLI, no process spawning, zero npm dependencies.
// The PAT is read from .env by the adapter (AZURE_PAT, legacy
// AZURE_DEVOPS_EXT_PAT / AZURE_DEVOPS_PAT) and sent only in the Authorization
// header — never printed, logged, or placed on a command line (invariant 5).
//
// READ (free, no gating):
//   node create-cases.js story --id <id>
//     getWorkItem($expand=all) -> id/type/title/state/iterationPath/areaPath/
//     url/description/acceptanceCriteria (HTML — the agent extracts design
//     links and translation tables itself) + relations.
//
// DRY RUN (default) — the validation gate behind the skill's ONE approval:
//   node create-cases.js --spec <file.json> [--allow-duplicate] [--refresh-fields]
//     storyId exists and IS a User Story (fails closed); iteration/area are
//     re-read fresh from the story — never trusted from the spec. Per case:
//     title non-empty and unique within the spec; the duplicate-title check
//     (findByTitle) blocks on a hit without --allow-duplicate, and a dup check
//     that cannot complete blocks too (fails CLOSED). Steps are structured
//     JSON — {type: action|validate, text, expected} — and THIS SCRIPT builds
//     the Steps XML (IDs from 2 incrementing by 1, `last` = highest ID,
//     ActionStep's second parameterizedString empty, & < > escaped); the XML
//     travels as a JSON request-body value, so the old file+$STEPS quoting
//     trick and the 8191-char command-line limit are gone. Field existence is
//     validated against the project's field cache (Test Case type merged in
//     additively, --refresh-fields rebuilds), then ONE representative
//     server-side validateOnly create proves the field shape. A server
//     rejection despite a cache pass returns live options + cacheStale:true.
//
// --execute — one WritePlan, one atomic create per case: fields (Title, Steps
//   XML, the story's iteration/area, AssignedTo) + the inline relation
//   Microsoft.VSTS.Common.TestedBy-Reverse -> storyId, which renders on the
//   story as "Tested By ->" the test case. First failure stops; the ledger
//   reports every intended case as done (id + url) or not-done (reason);
//   created IDs are in the JSON even when a later step throws. No auto-retry,
//   no cleanup writes.
//
// Spec JSON shape (written by the agent to the OS temp dir):
//   { "storyId": 12345, "assignee": "qa.engineer@example.com",
//     "cases": [ { "title": "<Persona> || <Feature> || user checks the page UI",
//                  "steps": [ { "type": "action", "text": "…" },
//                             { "type": "validate", "text": "…", "expected": "…" } ] } ] }
//
// Output: ONE JSON line (invariant 9). Exit codes:
//   reads/dry run 0 = ok / plan ready | 2 = blocked/bad usage | 1 = unexpected
//   --execute     0 = every intended write done | 1 = partial/failed (see ledger)
//                 | 2 = refused before any write
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker');
const { resolveTracker, TrackerError } = require(path.join(LIB, 'index.js'));
const fieldCache = require(path.join(LIB, 'cache.js'));
const { WritePlan } = require(path.join(LIB, 'ledger.js'));

// PINNED: the ONLY link this script creates. One ADO link, two views: the
// REVERSE side lives on the Test Case and renders on the story as
// "Tested By ->" (the story-side view is TestedBy-Forward). Live verification
// of the direction pair is deferred to the release smoke; this constant is the
// one place it lives and the sibling test pins it.
const TESTED_BY_LINK = 'Microsoft.VSTS.Common.TestedBy-Reverse';
const STEPS_FIELD = 'Microsoft.VSTS.TCM.Steps';

// PINNED: the Steps-XML ID scheme — container id="0", step IDs starting at 2
// and incrementing by 1 (id="1" is reserved), `last` = the highest ID used.
// Live-verified against portal-authored Steps XML on the maintainer's private
// ADO project (2026-08-28, read-only): <steps id="0" last="N"> with step ids
// 2,3,4,… The sibling test pins the exact output; any later correction is a
// one-line change here.
const STEP_ID_START = 2;
const STEP_ID_STEP = 1;

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// steps: [{type: 'action'|'validate', text, expected?}] -> the Steps XML value.
// ActionStep: second parameterizedString ALWAYS empty. ValidateStep: first =
// what the user does/checks, second = the expected result.
function buildStepsXml(steps) {
  let id = STEP_ID_START - STEP_ID_STEP;
  const parts = steps.map((s) => {
    id += STEP_ID_STEP;
    if (s.type === 'validate') {
      return `<step id="${id}" type="ValidateStep">` +
        `<parameterizedString isformatted="true">${escXml(s.text)}</parameterizedString>` +
        `<parameterizedString isformatted="true">${escXml(s.expected)}</parameterizedString>` +
        '</step>';
    }
    return `<step id="${id}" type="ActionStep">` +
      `<parameterizedString isformatted="true">${escXml(s.text)}</parameterizedString>` +
      '<parameterizedString isformatted="true"/>' +
      '</step>';
  });
  return `<steps id="0" last="${id}">${parts.join('')}</steps>`;
}

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

const USAGE =
  'usage: create-cases.js story --id <id>' +
  ' | create-cases.js --spec <file.json> [--allow-duplicate] [--refresh-fields] [--execute]';

const webUrl = (adapter, id) =>
  `${adapter.config.base}/${encodeURIComponent(adapter.config.project)}/_workitems/edit/${id}`;

// ---- spec structural checks (before any read) ---------------------------------
function specShapeErrors(spec) {
  const blocked = [];
  if (spec.storyId === undefined || spec.storyId === null || spec.storyId === '') {
    blocked.push({ reason: 'missing-required-field', field: 'storyId', message: 'spec.storyId is required' });
  }
  if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
    blocked.push({ reason: 'missing-required-field', field: 'cases', message: 'spec.cases must be a non-empty array' });
  }
  return blocked;
}

// Per-case step validation — every finding at once; returns the built XML when clean.
function checkSteps(c, blocked) {
  if (!Array.isArray(c.steps) || c.steps.length === 0) {
    blocked.push({ reason: 'bad-steps', title: c.title, message: `"${c.title}": steps must be a non-empty array` });
    return null;
  }
  let ok = true;
  c.steps.forEach((s, i) => {
    if (!s || (s.type !== 'action' && s.type !== 'validate')) {
      blocked.push({ reason: 'bad-steps', title: c.title, message: `"${c.title}": steps[${i}].type must be "action" or "validate"` });
      ok = false;
      return;
    }
    if (typeof s.text !== 'string' || !s.text.trim()) {
      blocked.push({ reason: 'bad-steps', title: c.title, message: `"${c.title}": steps[${i}] has no text` });
      ok = false;
    }
    if (s.type === 'validate' && (typeof s.expected !== 'string' || !s.expected.trim())) {
      blocked.push({ reason: 'bad-steps', title: c.title, message: `"${c.title}": steps[${i}] is a validate step with no expected result` });
      ok = false;
    }
  });
  return ok ? buildStepsXml(c.steps) : null;
}

// ---- validation phase (shared by dry run and the pre-write guard) -------------
// Reads + local checks only — NOTHING here writes to the board.
async function validate(adapter, spec, args, cwd) {
  const cfg = adapter.config;
  const blocked = [];
  const validation = {};
  let cacheStale = false;

  // 1) assignee: spec -> a single configured azure.assignee — never invented.
  const configured = cfg.assignees || [];
  const assignee = (spec.assignee && String(spec.assignee).trim()) ||
    (configured.length === 1 ? configured[0] : null);
  if (!assignee) {
    blocked.push({
      reason: 'missing-assignee',
      ...(configured.length > 1 ? { options: configured } : {}),
      message: configured.length > 1
        ? `spec.assignee is empty and azure.assignee lists ${configured.length} options (${configured.join(', ')}) — ask the user which one, never pick silently`
        : 'no assignee — set spec.assignee (ask the user) or azure.assignee in config/project.json',
    });
  }
  validation.assignee = assignee;

  // 2) the story: exists, IS a User Story, iteration/area re-read fresh
  //    (never from the spec).
  let story = { id: spec.storyId };
  try {
    const wi = await adapter.getWorkItem(spec.storyId, { expand: 'all' });
    const f = (wi && wi.fields) || {};
    story = {
      id: spec.storyId,
      type: f['System.WorkItemType'] || null,
      title: f['System.Title'] || null,
      state: f['System.State'] || null,
      iterationPath: f['System.IterationPath'] || null,
      areaPath: f['System.AreaPath'] || null,
      url: webUrl(adapter, spec.storyId),
    };
    if (story.type !== 'User Story') {
      blocked.push({
        reason: 'story-not-a-user-story', story: spec.storyId,
        message: `#${spec.storyId} is a "${story.type || '?'}", not a User Story — test cases are designed against User Stories`,
      });
    }
  } catch (e) {
    blocked.push({ reason: 'story-not-found', story: spec.storyId, message: `story #${spec.storyId} could not be read: ${e.message}` });
  }
  validation.story = story;

  // 3) per case: title checks + in-spec uniqueness + the board duplicate-title
  //    check (FAILS CLOSED) + step structure -> Steps XML.
  const seen = new Map();
  const perCase = [];
  for (const c of spec.cases) {
    const entry = { title: (c && c.title) || null };
    if (!c || typeof c.title !== 'string' || !c.title.trim()) {
      blocked.push({ reason: 'bad-title', title: entry.title, message: 'every case needs a non-empty title' });
      perCase.push(entry);
      continue;
    }
    if (seen.has(c.title)) {
      blocked.push({ reason: 'duplicate-title-in-spec', title: c.title, message: `"${c.title}" appears more than once in the spec — one test case per condition` });
    }
    seen.set(c.title, true);
    try {
      const dupes = await adapter.findByTitle('Test Case', c.title);
      entry.duplicates = dupes;
      if (dupes.length && !args['allow-duplicate']) {
        blocked.push({
          reason: 'duplicate-title', title: c.title, ids: dupes,
          message: `${dupes.length} existing Test Case(s) share this exact title (#${dupes.join(', #')}) — confirm with the user, then pass --allow-duplicate`,
        });
      }
    } catch (e) {
      blocked.push({ reason: 'dup-check-failed', title: c.title, message: `duplicate check failed — refusing to create blind (fails closed): ${e.message}` });
    }
    entry.stepsXml = checkSteps(c, blocked);
    if (entry.stepsXml) entry.steps = c.steps.length;
    perCase.push(entry);
  }
  validation.cases = perCase.map(({ stepsXml, ...rest }) => rest);

  // 4) field cache (Test Case type merged additively) + existence validation
  //    for the fields this flow uniquely sends.
  let cacheInfo = null; let fieldMap = {};
  try {
    cacheInfo = await fieldCache.ensure(cwd, adapter, { types: ['Test Case'], refresh: Boolean(args['refresh-fields']) });
    fieldMap = (cacheInfo.cache.types['Test Case'] && cacheInfo.cache.types['Test Case'].fields) || {};
  } catch (e) {
    blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
  }
  const toValidate = [{ field: STEPS_FIELD, value: '<steps/>' }];
  if (cacheInfo) {
    const results = fieldCache.validateValues(cacheInfo.cache, 'Test Case', toValidate);
    validation.fields = results;
    for (const r of results) {
      if (r.ok) continue;
      blocked.push({
        reason: r.reason, field: r.field, value: r.value,
        ...(r.allowedValues ? { allowedValues: r.allowedValues } : {}),
        message: r.reason === 'field-not-on-type'
          ? `field ${r.field} does not exist on this project's Test Case type — it cannot be emitted blind`
          : `"${r.value}" is not a valid value for ${r.field} — valid: ${r.allowedValues.join(' | ')}`,
      });
    }
  }

  // The fields each create sends: iteration/area are the STORY'S, always.
  const fieldsFor = (c, stepsXml) => ({
    'System.Title': c.title,
    [STEPS_FIELD]: stepsXml,
    ...(story.iterationPath ? { 'System.IterationPath': story.iterationPath } : {}),
    ...(story.areaPath ? { 'System.AreaPath': story.areaPath } : {}),
    'System.AssignedTo': assignee,
  });

  // 5) ONE representative server-side validateOnly probe (the first case) —
  //    dry run only; the real creates carry the same validation server-side.
  if (!args.execute && blocked.length === 0 && adapter.capabilities.validateOnly) {
    try {
      await adapter.createWorkItem('Test Case', {
        fields: fieldsFor(spec.cases[0], perCase[0].stepsXml),
        relations: [{ rel: TESTED_BY_LINK, targetId: spec.storyId }],
      }, { validateOnly: true, execute: true });
      validation.validateOnly = 'passed';
    } catch (e) {
      // The server rejected what the cache accepted — re-fetch the REAL current
      // field map live (no error-prose parsing, no cache write, no retry).
      const staleFields = [];
      try {
        const live = await fieldCache.liveFieldMap(adapter, 'Test Case');
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

  return { blocked, validation, perCase, fieldsFor, cacheInfo, cacheStale };
}

// ---- main ---------------------------------------------------------------------
// Returns { code, out }; prints nothing. opts.fetch is the offline-test seam.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const mode = args.execute ? 'executed' : 'plan';
  try {
    if (cmd === 'story') {
      if (!args.id) return { code: 2, out: { ok: false, error: { message: `--id is required. ${USAGE}` } } };
      const adapter = resolveTracker(cwd, { fetch });
      const wi = await adapter.getWorkItem(args.id, { expand: 'all' });
      const f = (wi && wi.fields) || {};
      const type = f['System.WorkItemType'] || null;
      if (type !== 'User Story') {
        return { code: 1, out: { ok: false, error: { message: `#${args.id} is a "${type || '?'}", not a User Story — ask the user for a valid story id` } } };
      }
      return {
        code: 0,
        out: {
          ok: true,
          story: {
            id: wi.id,
            type,
            title: f['System.Title'] || null,
            state: f['System.State'] || null,
            iterationPath: f['System.IterationPath'] || null,
            areaPath: f['System.AreaPath'] || null,
            url: webUrl(adapter, wi.id),
            description: f['System.Description'] || null,
            acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || null,
            relations: wi.relations || [],
          },
        },
      };
    }

    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: `--spec <file.json> is required. ${USAGE}` } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    const shapeErrors = specShapeErrors(spec);
    if (shapeErrors.length) return { code: 2, out: { ok: false, mode, blocked: shapeErrors } };

    const adapter = resolveTracker(cwd, { fetch });
    const { blocked, validation, perCase, fieldsFor, cacheInfo, cacheStale } = await validate(adapter, spec, args, cwd);
    const cacheOut = cacheInfo
      ? { file: cacheInfo.file, rebuilt: cacheInfo.rebuilt, builtAt: cacheInfo.cache.builtAt, ...(cacheInfo.reason ? { reason: cacheInfo.reason } : {}) }
      : null;

    if (blocked.length) {
      return { code: 2, out: { ok: false, mode, blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}), ...(cacheStale ? { cacheStale: true } : {}) } };
    }

    if (!args.execute) {
      // The PLAN: every intended create, in order, with its exact route —
      // rendered by the agent on the consolidated screen. Nothing has been written.
      const plan = [];
      for (let i = 0; i < spec.cases.length; i++) {
        const c = spec.cases[i];
        const d = await adapter.createWorkItem('Test Case', {
          fields: fieldsFor(c, perCase[i].stepsXml),
          relations: [{ rel: TESTED_BY_LINK, targetId: spec.storyId }],
        }, { execute: false });
        plan.push({
          step: 'create-test-case', title: c.title,
          describe: `${d.method} ${d.url} (${TESTED_BY_LINK} -> story #${spec.storyId} inline — atomic)`,
          request: d,
        });
      }
      return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const createdCases = [];
    const intents = spec.cases.map((c, i) => ({
      step: 'create-test-case',
      describe: `create Test Case "${c.title}" (POST _apis/wit/workitems/$Test Case, Tested By -> story #${spec.storyId} inline)`,
      run: async () => {
        const r = await adapter.createWorkItem('Test Case', {
          fields: fieldsFor(c, perCase[i].stepsXml),
          relations: [{ rel: TESTED_BY_LINK, targetId: spec.storyId }],
        }, { execute: true });
        createdCases.push({ id: r.id, url: r.url, title: c.title });
        return { id: r.id, url: r.url };
      },
    }));

    const ledger = await new WritePlan(intents).execute();
    const allDone = ledger.every((l) => l.status === 'done');
    return {
      code: allDone ? 0 : 1,
      out: {
        ok: allDone,
        mode: 'executed',
        ledger,
        // Created IDs are ALWAYS surfaced, even when a later step threw.
        created: { storyId: spec.storyId, testCases: createdCases },
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

module.exports = { run, buildStepsXml, TESTED_BY_LINK };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
