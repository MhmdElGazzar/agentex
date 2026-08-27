#!/usr/bin/env node
// create-tasks.js — the task-estimation flow's mechanics: read the sprint's
// User Stories (or explicitly named ones), then validate EVERYTHING first
// (zero board writes) and — only behind --execute — create the [Testing] tasks,
// one atomic create per task with the parent link inline, behind an exact
// per-write ledger.
//
// Built on the tracker layer (scripts/lib/tracker/): direct ADO REST over
// Node's built-in fetch. No az CLI, no process spawning, zero npm dependencies.
// The PAT is read from .env by the adapter (AZURE_PAT, legacy
// AZURE_DEVOPS_EXT_PAT / AZURE_DEVOPS_PAT) and sent only in the Authorization
// header — never printed, logged, or placed on a command line (invariant 5).
//
// READS (free, no gating — `stories` has no --execute surface at all):
//   node create-tasks.js stories --current-sprint [--team "<name>"] [--full]
//   node create-tasks.js stories --ids 12345,12346 [--full]
//     --current-sprint composes WIQL with @CurrentIteration('[<project>]\<team>')
//     (the macro needs the TEAM name, not just the project); --team is a
//     run-only override — the consumer's config is never rewritten (invariant 11).
//     Per story: id/title/state/storyPoints/iterationPath/areaPath/url,
//     existingTestingTasks (children titled [Testing]…), and with --full the
//     description + acceptance-criteria HTML for the agent's factor analysis.
//
// DRY RUN (default) — the validation gate behind the skill's ONE approval:
//   node create-tasks.js --spec <file.json> [--allow-existing] [--refresh-fields]
//     Per story: exists and IS a User Story (fails closed); iteration/area are
//     re-read fresh from the story — never trusted from the spec; existing
//     [Testing] children block without --allow-existing, and a children check
//     that cannot complete blocks too (fails CLOSED). Structural: every task
//     title starts with "[Testing] ", every estimate is a finite number > 0,
//     the assignee comes from the spec or a single-valued azure.assignee —
//     never invented. Field values are validated against the project's field
//     cache (.agentex/cache/tracker-fields-ado.json, Task type merged in
//     additively, --refresh-fields rebuilds), then ONE representative
//     server-side validateOnly create proves field shape + assignee identity.
//     If the server rejects what the cache accepted, the REAL current
//     allowedValues are re-fetched live and returned with cacheStale:true.
//
// --execute — one WritePlan of the story-ordered task intents, one atomic
//   create per task (fields + the inline parent relation — an unparented
//   [Testing] task cannot exist). First failure stops; the ledger reports every
//   intended task as done (id + url) or not-done (reason); created IDs are in
//   the JSON even when a later step throws. No auto-retry, no cleanup writes.
//
// Spec JSON shape (written by the agent to the OS temp dir):
//   { "assignee": "qa.engineer@example.com",
//     "stories": [ { "id": 12345, "complexity": "Simple",
//                    "tasks": [ { "title": "[Testing] Requirement Review", "estimate": 1 }, … ] } ] }
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

// The ONLY link this script creates: Parent, expressed on the child task.
const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse';
const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward'; // read-only: the existing-children scan
const TITLE_PREFIX = '[Testing] ';
const ACTIVITY_FIELD = 'Microsoft.VSTS.Common.Activity';
const ACTIVITY_VALUE = 'Testing';
const ESTIMATE_FIELDS = ['Microsoft.VSTS.Scheduling.OriginalEstimate', 'Microsoft.VSTS.Scheduling.RemainingWork'];

const wiqlEsc = (s) => String(s).replace(/'/g, "''");

// PINNED: the current-sprint WIQL uses the @CurrentIteration macro WITH the
// team argument — '[<project>]\<team>' — on the project-scoped wiql route (the
// same server-side WIQL engine the old CLI-driven flow queried; live
// verification of the macro-with-argument form is deferred to the release
// smoke). This function is the one place the macro lives; the sibling test
// pins its exact shape.
function currentIterationWiql(project, team) {
  return (
    'SELECT [System.Id] FROM workitems' +
    ` WHERE [System.WorkItemType]='User Story'` +
    ` AND [System.TeamProject]='${wiqlEsc(project)}'` +
    ` AND [System.IterationPath] = @CurrentIteration('[${wiqlEsc(project)}]\\${wiqlEsc(team)}')` +
    ' ORDER BY [System.Id]'
  );
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
  'usage: create-tasks.js stories --current-sprint [--team <name>] [--full] | stories --ids <id,id> [--full]' +
  ' | create-tasks.js --spec <file.json> [--allow-existing] [--refresh-fields] [--execute]';

const webUrl = (adapter, id) =>
  `${adapter.config.base}/${encodeURIComponent(adapter.config.project)}/_workitems/edit/${id}`;

// Existing-children scan: Hierarchy-Forward relations -> per-child read ->
// the children whose title starts with [Testing]. THROWS when any child read
// fails — callers decide (stories: a warning; dry run: blocked, fails CLOSED).
async function scanTestingChildren(adapter, wi) {
  const rels = (wi.relations || []).filter((r) => r.rel === CHILD_LINK);
  const found = [];
  for (const r of rels) {
    const m = String(r.url || '').match(/\/(\d+)$/);
    if (!m) continue;
    const child = await adapter.getWorkItem(m[1]);
    const f = (child && child.fields) || {};
    const title = f['System.Title'] || '';
    if (title.startsWith('[Testing]')) {
      found.push({ id: child.id, title, state: f['System.State'] || null });
    }
  }
  return found;
}

function storySummary(adapter, wi, { full = false } = {}) {
  const f = (wi && wi.fields) || {};
  return {
    id: wi.id,
    type: f['System.WorkItemType'] || null,
    title: f['System.Title'] || null,
    state: f['System.State'] || null,
    storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? null,
    iterationPath: f['System.IterationPath'] || null,
    areaPath: f['System.AreaPath'] || null,
    url: webUrl(adapter, wi.id),
    ...(full ? {
      description: f['System.Description'] || null,
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || null,
    } : {}),
  };
}

// ---- stories (read-only; there is no --execute path here) --------------------
async function storiesCmd(args, adapter) {
  let ids;
  if (args.ids) {
    ids = String(args.ids).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  } else if (args['current-sprint']) {
    const team = (typeof args.team === 'string' && args.team.trim()) || adapter.config.team;
    if (!team) {
      return {
        code: 2,
        out: {
          ok: false,
          error: {
            message: 'No team resolved — the @CurrentIteration macro needs the TEAM name, not just the project. ' +
              'Pass --team "<name>" for this run, or set azure.team in config/project.json (legacy AZURE_TEAM in .env).',
          },
        },
      };
    }
    const res = await adapter.query(currentIterationWiql(adapter.config.project, team));
    const rows = Array.isArray(res) ? res : (res && res.workItems) || [];
    ids = rows.map((w) => w.id).filter((id) => id !== undefined && id !== null);
  } else {
    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  }

  const stories = [];
  for (const id of ids) {
    try {
      const wi = await adapter.getWorkItem(id, { expand: 'all' });
      const s = storySummary(adapter, wi, { full: Boolean(args.full) });
      if (s.type !== 'User Story') {
        s.warning = `#${id} is a "${s.type || '?'}", not a User Story — the dry run will refuse to create tasks under it`;
      }
      try {
        s.existingTestingTasks = await scanTestingChildren(adapter, wi);
      } catch (e) {
        s.existingTestingTasks = null;
        s.warning = `existing-children scan failed: ${e.message} — the dry run will block on this story (fails closed)`;
      }
      stories.push(s);
    } catch (e) {
      stories.push({ id, warning: `could not be read: ${e.message}` });
    }
  }
  return { code: 0, out: { ok: true, mode: 'stories', count: stories.length, stories } };
}

// ---- spec structural checks (before any read) ---------------------------------
function specShapeErrors(spec) {
  const blocked = [];
  if (!Array.isArray(spec.stories) || spec.stories.length === 0) {
    blocked.push({ reason: 'missing-required-field', field: 'stories', message: 'spec.stories must be a non-empty array' });
    return blocked;
  }
  spec.stories.forEach((st, i) => {
    if (!st || st.id === undefined || st.id === null || st.id === '') {
      blocked.push({ reason: 'missing-required-field', field: `stories[${i}].id`, message: `spec.stories[${i}].id is required` });
    }
    if (!Array.isArray(st.tasks) || st.tasks.length === 0) {
      blocked.push({ reason: 'missing-required-field', field: `stories[${i}].tasks`, message: `spec.stories[${i}].tasks must be a non-empty array` });
    }
  });
  return blocked;
}

// ---- validation phase (shared by dry run and the pre-write guard) -------------
// Reads + local checks only — NOTHING here writes to the board. All findings
// are accumulated and returned at once.
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

  // 2) structural: title prefix + finite positive estimate, every finding at once.
  for (const st of spec.stories) {
    for (const task of st.tasks) {
      const title = task && task.title;
      if (typeof title !== 'string' || !title.startsWith(TITLE_PREFIX)) {
        blocked.push({
          reason: 'bad-task-title', story: st.id, title: title ?? null,
          message: `story #${st.id}: task title ${JSON.stringify(title ?? null)} must start with "${TITLE_PREFIX}"`,
        });
      }
      const est = Number(task && task.estimate);
      if (!Number.isFinite(est) || est <= 0) {
        blocked.push({
          reason: 'bad-estimate', story: st.id, title: title ?? null, estimate: (task && task.estimate) ?? null,
          message: `story #${st.id}: "${title}" needs a finite estimate > 0 (got ${JSON.stringify((task && task.estimate) ?? null)})`,
        });
      }
    }
  }

  // 3) per story: exists, IS a User Story, iteration/area re-read fresh (never
  //    from the spec), existing [Testing] children (fails CLOSED on scan failure).
  const perStory = [];
  for (const st of spec.stories) {
    const entry = { id: st.id, ...(st.complexity ? { complexity: st.complexity } : {}), tasks: (st.tasks || []).length };
    try {
      const wi = await adapter.getWorkItem(st.id, { expand: 'all' });
      const f = (wi && wi.fields) || {};
      entry.type = f['System.WorkItemType'] || null;
      entry.title = f['System.Title'] || null;
      entry.state = f['System.State'] || null;
      entry.iterationPath = f['System.IterationPath'] || null;
      entry.areaPath = f['System.AreaPath'] || null;
      entry.url = webUrl(adapter, st.id);
      if (entry.type !== 'User Story') {
        blocked.push({
          reason: 'story-not-a-user-story', story: st.id,
          message: `#${st.id} is a "${entry.type || '?'}", not a User Story — [Testing] tasks hang only off User Stories`,
        });
      }
      try {
        entry.existingTestingTasks = await scanTestingChildren(adapter, wi);
        if (entry.existingTestingTasks.length && !args['allow-existing']) {
          blocked.push({
            reason: 'existing-testing-tasks', story: st.id,
            ids: entry.existingTestingTasks.map((t) => t.id),
            message: `story #${st.id} already has ${entry.existingTestingTasks.length} [Testing] task(s) ` +
              `(#${entry.existingTestingTasks.map((t) => t.id).join(', #')}) — ask the user: skip = drop the story from the spec; add anyway = pass --allow-existing`,
          });
        }
      } catch (e) {
        blocked.push({
          reason: 'children-check-failed', story: st.id,
          message: `the existing-children check on #${st.id} could not complete — refusing to create blind (fails closed): ${e.message}`,
        });
      }
    } catch (e) {
      blocked.push({ reason: 'story-not-found', story: st.id, message: `story #${st.id} could not be read: ${e.message}` });
    }
    perStory.push(entry);
  }
  validation.perStory = perStory;

  // 4) field cache (Task type merged additively) + value/existence validation.
  let cacheInfo = null; let fieldMap = {};
  try {
    cacheInfo = await fieldCache.ensure(cwd, adapter, { types: ['Task'], refresh: Boolean(args['refresh-fields']) });
    fieldMap = (cacheInfo.cache.types.Task && cacheInfo.cache.types.Task.fields) || {};
  } catch (e) {
    blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
  }

  const firstTask = spec.stories[0] && spec.stories[0].tasks && spec.stories[0].tasks[0];
  const toValidate = [
    { field: ACTIVITY_FIELD, value: ACTIVITY_VALUE },
    ...ESTIMATE_FIELDS.map((field) => ({ field, value: Number(firstTask && firstTask.estimate) })),
  ];
  if (cacheInfo) {
    const results = fieldCache.validateValues(cacheInfo.cache, 'Task', toValidate);
    validation.fields = results;
    for (const r of results) {
      if (r.ok) continue;
      blocked.push({
        reason: r.reason, field: r.field, value: r.value,
        ...(r.allowedValues ? { allowedValues: r.allowedValues } : {}),
        message: r.reason === 'field-not-on-type'
          ? `field ${r.field} does not exist on this project's Task type — it cannot be emitted blind`
          : `"${r.value}" is not a valid value for ${r.field} — valid: ${r.allowedValues.join(' | ')}`,
      });
    }
  }

  // The fields each create sends: iteration/area are the STORY'S, always.
  const fieldsFor = (entry, task) => ({
    'System.Title': task.title,
    ...(entry.iterationPath ? { 'System.IterationPath': entry.iterationPath } : {}),
    ...(entry.areaPath ? { 'System.AreaPath': entry.areaPath } : {}),
    'System.AssignedTo': assignee,
    [ACTIVITY_FIELD]: ACTIVITY_VALUE,
    'Microsoft.VSTS.Scheduling.OriginalEstimate': Number(task.estimate),
    'Microsoft.VSTS.Scheduling.RemainingWork': Number(task.estimate),
  });

  // 5) ONE representative server-side validateOnly probe (first task of the
  //    first story) — dry run only; the real creates carry the same validation
  //    server-side during --execute.
  if (!args.execute && blocked.length === 0 && adapter.capabilities.validateOnly) {
    try {
      await adapter.createWorkItem('Task', {
        fields: fieldsFor(perStory[0], firstTask),
        relations: [{ rel: PARENT_LINK, targetId: spec.stories[0].id }],
      }, { validateOnly: true, execute: true });
      validation.validateOnly = 'passed';
    } catch (e) {
      // The server rejected what the cache accepted — re-fetch the REAL current
      // allowedValues live (no error-prose parsing, no cache write, no retry).
      const staleFields = [];
      try {
        const live = await fieldCache.liveFieldMap(adapter, 'Task');
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

  return { blocked, validation, assignee, fieldsFor, cacheInfo, cacheStale };
}

// ---- main ---------------------------------------------------------------------
// Returns { code, out }; prints nothing. opts.fetch is the offline-test seam.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const mode = args.execute ? 'executed' : 'plan';
  try {
    if (cmd === 'stories') {
      return await storiesCmd(args, resolveTracker(cwd, { fetch }));
    }

    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: `--spec <file.json> is required. ${USAGE}` } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    const shapeErrors = specShapeErrors(spec);
    if (shapeErrors.length) return { code: 2, out: { ok: false, mode, blocked: shapeErrors } };

    const adapter = resolveTracker(cwd, { fetch });
    const { blocked, validation, fieldsFor, cacheInfo, cacheStale } = await validate(adapter, spec, args, cwd);
    const cacheOut = cacheInfo
      ? { file: cacheInfo.file, rebuilt: cacheInfo.rebuilt, builtAt: cacheInfo.cache.builtAt, ...(cacheInfo.reason ? { reason: cacheInfo.reason } : {}) }
      : null;

    if (blocked.length) {
      return { code: 2, out: { ok: false, mode, blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}), ...(cacheStale ? { cacheStale: true } : {}) } };
    }

    // The story-ordered flat task list — the same order plans and executes.
    const entryById = new Map(validation.perStory.map((e) => [e.id, e]));
    const flat = [];
    for (const st of spec.stories) {
      for (const task of st.tasks) flat.push({ storyId: st.id, entry: entryById.get(st.id), task });
    }

    if (!args.execute) {
      // The PLAN: every intended create, in order, with its exact route —
      // rendered by the agent on the consolidated screen. Nothing has been written.
      const plan = [];
      for (const { storyId, entry, task } of flat) {
        const d = await adapter.createWorkItem('Task', {
          fields: fieldsFor(entry, task),
          relations: [{ rel: PARENT_LINK, targetId: storyId }],
        }, { execute: false });
        plan.push({
          step: 'create-task', story: storyId, title: task.title,
          describe: `${d.method} ${d.url} (${PARENT_LINK} -> #${storyId} inline — atomic)`,
          request: d,
        });
      }
      return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const createdTasks = [];
    const intents = flat.map(({ storyId, entry, task }) => ({
      step: 'create-task',
      describe: `create "${task.title}" under story #${storyId} (POST _apis/wit/workitems/$Task, parent link inline)`,
      run: async () => {
        const r = await adapter.createWorkItem('Task', {
          fields: fieldsFor(entry, task),
          relations: [{ rel: PARENT_LINK, targetId: storyId }],
        }, { execute: true });
        createdTasks.push({ id: r.id, url: r.url, storyId, title: task.title });
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
        created: { tasks: createdTasks },
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

module.exports = { run, currentIterationWiql, PARENT_LINK };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
