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
const { jqlQuote } = require(path.join(LIB, 'adapters', 'jira.js'));

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

// PINNED: the Jira twin of currentIterationWiql — the ONE place the
// current-sprint JQL lives (escaping is adapter-owned via jqlQuote, §5.4).
// `sprint in openSprints()` may span several sprints on multi-board projects;
// the stories command detects that and blocks with the real sprint names so
// the choice joins the ONE bundle round (O3) — never a silent pick.
function currentSprintJql(projectKey, storyType) {
  return `project = ${jqlQuote(projectKey)} AND issuetype = ${jqlQuote(storyType)} AND sprint in openSprints() ORDER BY key`;
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

/* ════ Jira strategy (design §5.6) — the ADO path above is untouched ════════
 * Verbatim template parity: the same five [Testing] titles, one atomic
 * sub-task create per task (fields.parent inline via the relations seam),
 * hours mapped to Jira time tracking, Activity=Testing mapped to the label
 * 'testing' (PR #4 harvest). Iteration/area have no Jira analog — sub-tasks
 * ride their parent story's sprint, and the plan says so explicitly.
 */

const JIRA_SUBTASK_LABELS = ['testing'];

// [Testing]-titled children straight from fields.subtasks (summaries come
// inline — cheaper than ADO's per-child reads). Returns null when the read
// carried no subtasks list: the caller must FAIL CLOSED, same as ADO.
function jiraTestingChildren(fields) {
  if (!Array.isArray(fields.subtasks)) return null;
  return fields.subtasks
    .filter((s) => String(((s || {}).fields || {}).summary || '').startsWith('[Testing]'))
    .map((s) => ({ id: s.key, title: s.fields.summary, state: (s.fields.status || {}).name || null }));
}

// Story Points / Sprint field discovery by display name (listAllFields), with
// jira.storyPointsField as the confirmed-once override — never guessed.
async function jiraDiscoverFields(adapter) {
  const cfg = adapter.config;
  const out = { storyPointsFieldId: null, sprintFieldId: null, storyPointsNote: null };
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

async function jiraStoriesCmd(args, adapter) {
  const cfg = adapter.config;
  const disc = await jiraDiscoverFields(adapter);
  const sprintsOf = (issue) => {
    const v = disc.sprintFieldId ? ((issue.fields || {})[disc.sprintFieldId]) : null;
    return (Array.isArray(v) ? v : []).filter((s) => s && (s.state === undefined || s.state === 'active'));
  };

  let keys;
  if (args.ids) {
    keys = String(args.ids).split(',').map((s) => s.trim()).filter(Boolean);
  } else if (args['current-sprint']) {
    const jql = currentSprintJql(cfg.project, cfg.storyType);
    const res = await adapter.query(jql, { fields: ['summary', ...(disc.sprintFieldId ? [disc.sprintFieldId] : [])] });
    let issues = res.issues || [];
    const names = new Set();
    for (const iss of issues) for (const s of sprintsOf(iss)) names.add(s.name);
    const wanted = typeof args.sprint === 'string' && args.sprint.trim() ? args.sprint.trim() : null;
    if (wanted) {
      // The run-only answer to the bundled which-sprint ask — never persisted.
      issues = issues.filter((iss) => sprintsOf(iss).some((s) => String(s.name) === wanted || String(s.id) === wanted));
    } else if (names.size > 1) {
      if (cfg.board) {
        // O3: a configured board steers via the agile API.
        const boards = await adapter.listBoards();
        const board = boards.find((b) => String(b.id) === cfg.board) || boards.find((b) => b.name === cfg.board);
        if (!board) {
          return { code: 2, out: { ok: false, mode: 'stories', blocked: [{
            reason: 'board-not-found', options: boards.map((b) => `${b.name} (id ${b.id})`),
            message: `jira.board "${cfg.board}" matches no board of project ${cfg.project} — real boards: ${boards.map((b) => `${b.name} (id ${b.id})`).join(', ') || 'none'}`,
          }] } };
        }
        const active = await adapter.listSprints(board.id, { state: 'active' });
        if (active.length !== 1) {
          return { code: 2, out: { ok: false, mode: 'stories', blocked: [{
            reason: 'multiple-open-sprints', options: active.map((s) => s.name),
            message: `board "${cfg.board}" has ${active.length} active sprints — ask the user which one (the ONE bundled round) and re-run with --sprint "<name>"`,
          }] } };
        }
        issues = issues.filter((iss) => sprintsOf(iss).some((s) => String(s.id) === String(active[0].id) || s.name === active[0].name));
      } else {
        return { code: 2, out: { ok: false, mode: 'stories', blocked: [{
          reason: 'multiple-open-sprints', options: [...names].sort(),
          message: `the open-sprint read spans ${names.size} sprints (${[...names].sort().join(', ')}) — ` +
            'ask the user which sprint (the ONE bundled round) and re-run with --sprint "<name>", ' +
            'or set jira.board in config/project.json to steer discovery',
        }] } };
      }
    }
    keys = issues.map((i) => i.key);
    // Runtime discovery of a missing project prerequisite: a kanban/simple board
    // has no sprints, so the open-sprint read comes back empty — say why and how
    // to fix it instead of an empty ok the agent could read as "nothing to do".
    if (!keys.length) {
      return { code: 2, out: { ok: false, mode: 'stories', blocked: [{
        reason: 'no-open-sprint',
        message: `no "${cfg.storyType}" sits in an open sprint of project ${cfg.project}` +
          (wanted ? ` named "${wanted}"` : '') + ' — a kanban/simple board has no sprints, or no sprint is started, ' +
          'or the sprint holds no stories. Fix on Jira: turn Sprints on (team-managed: Project settings → Features → Sprints; ' +
          'company-managed: a Scrum board), then start a sprint holding the stories — or re-run with --ids <KEY,KEY> ' +
          'to estimate named stories. See references/tracker/jira-boards.md, "Project prerequisites".',
      }] } };
    }
  } else {
    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  }

  const stories = [];
  for (const key of keys) {
    try {
      const wi = await adapter.getWorkItem(key);
      const f = (wi && wi.fields) || {};
      const s = {
        id: wi.key || key,
        type: (f.issuetype || {}).name || null,
        title: f.summary || null,
        state: (f.status || {}).name || null,
        storyPoints: disc.storyPointsFieldId ? (f[disc.storyPointsFieldId] ?? null) : null,
        ...(disc.storyPointsNote ? { storyPointsNote: disc.storyPointsNote } : {}),
        url: adapter.webUrl(wi.key || key),
      };
      if (s.type !== cfg.storyType) {
        s.warning = `${key} is a "${s.type || '?'}", not a "${cfg.storyType}" — the dry run will refuse to create sub-tasks under it`;
      }
      s.existingTestingTasks = jiraTestingChildren(f);
      if (s.existingTestingTasks === null) {
        s.warning = 'existing-children scan could not complete (no subtasks list on the read) — the dry run will block on this story (fails closed)';
      }
      if (args.full) {
        const rf = wi.renderedFields || {};
        s.description = rf.description || null;
        if (cfg.acceptanceCriteriaField) {
          s.acceptanceCriteria = rf[cfg.acceptanceCriteriaField] ?? null;
        } else {
          s.acceptanceCriteria = null;
          s.acceptanceCriteriaNote = 'no jira.acceptanceCriteriaField configured — read the ACs from the description';
        }
      }
      stories.push(s);
    } catch (e) {
      stories.push({ id: key, warning: `could not be read: ${e.message}` });
    }
  }
  return { code: 0, out: { ok: true, mode: 'stories', count: stories.length, stories } };
}

// Jira validation phase — reads + local checks only, every finding at once.
// No validateOnly probe exists on Jira (capabilities.validateOnly: false): the
// createmeta cache + required-field checks carry pre-gate validation alone,
// and the JSON says so (validateOnly: 'unsupported-on-jira').
async function validateJira(adapter, spec, args, cwd) {
  const cfg = adapter.config;
  const blocked = [];
  const validation = {};

  // 1) assignee: spec -> a single configured jira.assignee — never invented —
  //    then email -> accountId via ONE user-search read (O5), fail closed.
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

  // 2) structural: title prefix + finite positive estimate (the shared spine's rules).
  for (const st of spec.stories) {
    for (const task of st.tasks) {
      const title = task && task.title;
      if (typeof title !== 'string' || !title.startsWith(TITLE_PREFIX)) {
        blocked.push({
          reason: 'bad-task-title', story: st.id, title: title ?? null,
          message: `story ${st.id}: task title ${JSON.stringify(title ?? null)} must start with "${TITLE_PREFIX}"`,
        });
      }
      const est = Number(task && task.estimate);
      if (!Number.isFinite(est) || est <= 0) {
        blocked.push({
          reason: 'bad-estimate', story: st.id, title: title ?? null, estimate: (task && task.estimate) ?? null,
          message: `story ${st.id}: "${title}" needs a finite estimate > 0 (got ${JSON.stringify((task && task.estimate) ?? null)})`,
        });
      }
    }
  }

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
      const wi = await adapter.getWorkItem(st.id);
      const f = (wi && wi.fields) || {};
      entry.type = (f.issuetype || {}).name || null;
      entry.title = f.summary || null;
      entry.state = (f.status || {}).name || null;
      entry.url = adapter.webUrl(wi.key || st.id);
      if (entry.type !== cfg.storyType) {
        blocked.push({
          reason: 'story-not-a-story', story: st.id,
          message: `${st.id} is a "${entry.type || '?'}", not a "${cfg.storyType}" — [Testing] sub-tasks hang only off ${cfg.storyType} issues; this project's real types: ${issueTypes.map((t) => t.name).join(', ') || 'unknown'}`,
        });
      }
      entry.existingTestingTasks = jiraTestingChildren(f);
      if (entry.existingTestingTasks === null) {
        blocked.push({
          reason: 'children-check-failed', story: st.id,
          message: `the existing-children check on ${st.id} could not complete (no subtasks list on the read) — refusing to create blind (fails closed)`,
        });
      } else if (entry.existingTestingTasks.length && !args['allow-existing']) {
        blocked.push({
          reason: 'existing-testing-tasks', story: st.id,
          ids: entry.existingTestingTasks.map((t) => t.id),
          message: `story ${st.id} already has ${entry.existingTestingTasks.length} [Testing] sub-task(s) ` +
            `(${entry.existingTestingTasks.map((t) => t.id).join(', ')}) — ask the user: skip = drop the story from the spec; add anyway = pass --allow-existing`,
        });
      }
    } catch (e) {
      blocked.push({ reason: 'story-not-found', story: st.id, message: `story ${st.id} could not be read: ${e.message}` });
    }
    perStory.push(entry);
  }
  validation.perStory = perStory;

  // 5) createmeta cache for the sub-task type: field-not-on-screen detection
  //    BEFORE any write (e.g. timetracking disabled site-wide → a doc-pointed
  //    block instead of a server 400).
  let cacheInfo = null;
  if (subtaskType) {
    try {
      cacheInfo = await fieldCache.ensure(cwd, adapter, { types: [subtaskType], refresh: Boolean(args['refresh-fields']) });
      const fieldMap = (cacheInfo.cache.types[subtaskType] && cacheInfo.cache.types[subtaskType].fields) || {};
      const needed = [
        ['timetracking', 'time tracking is disabled site-wide or not on this create screen — hours cannot be written blind. Fix on Jira: turn time tracking on and put the "Time tracking" field on this type (see references/tracker/jira-boards.md, "Project prerequisites")'],
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

  // The fields each create sends (adapter adds project/issuetype; the parent
  // folds in via the relations seam): verbatim titles, hours → timetracking,
  // Activity=Testing → label 'testing', assignee by accountId.
  const fieldsFor = (entry, task) => ({
    summary: task.title,
    timetracking: { originalEstimate: `${Number(task.estimate)}h`, remainingEstimate: `${Number(task.estimate)}h` },
    labels: [...JIRA_SUBTASK_LABELS],
    ...(accountId ? { assignee: { accountId } } : {}),
  });

  return {
    blocked, validation, fieldsFor, cacheInfo, cacheStale: false,
    createType: subtaskType || 'Sub-task',
    parentRel: 'parent',
    describeCreate: (task, storyId) => `create "${task.title}" under story ${storyId} (POST /rest/api/3/issue — sub-task, fields.parent inline)`,
  };
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
      const adapter = resolveTracker(cwd, { fetch });
      return adapter.name === 'jira'
        ? await jiraStoriesCmd(args, adapter)
        : await storiesCmd(args, adapter);
    }

    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: `--spec <file.json> is required. ${USAGE}` } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    const shapeErrors = specShapeErrors(spec);
    if (shapeErrors.length) return { code: 2, out: { ok: false, mode, blocked: shapeErrors } };

    const adapter = resolveTracker(cwd, { fetch });
    // Provider strategy (O10): the validation/gate/ledger spine is shared; the
    // strategy supplies field composition, type/relation names and describe text.
    const v = adapter.name === 'jira'
      ? await validateJira(adapter, spec, args, cwd)
      : await validate(adapter, spec, args, cwd);
    const { blocked, validation, fieldsFor, cacheInfo, cacheStale } = v;
    const createType = v.createType || 'Task';
    const parentRel = v.parentRel || PARENT_LINK;
    const describeCreate = v.describeCreate ||
      ((task, storyId) => `create "${task.title}" under story #${storyId} (POST _apis/wit/workitems/$Task, parent link inline)`);
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
        const d = await adapter.createWorkItem(createType, {
          fields: fieldsFor(entry, task),
          relations: [{ rel: parentRel, targetId: storyId }],
        }, { execute: false });
        plan.push({
          step: 'create-task', story: storyId, title: task.title,
          describe: `${d.method} ${d.url} (${parentRel} -> ${typeof storyId === 'number' ? `#${storyId}` : storyId} inline — atomic)`,
          request: d,
        });
      }
      return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const createdTasks = [];
    const intents = flat.map(({ storyId, entry, task }) => ({
      step: 'create-task',
      describe: describeCreate(task, storyId),
      run: async () => {
        const r = await adapter.createWorkItem(createType, {
          fields: fieldsFor(entry, task),
          relations: [{ rel: parentRel, targetId: storyId }],
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

module.exports = { run, currentIterationWiql, currentSprintJql, PARENT_LINK };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
