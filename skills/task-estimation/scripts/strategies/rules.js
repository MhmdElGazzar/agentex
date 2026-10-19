'use strict';
// rules.js — the provider-neutral estimation rules every task-estimation
// strategy shares: the [Testing] title template, assignee resolution, the
// structural task checks, and the existing-children block. One template per
// message; each provider supplies only its parameters (how a story ref is
// written, which config key holds the assignee, what a child task is called),
// so the rendered bytes stay exactly each provider's.
//
// Pure: no I/O, no requests, no provider names, zero dependencies.

const TITLE_PREFIX = '[Testing] ';

// A child counts as an existing [Testing] task when its title starts with the
// template marker (the prefix without its trailing space, as always).
const isTestingTitle = (t) => String(t || '').startsWith('[Testing]');

// Assignee: spec.assignee, else a SINGLE configured value — never invented.
// Several configured values block with them as options (a user choice).
//   configured — the adapter's resolved assignee list
//   configKey  — the config key that holds it, named in the message
function resolveAssignee({ spec, configured, configKey }) {
  const assignee = (spec.assignee && String(spec.assignee).trim()) ||
    (configured.length === 1 ? configured[0] : null);
  const blocked = [];
  if (!assignee) {
    blocked.push({
      reason: 'missing-assignee',
      ...(configured.length > 1 ? { options: configured } : {}),
      message: configured.length > 1
        ? `spec.assignee is empty and ${configKey} lists ${configured.length} options (${configured.join(', ')}) — ask the user which one, never pick silently`
        : `no assignee — set spec.assignee (ask the user) or ${configKey} in config/project.json`,
    });
  }
  return { assignee, blocked };
}

// Structural checks, every finding at once, in spec order: each task's title
// starts with "[Testing] ", each estimate is a finite number > 0.
//   formatRef — how this provider writes a story ref in a message
function structuralBlocks(spec, formatRef) {
  const blocked = [];
  for (const st of spec.stories) {
    for (const task of st.tasks) {
      const title = task && task.title;
      if (typeof title !== 'string' || !title.startsWith(TITLE_PREFIX)) {
        blocked.push({
          reason: 'bad-task-title', story: st.id, title: title ?? null,
          message: `story ${formatRef(st.id)}: task title ${JSON.stringify(title ?? null)} must start with "${TITLE_PREFIX}"`,
        });
      }
      const est = Number(task && task.estimate);
      if (!Number.isFinite(est) || est <= 0) {
        blocked.push({
          reason: 'bad-estimate', story: st.id, title: title ?? null, estimate: (task && task.estimate) ?? null,
          message: `story ${formatRef(st.id)}: "${title}" needs a finite estimate > 0 (got ${JSON.stringify((task && task.estimate) ?? null)})`,
        });
      }
    }
  }
  return blocked;
}

// The block for a story that already has [Testing] children (the caller skips
// it under --allow-existing). tasks is non-empty.
//   taskNoun — what this provider calls a child task in the message
function existingTasksBlock({ storyId, tasks, formatRef, taskNoun }) {
  return {
    reason: 'existing-testing-tasks', story: storyId,
    ids: tasks.map((t) => t.id),
    message: `story ${formatRef(storyId)} already has ${tasks.length} [Testing] ${taskNoun}(s) ` +
      `(${tasks.map((t) => formatRef(t.id)).join(', ')}) — ask the user: skip = drop the story from the spec; add anyway = pass --allow-existing`,
  };
}

module.exports = { TITLE_PREFIX, isTestingTitle, resolveAssignee, structuralBlocks, existingTasksBlock };
