'use strict';
// strategies/index.js — the task-estimation strategy registry: ONE static map
// from tracker provider (adapter.name) to its estimation strategy, fail-closed.
//
// Adding a tracker = (a) its adapter under scripts/lib/tracker/adapters/,
// (b) its strategy module here, (c) ONE line in defaultRegistry below — plus its
// conformance fixture (conformance/<provider>.fixture.js; conformance.test.js
// fails for a registered strategy without one). No edit to the create-tasks.js
// spine, none to the SKILL.md methodology.
//
// ── The EstimationStrategy contract (every member REQUIRED — REQUIRED_MEMBERS) ──
//   provider                                  === adapter.name, the registry key
//   parseIds(csv) -> Ref[]                    --ids value -> refs
//   openStoriesRead(adapter, args) -> ctx     per-run read context, called FIRST
//                                             on every `stories` run (may read)
//   currentSprint(adapter, args, ctx)         resolves its options, calls
//     -> { refs } | { stop: { code, out } }   adapter.listSprintStories(opts),
//                                             renders every condition into this
//                                             provider's exact output; sends no
//                                             request itself
//   readStory(adapter, ref, ctx)              adapter.getStory(ref) +
//     -> NeutralStory & { isStory, storyPoints }
//   testingChildren(adapter, story)           the [Testing] children (via
//     -> NeutralChild[]                       adapter.listChildren); REJECTS
//                                             when the scan cannot complete
//   storyRow(story, { ref, children,          the exact stories[] element (key
//     childrenError, full }, ctx) -> object   order, warnings, --full fields);
//                                             pure
//   validate(adapter, spec, args, cwd)        reads + local checks only, ZERO
//     -> Validation                           writes; findings in this
//                                             provider's exact order
//
//   Validation — every key REQUIRED; the spine asserts it and has NO defaults:
//     blocked: Blocked[]   validation: object (incl. perStory[])
//     cacheInfo: object|null   cacheStale: boolean
//     createType: string   parentRel: string
//     fieldsFor(entry, task) -> fields   describeCreate(task, storyId) -> string
//     followUp: null | { step, fieldsFor(entry, task), plannedTarget, describe(task) }
//       — one update right after each create (planned against plannedTarget).
//
// get(name) fails closed (exit 2, before any adapter call) for an unregistered
// provider, a strategy missing a required member, or a provider/key mismatch —
// never a fallback to another provider's behavior (invariant 10).

const REQUIRED_MEMBERS = ['provider', 'parseIds', 'openStoriesRead', 'currentSprint',
  'readStory', 'testingChildren', 'storyRow', 'validate'];

function refusal(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

function createRegistry(map) {
  const providers = () => Object.keys(map);
  const nothing = 'Refusing rather than falling back to another provider\'s behavior; nothing was read or written.';
  return {
    providers,
    get(name) {
      const strategy = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
      if (!strategy) {
        throw refusal(
          `No task-estimation strategy is registered for tracker provider '${name}' — providers with one: ` +
          `${providers().join(', ') || 'none'}. ${nothing}`);
      }
      const missing = REQUIRED_MEMBERS.filter((m) =>
        (m === 'provider' ? typeof strategy[m] !== 'string' : typeof strategy[m] !== 'function'));
      if (missing.length) {
        throw refusal(
          `The task-estimation strategy registered for tracker provider '${name}' is missing required member(s): ` +
          `${missing.join(', ')}. ${nothing}`);
      }
      if (strategy.provider !== name) {
        throw refusal(
          `The task-estimation strategy registered under '${name}' declares provider '${strategy.provider}' — ` +
          `a strategy must be registered under its own provider. ${nothing}`);
      }
      return strategy;
    },
  };
}

const ado = require('./ado.js');
const jira = require('./jira.js');

// One line per provider.
const defaultRegistry = createRegistry({
  ado,
  jira,
});

// The pinned names create-tasks.js keeps exporting.
const compat = {
  currentIterationWiql: ado.currentIterationWiql,
  currentSprintJql: jira.currentSprintJql,
  PARENT_LINK: ado.PARENT_LINK,
};

module.exports = { REQUIRED_MEMBERS, createRegistry, defaultRegistry, compat };
