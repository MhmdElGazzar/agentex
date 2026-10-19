'use strict';
// strategies/jira.js — the Jira task-estimation strategy (Jira design §5.6,
// preserved exactly; the EstimationStrategy contract is documented in ./index.js).
//
// Jira specifics of the flow, all here and nowhere in the create-tasks.js spine:
//   - stories are issues of jira.storyType (default 'Story'); the current
//     sprint is the open-sprint JQL read (`sprint in openSprints()`), which may
//     span several sprints on multi-board projects: --sprint (the run-only
//     answer to the bundled which-sprint ask) restricts it, jira.board steers
//     it through the agile API (O3), otherwise it blocks with the real sprint
//     names — never a silent pick. An empty read blocks with the fix (a
//     kanban/simple board has no sprints, or no sprint is started);
//   - Story Points / Sprint fields are discovered by display name
//     (listAllFields), jira.storyPointsField is the confirmed-once override —
//     never guessed;
//   - verbatim template parity with ADO: the same five [Testing] titles, one
//     atomic sub-task create per task (fields.parent inline via the relations
//     seam), Activity=Testing → the label 'testing', the assignee resolved
//     email → accountId by ONE user-search read (O5), fail closed;
//   - the sub-task type: jira.subtaskType pins it, else exactly one subtask
//     type is used and several join the bundle round;
//   - hours follow what Jira's REST API allows (time tracking is only written
//     where the field is on the screen): 'create' (inline), 'edit-after-create'
//     (create, then ONE update per sub-task — the set-hours follow-up), or
//     'none' (no hours written; the description carries "Estimate: <n>h");
//   - iteration/area have no Jira analog — sub-tasks ride their parent story's
//     sprint, and the plan says so; no validateOnly probe exists on Jira;
//   - message refs render as the bare key.
const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tracker');
const fieldCache = require(path.join(LIB, 'cache.js'));
const { jqlQuote, openSprintJql } = require(path.join(LIB, 'adapters', 'jira.js'));
const rules = require('./rules.js');

const JIRA_SUBTASK_LABELS = ['testing'];
const PARENT_REL = 'parent';
const formatRef = (id) => String(id);

// PINNED compat name (create-tasks.js re-exports it): the current-sprint JQL.
// The builder itself lives in the Jira adapter.
const currentSprintJql = openSprintJql;

// ── stories (read-only) ─────────────────────────────────────────────────────
const parseIds = (csv) => String(csv).split(',').map((s) => s.trim()).filter(Boolean);

// Story Points / Sprint field discovery by display name (listAllFields), with
// jira.storyPointsField as the confirmed-once override — never guessed. Runs
// FIRST on every stories read and never throws.
async function openStoriesRead(adapter) {
  const cfg = adapter.config;
  const out = {
    storyPointsFieldId: null, sprintFieldId: null, storyPointsNote: null,
    storyType: cfg.storyType, acceptanceCriteriaField: cfg.acceptanceCriteriaField,
  };
  let all;
  try { all = await adapter.listAllFields(); }
  catch (e) {
    out.storyPointsNote = `field discovery failed (${e.message}) — storyPoints is null, never guessed`;
    return out;
  }
  if (cfg.storyPointsField) {
    const hit = all.find((f) => f.id === cfg.storyPointsField || f.name === cfg.storyPointsField);
    out.storyPointsFieldId = hit ? hit.id : cfg.storyPointsField; // an explicit id is trusted as-is
  } else {
    const hits = all.filter((f) => f.name === 'Story Points' || f.name === 'Story point estimate');
    if (hits.length === 1) out.storyPointsFieldId = hits[0].id;
    else {
      out.storyPointsNote = hits.length === 0
        ? 'no Story Points field resolved by name — storyPoints is null; set jira.storyPointsField in config/project.json to the field id (never guessed)'
        : `more than one Story Points-like field (${hits.map((h) => h.id).join(', ')}) — storyPoints is null; pin jira.storyPointsField in config/project.json`;
    }
  }
  const sprint = all.find((f) => f.name === 'Sprint');
  out.sprintFieldId = sprint ? sprint.id : null;
  return out;
}

const blockedStories = (blocked) => ({ code: 2, out: { ok: false, mode: 'stories', blocked } });

async function currentSprint(adapter, args, ctx) {
  const cfg = adapter.config;
  // The run-only answer to the bundled which-sprint ask — never persisted.
  const wanted = typeof args.sprint === 'string' && args.sprint.trim() ? args.sprint.trim() : null;
  const r = await adapter.listSprintStories({ storyType: cfg.storyType, sprint: wanted, board: cfg.board, sprintFieldId: ctx.sprintFieldId });
  if (!r.ok) {
    if (r.condition === 'board-not-found') {
      const boards = r.data.boards.map((b) => `${b.name} (id ${b.id})`);
      return { stop: blockedStories([{
        reason: 'board-not-found', options: boards,
        message: `jira.board "${cfg.board}" matches no board of project ${cfg.project} — real boards: ${boards.join(', ') || 'none'}`,
      }]) };
    }
    if (r.condition === 'board-sprint-not-unique') {
      const active = r.data.sprints;
      return { stop: blockedStories([{
        reason: 'multiple-open-sprints', options: active.map((s) => s.name),
        message: `board "${cfg.board}" has ${active.length} active sprints — ask the user which one (the ONE bundled round) and re-run with --sprint "<name>"`,
      }]) };
    }
    if (r.condition === 'multiple-open-sprints') {
      const names = r.data.sprints;
      return { stop: blockedStories([{
        reason: 'multiple-open-sprints', options: [...names].sort(),
        message: `the open-sprint read spans ${names.length} sprints (${[...names].sort().join(', ')}) — ` +
          'ask the user which sprint (the ONE bundled round) and re-run with --sprint "<name>", ' +
          'or set jira.board in config/project.json to steer discovery',
      }]) };
    }
    throw new Error(`unexpected sprint-read condition '${r.condition}' from the Jira adapter`);
  }
  // Runtime discovery of a missing project prerequisite: a kanban/simple board
  // has no sprints, so the open-sprint read comes back empty — say why and how
  // to fix it instead of an empty ok the agent could read as "nothing to do".
  if (!r.refs.length) {
    return { stop: blockedStories([{
      reason: 'no-open-sprint',
      message: `no "${cfg.storyType}" sits in an open sprint of project ${cfg.project}` +
        (wanted ? ` named "${wanted}"` : '') + ' — a kanban/simple board has no sprints, or no sprint is started, ' +
        'or the sprint holds no stories. Fix on Jira: turn Sprints on (team-managed: Project settings → Features → Sprints; ' +
        'company-managed: a Scrum board), then start a sprint holding the stories — or re-run with --ids <KEY,KEY> ' +
        'to estimate named stories. See references/tracker/jira-boards.md, "Project prerequisites".',
    }]) };
  }
  return { refs: r.refs };
}

async function readStory(adapter, ref, ctx) {
  const story = await adapter.getStory(ref);
  const f = (story.raw && story.raw.fields) || {};
  const storyType = ctx && ctx.storyType !== undefined ? ctx.storyType : adapter.config.storyType;
  const spField = ctx ? ctx.storyPointsFieldId : null;
  return { ...story, isStory: story.type === storyType, storyPoints: spField ? (f[spField] ?? null) : null };
}

// Existing [Testing] sub-tasks, straight from fields.subtasks (summaries come
// inline — no per-child reads); rejects when the read carried no subtasks list.
async function testingChildren(adapter, story) {
  return (await adapter.listChildren(story)).filter((c) => rules.isTestingTitle(c.title));
}

// The stories[] row. Key order is the contract: storyPointsNote and url before
// any warning; description/acceptanceCriteria (--full) AFTER existingTestingTasks.
function storyRow(story, { ref, children, childrenError, full }, ctx) {
  const wi = story.raw;
  const f = (wi && wi.fields) || {};
  const s = {
    id: wi.key || ref,
    type: (f.issuetype || {}).name || null,
    title: f.summary || null,
    state: (f.status || {}).name || null,
    storyPoints: story.storyPoints,
    ...(ctx.storyPointsNote ? { storyPointsNote: ctx.storyPointsNote } : {}),
    url: story.url,
  };
  if (s.type !== ctx.storyType) {
    s.warning = `${ref} is a "${s.type || '?'}", not a "${ctx.storyType}" — the dry run will refuse to create sub-tasks under it`;
  }
  s.existingTestingTasks = childrenError ? null : children;
  if (s.existingTestingTasks === null) {
    s.warning = 'existing-children scan could not complete (no subtasks list on the read) — the dry run will block on this story (fails closed)';
  }
  if (full) {
    const rf = wi.renderedFields || {};
    s.description = rf.description || null;
    if (ctx.acceptanceCriteriaField) {
      s.acceptanceCriteria = rf[ctx.acceptanceCriteriaField] ?? null;
    } else {
      s.acceptanceCriteria = null;
      s.acceptanceCriteriaNote = 'no jira.acceptanceCriteriaField configured — read the ACs from the description';
    }
  }
  return s;
}

// ── validation (dry run and the pre-write guard) ────────────────────────────
// Reads + local checks only, every finding at once, in this order: assignee →
// accountId → structural → issue types / sub-task type → per story →
// createmeta fields. No validateOnly probe exists on Jira
// (capabilities.validateOnly: false): the createmeta cache + required-field
// checks carry pre-gate validation alone, and the JSON says so.

// Hours fallback when the sub-task CREATE screen lacks timetracking. Editmeta
// is per issue, so the newest existing sub-task of the type stands in for the
// screen the new ones will get. Anything unknown resolves to 'none' — a write
// that might be refused is never planned on a guess.
const HOURS_DOC = 'see references/tracker/jira-boards.md, "Project prerequisites"';
async function hoursFallback(adapter, subtaskType) {
  const none = (why) => ({
    mode: 'none',
    message: `hours will NOT be written: ${why}. The sub-tasks are created without time tracking and each ` +
      `description carries "Estimate: <n>h". A Jira admin can put the "Time tracking" field on the "${subtaskType}" screen (${HOURS_DOC}).`,
  });
  let sample;
  try {
    const jql = `project = ${jqlQuote(adapter.config.project)} AND issuetype = ${jqlQuote(subtaskType)} ORDER BY created DESC`;
    sample = ((await adapter.query(jql, { fields: ['summary'], limit: 1 })).issues || [])[0];
  } catch (e) {
    return none(`the "${subtaskType}" create screen has no time tracking and the edit-screen check could not run (${e.message})`);
  }
  if (!sample) return none(`the "${subtaskType}" create screen has no time tracking, and no existing "${subtaskType}" exists to check its edit screen`);
  try {
    const edit = await adapter.listEditFields(sample.key);
    if (edit.some((f) => f.referenceName === 'timetracking')) {
      return {
        mode: 'edit-after-create', probe: sample.key,
        message: `the "${subtaskType}" create screen has no time tracking but its edit screen does (checked on ${sample.key}) — ` +
          'each sub-task is created, then updated once with its hours',
      };
    }
  } catch (e) {
    return none(`the "${subtaskType}" create screen has no time tracking and ${sample.key}'s edit screen could not be read (${e.message})`);
  }
  return none(`time tracking is on neither the "${subtaskType}" create screen nor its edit screen (checked on ${sample.key})`);
}

async function validate(adapter, spec, args, cwd) {
  const cfg = adapter.config;
  const validation = {};

  // 1) assignee: spec -> a single configured jira.assignee — never invented —
  //    then email -> accountId via ONE user-search read (O5), fail closed.
  const { assignee, blocked } = rules.resolveAssignee({ spec, configured: cfg.assignees || [], configKey: 'jira.assignee' });
  validation.assignee = assignee;
  let accountId = null;
  if (assignee) {
    try {
      const users = await adapter.findUser(assignee);
      const exact = users.filter((u) => String(u.emailAddress || '').toLowerCase() === assignee.toLowerCase());
      const pool = exact.length ? exact : users; // sites may hide emails — the search result is then the pool
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

  // 2) structural: title prefix + finite positive estimate (the shared rules).
  blocked.push(...rules.structuralBlocks(spec, formatRef));

  // 3) sub-task type: jira.subtaskType pins it; else createmeta discovery —
  //    exactly one subtask:true type is used, several join the bundle round.
  let issueTypes = [];
  try { issueTypes = await adapter.listIssueTypes(); }
  catch (e) { blocked.push({ reason: 'issue-types-unavailable', message: `the project's issue types could not be read: ${e.message}` }); }
  const subtaskTypes = issueTypes.filter((t) => t.subtask);
  let subtaskType = null;
  if (cfg.subtaskType) {
    const hit = subtaskTypes.find((t) => t.name === cfg.subtaskType) ||
      subtaskTypes.find((t) => t.name.toLowerCase() === String(cfg.subtaskType).toLowerCase());
    if (hit) subtaskType = hit.name;
    else {
      blocked.push({
        reason: 'subtask-type-not-found', options: subtaskTypes.map((t) => t.name),
        message: `jira.subtaskType "${cfg.subtaskType}" is not one of the project's sub-task types (${subtaskTypes.map((t) => t.name).join(', ') || 'none'}) — correct it for this run`,
      });
    }
  } else if (subtaskTypes.length === 1) {
    subtaskType = subtaskTypes[0].name;
  } else if (issueTypes.length) {
    blocked.push({
      reason: subtaskTypes.length === 0 ? 'no-subtask-type' : 'subtask-type-ambiguous',
      ...(subtaskTypes.length ? { options: subtaskTypes.map((t) => t.name) } : {}),
      message: subtaskTypes.length === 0
        ? '[Testing] tasks are created as Jira sub-tasks and this project has no sub-task issue type — enable one in Jira first'
        : `this project has ${subtaskTypes.length} sub-task types (${subtaskTypes.map((t) => t.name).join(', ')}) — ask the user which one (the ONE bundled round); jira.subtaskType in config/project.json pins it thereafter (confirm once, never guess)`,
    });
  }
  validation.subtaskType = subtaskType;

  // 4) per story: exists, IS the configured storyType (mismatch blocks with the
  //    REAL type list), existing [Testing] children from inline subtasks
  //    (FAILS CLOSED when the list is missing).
  const perStory = [];
  for (const st of spec.stories) {
    const entry = { id: st.id, ...(st.complexity ? { complexity: st.complexity } : {}), tasks: (st.tasks || []).length };
    try {
      const story = await adapter.getStory(st.id);
      const wi = story.raw;
      entry.type = story.type;
      entry.title = story.title;
      entry.state = story.state;
      entry.url = adapter.webUrl(wi.key || st.id);
      if (entry.type !== cfg.storyType) {
        blocked.push({
          reason: 'story-not-a-story', story: st.id,
          message: `${st.id} is a "${entry.type || '?'}", not a "${cfg.storyType}" — [Testing] sub-tasks hang only off ${cfg.storyType} issues; this project's real types: ${issueTypes.map((t) => t.name).join(', ') || 'unknown'}`,
        });
      }
      try { entry.existingTestingTasks = await testingChildren(adapter, story); }
      catch { entry.existingTestingTasks = null; }
      if (entry.existingTestingTasks === null) {
        blocked.push({
          reason: 'children-check-failed', story: st.id,
          message: `the existing-children check on ${st.id} could not complete (no subtasks list on the read) — refusing to create blind (fails closed)`,
        });
      } else if (entry.existingTestingTasks.length && !args['allow-existing']) {
        blocked.push(rules.existingTasksBlock({ storyId: st.id, tasks: entry.existingTestingTasks, formatRef, taskNoun: 'sub-task' }));
      }
    } catch (e) {
      blocked.push({ reason: 'story-not-found', story: st.id, message: `story ${st.id} could not be read: ${e.message}` });
    }
    perStory.push(entry);
  }
  validation.perStory = perStory;

  // 5) createmeta cache for the sub-task type: field-not-on-screen detection
  //    BEFORE any write (a doc-pointed block instead of a server 400).
  //    Hours are the exception: Jira's REST API only writes timetracking when
  //    the field is on the screen, so the hours mode is discovered here. The
  //    plan states the mode, so the user's one approval covers it.
  let cacheInfo = null;
  let hours = null;
  if (subtaskType) {
    try {
      cacheInfo = await fieldCache.ensure(cwd, adapter, { types: [subtaskType], refresh: Boolean(args['refresh-fields']) });
      const fieldMap = (cacheInfo.cache.types[subtaskType] && cacheInfo.cache.types[subtaskType].fields) || {};
      hours = fieldMap.timetracking ? { mode: 'create' } : await hoursFallback(adapter, subtaskType);
      const needed = [
        ['labels', 'the Labels field is not on this create screen'],
        ['assignee', 'the Assignee field is not on this create screen'],
        ['parent', 'the Parent field is not on this create screen — a sub-task cannot be created without it'],
      ];
      validation.fields = needed.map(([name]) => ({ field: name, ok: Boolean(fieldMap[name]) }));
      for (const [name, why] of needed) {
        if (!fieldMap[name]) {
          blocked.push({
            reason: 'field-not-on-type', field: name,
            message: `field ${name} does not exist on this project's "${subtaskType}" create screen — ${why}`,
          });
        }
      }
    } catch (e) {
      blocked.push({ reason: 'field-cache-failed', message: `field metadata could not be read: ${e.message}` });
    }
  }

  validation.validateOnly = 'unsupported-on-jira';
  validation.notes = ["iteration/area have no Jira analog — sub-tasks ride their parent story's sprint"];
  if (hours) validation.hours = hours;

  // The fields each create sends (the adapter adds project/issuetype; the
  // parent folds in via the relations seam): verbatim titles, hours →
  // timetracking when the create screen allows it (else the estimate rides the
  // description), Activity=Testing → label 'testing', assignee by accountId.
  const timetrackingFor = (task) =>
    ({ originalEstimate: `${Number(task.estimate)}h`, remainingEstimate: `${Number(task.estimate)}h` });
  const hoursInline = !hours || hours.mode === 'create';
  const fieldsFor = (entry, task) => ({
    summary: task.title,
    ...(hoursInline
      ? { timetracking: timetrackingFor(task) }
      : { description: `Estimate: ${Number(task.estimate)}h` }),
    labels: [...JIRA_SUBTASK_LABELS],
    ...(accountId ? { assignee: { accountId } } : {}),
  });
  // edit-after-create: one update per created sub-task, right after its create.
  const followUp = hours && hours.mode === 'edit-after-create'
    ? {
      step: 'set-hours',
      fieldsFor: (entry, task) => ({ timetracking: timetrackingFor(task) }),
      plannedTarget: '<created key>',
      describe: (task) => `set the hours on "${task.title}" (PUT /rest/api/3/issue/<the key just created>)`,
    }
    : null;

  return {
    blocked, validation, cacheInfo, cacheStale: false,
    createType: subtaskType || 'Sub-task',
    parentRel: PARENT_REL,
    fieldsFor,
    describeCreate: (task, storyId) => `create "${task.title}" under story ${storyId} (POST /rest/api/3/issue — sub-task, fields.parent inline)`,
    followUp,
  };
}

module.exports = {
  provider: 'jira',
  parseIds, openStoriesRead, currentSprint, readStory, testingChildren, storyRow, validate,
  // compat (re-exported by create-tasks.js)
  currentSprintJql,
};
