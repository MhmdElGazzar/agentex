#!/usr/bin/env node
// create-tasks.js — the task-estimation flow's mechanics, provider-neutral:
// read the sprint's stories (or explicitly named ones), then validate
// EVERYTHING first (zero board writes) and — only behind --execute — create the
// [Testing] tasks, one atomic create per task with the parent relation inline,
// behind an exact per-write ledger.
//
// THE SPINE. Everything tracker-specific — which work item type is a story, the
// sprint read, the existing-children scan, field validation, field
// composition, the create type and parent relation, follow-up writes, describe
// text, how a ref is written in a message — lives in the configured provider's
// estimation strategy (./strategies/<provider>.js), looked up in a fail-closed
// registry (./strategies/index.js) by the resolved adapter's name. A provider
// with no registered strategy is refused (exit 2) before any request; nothing
// here falls back to another provider's behavior (invariant 10).
//
// Built on the tracker layer (scripts/lib/tracker/): REST over Node's built-in
// fetch. No CLI, no process spawning, zero npm dependencies. Credentials are
// read from .env by the adapter and sent only in the Authorization header —
// never printed, logged, or placed on a command line (invariant 5).
//
// READS (free, no gating — `stories` has no --execute surface at all):
//   node create-tasks.js stories --current-sprint [--team "<name>"] [--sprint "<name>"] [--full]
//   node create-tasks.js stories --ids <ID,ID> [--full]
//     The strategy resolves the current sprint (run-only overrides such as
//     --team / --sprint never rewrite the consumer's config, invariant 11) and
//     reports a sprint read it cannot resolve as a blocked/error result.
//     Per story: the strategy's row — id/title/state/storyPoints/url, the
//     provider's placement facts, existingTestingTasks (children titled
//     [Testing]…), and with --full the description + acceptance-criteria HTML
//     for the agent's factor analysis.
//
// DRY RUN (default) — the validation gate behind the skill's ONE approval:
//   node create-tasks.js --spec <file.json> [--allow-existing] [--refresh-fields]
//     The strategy validates (reads + local checks only): each story exists and
//     IS a story (fails closed); placement is re-read from the story, never
//     trusted from the spec; existing [Testing] children block without
//     --allow-existing, and a children check that cannot complete blocks too
//     (fails CLOSED). Structural: every task title starts with "[Testing] ",
//     every estimate is a finite number > 0, the assignee comes from the spec or
//     a single configured value — never invented. Field values are checked
//     against the project's field cache (--refresh-fields rebuilds it). The
//     plan lists every intended write in order with its exact route.
//
// --execute — one WritePlan of the story-ordered task intents (each create,
//   plus the strategy's follow-up step right after it when it has one). First
//   failure stops; the ledger reports every intended write as done (id + url)
//   or not-done (reason); created IDs are in the JSON even when a later step
//   throws. No auto-retry, no cleanup writes.
//
// Spec JSON shape (written by the agent to the OS temp dir):
//   { "assignee": "qa.engineer@example.com",
//     "stories": [ { "id": <story id>, "complexity": "Simple",
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
const tracker = require(path.join(LIB, 'index.js'));
const { TrackerError } = tracker;
const { WritePlan } = require(path.join(LIB, 'ledger.js'));
const { defaultRegistry, compat } = require('./strategies/index.js');

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

// ---- stories (read-only; there is no --execute path here) --------------------
async function storiesCmd(args, adapter, strategy) {
  const ctx = await strategy.openStoriesRead(adapter, args);
  let refs;
  if (args.ids) {
    refs = strategy.parseIds(args.ids);
  } else if (args['current-sprint']) {
    const r = await strategy.currentSprint(adapter, args, ctx);
    if (r.stop) return r.stop;
    refs = r.refs;
  } else {
    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  }

  const stories = [];
  for (const ref of refs) {
    try {
      const story = await strategy.readStory(adapter, ref, ctx);
      let children = null; let childrenError = null;
      try { children = await strategy.testingChildren(adapter, story); }
      catch (e) { childrenError = e; }
      stories.push(strategy.storyRow(story, { ref, children, childrenError, full: Boolean(args.full) }, ctx));
    } catch (e) {
      stories.push({ id: ref, warning: `could not be read: ${e.message}` });
    }
  }
  return { code: 0, out: { ok: true, mode: 'stories', count: stories.length, stories } };
}

// The strategy's Validation must carry every key — the spine has NO defaults,
// so a gap fails the run closed (exit 1) before any write.
function assertValidation(v, provider) {
  const gaps = [];
  const has = (k) => v && Object.prototype.hasOwnProperty.call(v, k);
  if (!has('blocked') || !Array.isArray(v.blocked)) gaps.push('blocked[]');
  if (!has('validation') || !v.validation || typeof v.validation !== 'object' || !Array.isArray(v.validation.perStory)) gaps.push('validation.perStory[]');
  if (!has('cacheInfo') || (v.cacheInfo !== null && typeof v.cacheInfo !== 'object')) gaps.push('cacheInfo');
  if (!has('cacheStale') || typeof v.cacheStale !== 'boolean') gaps.push('cacheStale');
  if (!has('createType') || typeof v.createType !== 'string') gaps.push('createType');
  if (!has('parentRel') || typeof v.parentRel !== 'string') gaps.push('parentRel');
  if (!has('fieldsFor') || typeof v.fieldsFor !== 'function') gaps.push('fieldsFor');
  if (!has('describeCreate') || typeof v.describeCreate !== 'function') gaps.push('describeCreate');
  if (!has('followUp')) gaps.push('followUp');
  else if (v.followUp !== null && (typeof v.followUp !== 'object' || typeof v.followUp.step !== 'string' ||
    typeof v.followUp.fieldsFor !== 'function' || typeof v.followUp.plannedTarget !== 'string' ||
    typeof v.followUp.describe !== 'function')) gaps.push('followUp{step, fieldsFor, plannedTarget, describe}');
  if (gaps.length) {
    throw new Error(`the '${provider}' task-estimation strategy returned an incomplete validation (missing: ${gaps.join(', ')}) — refusing; nothing was written`);
  }
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

// ---- main ---------------------------------------------------------------------
// Returns { code, out }; prints nothing. opts.fetch is the offline-test seam;
// opts.registry / opts.resolveTracker are the same kind of seam for the
// registry and the tracker resolution (tests inject them; the CLI never does).
async function run(argv, { cwd = process.cwd(), fetch, registry = defaultRegistry, resolveTracker = tracker.resolveTracker } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const mode = args.execute ? 'executed' : 'plan';
  try {
    if (cmd === 'stories') {
      const adapter = resolveTracker(cwd, { fetch });
      return await storiesCmd(args, adapter, registry.get(adapter.name));
    }

    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: `--spec <file.json> is required. ${USAGE}` } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    const shapeErrors = specShapeErrors(spec);
    if (shapeErrors.length) return { code: 2, out: { ok: false, mode, blocked: shapeErrors } };

    const adapter = resolveTracker(cwd, { fetch });
    const strategy = registry.get(adapter.name);
    // The validation/gate/ledger spine is shared; the strategy supplies every
    // provider value — field composition, create type, parent relation,
    // describe text, and any follow-up step. No defaults here.
    const v = await strategy.validate(adapter, spec, args, cwd);
    assertValidation(v, strategy.provider);
    const { blocked, validation, fieldsFor, cacheInfo, cacheStale, createType, parentRel, describeCreate, followUp } = v;
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
        if (followUp) {
          const u = await adapter.updateWorkItem(followUp.plannedTarget, { fields: followUp.fieldsFor(entry, task) }, { execute: false });
          plan.push({ step: followUp.step, story: storyId, title: task.title, describe: `${u.method} ${u.url} — right after the create above`, request: u });
        }
      }
      return { code: 0, out: { ok: true, mode: 'plan', validation, plan, cache: cacheOut } };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const createdTasks = [];
    const intents = flat.flatMap(({ storyId, entry, task }) => {
      let createdId = null;
      const create = {
        step: 'create-task',
        describe: describeCreate(task, storyId),
        run: async () => {
          const r = await adapter.createWorkItem(createType, {
            fields: fieldsFor(entry, task),
            relations: [{ rel: parentRel, targetId: storyId }],
          }, { execute: true });
          createdId = r.id;
          createdTasks.push({ id: r.id, url: r.url, storyId, title: task.title });
          return { id: r.id, url: r.url };
        },
      };
      if (!followUp) return [create];
      const fields = followUp.fieldsFor(entry, task);
      return [create, {
        step: followUp.step,
        describe: followUp.describe(task),
        run: async () => adapter.updateWorkItem(createdId, { fields }, { execute: true }),
      }];
    });

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

module.exports = {
  run,
  // Pinned compat names, owned by the strategies (create-tasks.test.js pins them).
  currentIterationWiql: compat.currentIterationWiql,
  currentSprintJql: compat.currentSprintJql,
  PARENT_LINK: compat.PARENT_LINK,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
