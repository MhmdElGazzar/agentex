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
const adf = require(path.join(LIB, 'adf.js'));

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

// Per-case step validation — every finding at once; shared by both providers.
function stepsShapeOk(c, blocked) {
  if (!Array.isArray(c.steps) || c.steps.length === 0) {
    blocked.push({ reason: 'bad-steps', title: c.title, message: `"${c.title}": steps must be a non-empty array` });
    return false;
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
  return ok;
}

function checkSteps(c, blocked) {
  return stepsShapeOk(c, blocked) ? buildStepsXml(c.steps) : null;
}

// Jira artifact bodies: the structured steps render as an ADF ordered list
// (action → expected) in the artifact's description — composed here from the
// structured spec data via the adf.js builders (§5.5); never hand-written ADF.
function buildStepsAdf(steps) {
  return adf.doc(adf.orderedList(steps.map((s) =>
    s.type === 'validate' ? `${s.text} — Expected: ${s.expected}` : s.text)));
}

function checkStepsAdf(c, blocked) {
  return stepsShapeOk(c, blocked) ? buildStepsAdf(c.steps) : null;
}

/* ════ Jira artifact path (design §5.8 / Q11) — the ADO path below is untouched ═
 * Jira has no native Test Case type: /design-test informs the user and asks
 * what to create BEFORE any spec exists; the spec carries that choice as
 * `artifactType` and this script NEVER defaults it. Steps render as an ADF
 * ordered list in the artifact's description; a non-sub-task artifact links
 * back to the story via an issue link (the configured/chosen link type, a
 * SEPARATE planned intent); a sub-task artifact folds the parent into its
 * create (the relations.parent seam). testedBy is never emitted on Jira
 * (capabilities.relations.testedBy: false).
 */
async function runJiraSpec(adapter, spec, args, cwd) {
  const mode = args.execute ? 'executed' : 'plan';
  const cfg = adapter.config;
  const blocked = [];
  const validation = {};

  // 1) assignee: spec -> a single configured jira.assignee, then email ->
  //    accountId via ONE user-search read (O5) — fail closed, never invented.
  const configured = cfg.assignees || [];
  const assignee = (spec.assignee && String(spec.assignee).trim()) ||
    (configured.length === 1 ? configured[0] : null);
  if (!assignee) {
    blocked.push({
      reason: 'missing-assignee',
      ...(configured.length > 1 ? { options: configured } : {}),
      message: configured.length > 1
        ? `spec.assignee is empty and jira.assignee lists ${configured.length} options (${configured.join(', ')}) — ask the user which one, never pick silently`
        : 'no assignee — set spec.assignee (ask the user) or jira.assignee in config/project.json',
    });
  }
  validation.assignee = assignee;
  let accountId = null;
  if (assignee) {
    try {
      const users = await adapter.findUser(assignee);
      const exact = users.filter((u) => String(u.emailAddress || '').toLowerCase() === assignee.toLowerCase());
      const pool = exact.length ? exact : users;
      if (pool.length === 1) accountId = pool[0].accountId;
      else {
        blocked.push({
          reason: pool.length === 0 ? 'assignee-not-found' : 'assignee-ambiguous',
          ...(pool.length ? { options: pool.map((u) => ({ accountId: u.accountId, displayName: u.displayName })) } : {}),
          message: pool.length === 0
            ? `no Jira user matches "${assignee}" — Jira assigns by accountId, so an unresolvable email blocks (fails closed)`
            : `${pool.length} Jira users match "${assignee}" — ask the user which accountId, never pick silently`,
        });
      }
    } catch (e) {
      blocked.push({ reason: 'assignee-resolution-failed', message: `the email→accountId read failed — refusing to assign blind (fails closed): ${e.message}` });
    }
  }
  validation.assigneeAccountId = accountId;

  // 2) the story: exists and IS the configured story type.
  let storyKey = spec.storyId;
  try {
    const wi = await adapter.getWorkItem(spec.storyId);
    const f = (wi && wi.fields) || {};
    storyKey = wi.key || spec.storyId;
    validation.story = {
      id: storyKey,
      type: (f.issuetype || {}).name || null,
      title: f.summary || null,
      state: (f.status || {}).name || null,
      url: adapter.webUrl(storyKey),
    };
    if (validation.story.type !== cfg.storyType) {
      blocked.push({
        reason: 'story-not-a-story', story: spec.storyId,
        message: `${spec.storyId} is a "${validation.story.type || '?'}", not a "${cfg.storyType}" — test artifacts are designed against ${cfg.storyType} issues`,
      });
    }
  } catch (e) {
    blocked.push({ reason: 'story-not-found', story: spec.storyId, message: `story ${spec.storyId} could not be read: ${e.message}` });
  }

  // 3) the Q11 artifact choice — REQUIRED and validated against the REAL types.
  let issueTypes = [];
  try { issueTypes = await adapter.listIssueTypes(); }
  catch (e) { blocked.push({ reason: 'issue-types-unavailable', message: `the project's issue types could not be read: ${e.message}` }); }
  let artifact = null;
  if (!spec.artifactType) {
    blocked.push({
      reason: 'missing-artifact-type',
      options: issueTypes.map((t) => (t.subtask ? `${t.name} (sub-task)` : t.name)),
      message: 'Jira has no native Test Case type — the skill informs the user and asks what to create (Q11); ' +
        'the spec carries that choice as artifactType, and this script never defaults it',
    });
  } else {
    artifact = issueTypes.find((t) => t.name === spec.artifactType) ||
      issueTypes.find((t) => t.name.toLowerCase() === String(spec.artifactType).toLowerCase());
    if (!artifact && issueTypes.length) {
      blocked.push({
        reason: 'artifact-type-not-found', options: issueTypes.map((t) => t.name),
        message: `artifactType "${spec.artifactType}" is not one of this project's issue types (${issueTypes.map((t) => t.name).join(', ')}) — the Q11 choice must be one of them`,
      });
    }
  }
  validation.artifactType = artifact ? artifact.name : (spec.artifactType || null);
  const isSubtask = Boolean(artifact && artifact.subtask);

  // 4) the story link (non-sub-task artifacts): configured/chosen, options live,
  //    Relates recommended (A-3) — never invented.
  let linkType = null;
  if (artifact && !isSubtask) {
    linkType = (spec.linkType && String(spec.linkType).trim()) || cfg.bugLinkType || null;
    let liveTypes = null;
    try { liveTypes = (await adapter.listLinkTypes()).map((l) => l.name); } catch { /* options unavailable */ }
    if (!linkType) {
      blocked.push({
        reason: 'missing-link-type',
        ...(liveTypes ? { options: liveTypes } : {}),
        message: 'no link type chosen — the artifact links back to the story via an issue link; ' +
          'ask the user which type ("Relates" is the recommended default) or set jira.bugLinkType in config/project.json',
      });
    } else if (liveTypes && !liveTypes.includes(linkType)) {
      blocked.push({
        reason: 'link-type-not-found', options: liveTypes,
        message: `link type "${linkType}" is not one of this site's issue link types (${liveTypes.join(', ')}) — never invented`,
      });
    }
  }
  validation.linkType = linkType;

  // 5) per case: title checks + in-spec uniqueness + the exact-title dup check
  //    (FAILS CLOSED) + steps -> ADF.
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
      blocked.push({ reason: 'duplicate-title-in-spec', title: c.title, message: `"${c.title}" appears more than once in the spec — one artifact per condition` });
    }
    seen.set(c.title, true);
    try {
      const dupes = await adapter.findByTitle(validation.artifactType || 'Task', c.title);
      entry.duplicates = dupes;
      if (dupes.length && !args['allow-duplicate']) {
        blocked.push({
          reason: 'duplicate-title', title: c.title, ids: dupes,
          message: `${dupes.length} existing issue(s) share this exact title (${dupes.join(', ')}) — confirm with the user, then pass --allow-duplicate`,
        });
      }
    } catch (e) {
      blocked.push({ reason: 'dup-check-failed', title: c.title, message: `duplicate check failed — refusing to create blind (fails closed): ${e.message}` });
    }
    entry.descriptionAdf = checkStepsAdf(c, blocked);
    if (entry.descriptionAdf) entry.steps = c.steps.length;
    perCase.push(entry);
  }
  validation.cases = perCase.map(({ descriptionAdf, ...rest }) => rest);

  // 6) createmeta cache for the artifact type — the fields this flow sends must
  //    exist on the create screen (no blind emission, no server 400 surprises).
  let cacheInfo = null;
  if (artifact) {
    try {
      cacheInfo = await fieldCache.ensure(cwd, adapter, { types: [artifact.name], refresh: Boolean(args['refresh-fields']) });
      const fieldMap = (cacheInfo.cache.types[artifact.name] && cacheInfo.cache.types[artifact.name].fields) || {};
      if (!fieldMap.description) {
        blocked.push({ reason: 'field-not-on-type', field: 'description', message: `field description does not exist on this project's "${artifact.name}" create screen — the steps list has nowhere to live` });
      }
      if (isSubtask && !fieldMap.parent) {
        blocked.push({ reason: 'field-not-on-type', field: 'parent', message: `field parent does not exist on this project's "${artifact.name}" create screen — a sub-task artifact cannot be created` });
      }
    } catch (e) {
      blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
    }
  }
  validation.validateOnly = 'unsupported-on-jira';

  const cacheOut = cacheInfo
    ? { file: cacheInfo.file, rebuilt: cacheInfo.rebuilt, builtAt: cacheInfo.cache.builtAt, ...(cacheInfo.reason ? { reason: cacheInfo.reason } : {}) }
    : null;
  if (blocked.length) {
    return { code: 2, out: { ok: false, mode, blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}) } };
  }

  const fieldsFor = (c, descriptionAdf) => ({
    summary: c.title,
    description: descriptionAdf,
    ...(accountId ? { assignee: { accountId } } : {}),
  });
  const relationsFor = () => (isSubtask ? { relations: [{ rel: 'parent', targetId: storyKey }] } : {});

  if (!args.execute) {
    const plan = [];
    for (let i = 0; i < spec.cases.length; i++) {
      const c = spec.cases[i];
      const dCreate = await adapter.createWorkItem(artifact.name, {
        fields: fieldsFor(c, perCase[i].descriptionAdf), ...relationsFor(),
      }, { execute: false });
      plan.push({
        step: 'create-artifact', title: c.title,
        describe: `${dCreate.method} ${dCreate.url}${isSubtask ? ` (fields.parent -> ${storyKey} inline — atomic)` : ''}`,
        request: dCreate,
      });
      if (!isSubtask) {
        const dLink = await adapter.addRelation('{new-artifact-key}', linkType, storyKey, { execute: false });
        plan.push({
          step: 'link-artifact', title: c.title,
          describe: `${dLink.method} ${dLink.url} (${linkType} -> story ${storyKey} — a separate write, planned and ledgered)`,
          request: dLink,
        });
      }
    }
    return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
  }

  // ---- WRITE PHASE (only past explicit --execute, i.e. past the ONE approval)
  const createdCases = [];
  const intents = [];
  for (let i = 0; i < spec.cases.length; i++) {
    const c = spec.cases[i];
    let newKey = null;
    intents.push({
      step: 'create-artifact',
      describe: `create ${artifact.name} "${c.title}" (POST /rest/api/3/issue${isSubtask ? ', fields.parent inline' : ''})`,
      run: async () => {
        const r = await adapter.createWorkItem(artifact.name, {
          fields: fieldsFor(c, perCase[i].descriptionAdf), ...relationsFor(),
        }, { execute: true });
        newKey = r.id;
        createdCases.push({ id: r.id, url: r.url, title: c.title });
        return { id: r.id, url: r.url };
      },
    });
    if (!isSubtask) {
      intents.push({
        step: 'link-artifact',
        describe: `link "${c.title}" -> story ${storyKey} (${linkType}, POST /rest/api/3/issueLink)`,
        run: async () => {
          await adapter.addRelation(newKey, linkType, storyKey, { execute: true });
          return { id: newKey };
        },
      });
    }
  }
  const ledger = await new WritePlan(intents).execute();
  const allDone = ledger.every((l) => l.status === 'done');
  return {
    code: allDone ? 0 : 1,
    out: {
      ok: allDone, mode: 'executed', ledger,
      created: { storyId: storyKey, testCases: createdCases },
      ...(cacheOut ? { cache: cacheOut } : {}),
    },
  };
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
      if (adapter.name === 'jira') {
        const wi = await adapter.getWorkItem(args.id);
        const f = (wi && wi.fields) || {};
        const type = (f.issuetype || {}).name || null;
        if (type !== adapter.config.storyType) {
          return { code: 1, out: { ok: false, error: { message: `${args.id} is a "${type || '?'}", not a "${adapter.config.storyType}" — ask the user for a valid story key` } } };
        }
        const rf = wi.renderedFields || {};
        const acField = adapter.config.acceptanceCriteriaField;
        return {
          code: 0,
          out: {
            ok: true,
            story: {
              id: wi.key || args.id,
              type,
              title: f.summary || null,
              state: (f.status || {}).name || null,
              url: adapter.webUrl(wi.key || args.id),
              // Server-rendered HTML — the same shape the agent parses on ADO.
              description: rf.description || null,
              acceptanceCriteria: acField ? (rf[acField] ?? null) : null,
              ...(acField ? {} : { acceptanceCriteriaNote: 'no jira.acceptanceCriteriaField configured — read the ACs from the description' }),
            },
          },
        };
      }
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
    if (adapter.name === 'jira') return await runJiraSpec(adapter, spec, args, cwd);
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
