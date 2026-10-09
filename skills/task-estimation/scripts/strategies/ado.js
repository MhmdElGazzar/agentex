'use strict';
// strategies/ado.js — the Azure DevOps task-estimation strategy (the
// EstimationStrategy contract is documented in ./index.js).
//
// ADO specifics of the flow, all here and nowhere in the create-tasks.js spine:
//   - stories are work items of type 'User Story'; the current sprint is the
//     team's @CurrentIteration('[<project>]\<team>') — the macro needs the TEAM
//     name, so --team (a run-only override; the config is never rewritten,
//     invariant 11) then azure.team resolve it, and no team is an exit-2 error;
//   - each [Testing] task is a 'Task' created with its parent link
//     (System.LinkTypes.Hierarchy-Reverse) inline — one atomic create, an
//     unparented [Testing] task cannot exist;
//   - iteration/area are re-read fresh from the story, never trusted from the
//     spec; existing [Testing] children are the story's Hierarchy-Forward
//     children (a scan that cannot complete fails CLOSED);
//   - fields: Title, IterationPath, AreaPath, AssignedTo, Activity=Testing,
//     OriginalEstimate/RemainingWork = the hours — validated against the field
//     cache (.agentex/cache/tracker-fields-ado.json, Task merged in additively,
//     --refresh-fields rebuilds), then ONE representative server-side
//     validateOnly create (dry run only). If the server rejects what the cache
//     accepted, the REAL current allowedValues are re-read live and returned
//     with cacheStale:true (no error-prose parsing, no cache write, no retry).
//   - message refs render as #<id>.
const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tracker');
const fieldCache = require(path.join(LIB, 'cache.js'));
const { iterationWiql } = require(path.join(LIB, 'adapters', 'ado.js'));
const rules = require('./rules.js');

// The ONLY link this flow creates: Parent, expressed on the child task.
const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse';
const STORY_TYPE = 'User Story';
const CREATE_TYPE = 'Task';
const ACTIVITY_FIELD = 'Microsoft.VSTS.Common.Activity';
const ACTIVITY_VALUE = 'Testing';
const STORY_POINTS_FIELD = 'Microsoft.VSTS.Scheduling.StoryPoints';
const ESTIMATE_FIELDS = ['Microsoft.VSTS.Scheduling.OriginalEstimate', 'Microsoft.VSTS.Scheduling.RemainingWork'];
const formatRef = (id) => `#${id}`;

// PINNED compat name (create-tasks.js re-exports it): the current-sprint WIQL
// for User Stories. The builder itself lives in the ADO adapter.
const currentIterationWiql = (project, team) => iterationWiql(project, team, STORY_TYPE);

// ── stories (read-only) ─────────────────────────────────────────────────────
const parseIds = (csv) => String(csv).split(',').map((s) => s.trim()).filter(Boolean).map(Number);

async function openStoriesRead() { return {}; } // no per-run read context on ADO

async function currentSprint(adapter, args) {
  const team = (typeof args.team === 'string' && args.team.trim()) || adapter.config.team;
  const r = await adapter.listSprintStories({ storyType: STORY_TYPE, team: team || null });
  if (r.ok) return { refs: r.refs };
  if (r.condition === 'team-required') {
    return {
      stop: {
        code: 2,
        out: {
          ok: false,
          error: {
            message: 'No team resolved — the @CurrentIteration macro needs the TEAM name, not just the project. ' +
              'Pass --team "<name>" for this run, or set azure.team in config/project.json (legacy AZURE_TEAM in .env).',
          },
        },
      },
    };
  }
  throw new Error(`unexpected sprint-read condition '${r.condition}' from the ADO adapter`);
}

async function readStory(adapter, ref) {
  const story = await adapter.getStory(ref);
  const f = (story.raw && story.raw.fields) || {};
  return { ...story, isStory: story.type === STORY_TYPE, storyPoints: f[STORY_POINTS_FIELD] ?? null };
}

// Existing [Testing] children; rejects when the scan cannot complete.
async function testingChildren(adapter, story) {
  return (await adapter.listChildren(story)).filter((c) => rules.isTestingTitle(c.title));
}

// The stories[] row. Key order is the contract: description/acceptanceCriteria
// (--full) BEFORE existingTestingTasks; a type warning takes its position first
// and a later scan failure overwrites it in place.
function storyRow(story, { ref, children, childrenError, full }) {
  const wi = story.raw;
  const f = (wi && wi.fields) || {};
  const s = {
    id: wi.id,
    type: f['System.WorkItemType'] || null,
    title: f['System.Title'] || null,
    state: f['System.State'] || null,
    storyPoints: f[STORY_POINTS_FIELD] ?? null,
    iterationPath: f['System.IterationPath'] || null,
    areaPath: f['System.AreaPath'] || null,
    url: story.url,
    ...(full ? {
      description: f['System.Description'] || null,
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || null,
    } : {}),
  };
  if (s.type !== STORY_TYPE) {
    s.warning = `#${ref} is a "${s.type || '?'}", not a User Story — the dry run will refuse to create tasks under it`;
  }
  if (childrenError) {
    s.existingTestingTasks = null;
    s.warning = `existing-children scan failed: ${childrenError.message} — the dry run will block on this story (fails closed)`;
  } else {
    s.existingTestingTasks = children;
  }
  return s;
}

// ── validation (dry run and the pre-write guard) ────────────────────────────
// Reads + local checks only — NOTHING here writes to the board. All findings
// are accumulated and returned at once, in this order: assignee → structural →
// per story (type, children) → cache values → validateOnly.
async function validate(adapter, spec, args, cwd) {
  const cfg = adapter.config;
  const validation = {};
  let cacheStale = false;

  // 1) assignee: spec -> a single configured azure.assignee — never invented.
  const { assignee, blocked } = rules.resolveAssignee({ spec, configured: cfg.assignees || [], configKey: 'azure.assignee' });
  validation.assignee = assignee;

  // 2) structural: title prefix + finite positive estimate, every finding at once.
  blocked.push(...rules.structuralBlocks(spec, formatRef));

  // 3) per story: exists, IS a User Story, iteration/area re-read fresh (never
  //    from the spec), existing [Testing] children (fails CLOSED on scan failure).
  const perStory = [];
  for (const st of spec.stories) {
    const entry = { id: st.id, ...(st.complexity ? { complexity: st.complexity } : {}), tasks: (st.tasks || []).length };
    try {
      const story = await readStory(adapter, st.id);
      const f = (story.raw && story.raw.fields) || {};
      entry.type = story.type;
      entry.title = story.title;
      entry.state = story.state;
      entry.iterationPath = f['System.IterationPath'] || null;
      entry.areaPath = f['System.AreaPath'] || null;
      entry.url = adapter.webUrl(st.id); // the SPEC id, as always
      if (!story.isStory) {
        blocked.push({
          reason: 'story-not-a-user-story', story: st.id,
          message: `#${st.id} is a "${entry.type || '?'}", not a User Story — [Testing] tasks hang only off User Stories`,
        });
      }
      try {
        entry.existingTestingTasks = await testingChildren(adapter, story);
        if (entry.existingTestingTasks.length && !args['allow-existing']) {
          blocked.push(rules.existingTasksBlock({ storyId: st.id, tasks: entry.existingTestingTasks, formatRef, taskNoun: 'task' }));
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
    cacheInfo = await fieldCache.ensure(cwd, adapter, { types: [CREATE_TYPE], refresh: Boolean(args['refresh-fields']) });
    fieldMap = (cacheInfo.cache.types[CREATE_TYPE] && cacheInfo.cache.types[CREATE_TYPE].fields) || {};
  } catch (e) {
    blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
  }

  const firstTask = spec.stories[0] && spec.stories[0].tasks && spec.stories[0].tasks[0];
  const toValidate = [
    { field: ACTIVITY_FIELD, value: ACTIVITY_VALUE },
    ...ESTIMATE_FIELDS.map((field) => ({ field, value: Number(firstTask && firstTask.estimate) })),
  ];
  if (cacheInfo) {
    const results = fieldCache.validateValues(cacheInfo.cache, CREATE_TYPE, toValidate);
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
      await adapter.createWorkItem(CREATE_TYPE, {
        fields: fieldsFor(perStory[0], firstTask),
        relations: [{ rel: PARENT_LINK, targetId: spec.stories[0].id }],
      }, { validateOnly: true, execute: true });
      validation.validateOnly = 'passed';
    } catch (e) {
      // The server rejected what the cache accepted — re-fetch the REAL current
      // allowedValues live (no error-prose parsing, no cache write, no retry).
      const staleFields = [];
      try {
        const live = await fieldCache.liveFieldMap(adapter, CREATE_TYPE);
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

  return {
    blocked, validation, cacheInfo, cacheStale,
    createType: CREATE_TYPE,
    parentRel: PARENT_LINK,
    fieldsFor,
    describeCreate: (task, storyId) => `create "${task.title}" under story #${storyId} (POST _apis/wit/workitems/$Task, parent link inline)`,
    followUp: null,
  };
}

module.exports = {
  provider: 'ado',
  parseIds, openStoriesRead, currentSprint, readStory, testingChildren, storyRow, validate,
  // compat (re-exported by create-tasks.js)
  PARENT_LINK, currentIterationWiql,
};
