'use strict';
// ops/index.js — the tracker CLI's strategy registry: ONE static map from
// tracker provider (adapter.name) to its TrackerOpsStrategy, fail-closed via
// the shared scripts/lib/tracker/registry.js.
//
// Adding a tracker = (a) its adapter under ../adapters/, (b) its ops strategy
// module here, (c) ONE line in defaultRegistry below — plus its conformance
// fixture (conformance/<provider>.fixture.js; conformance.test.js fails for a
// registered strategy without one). No edit to the scripts/tracker.js spine.
//
// ── The TrackerOpsStrategy contract (every member REQUIRED — REQUIRED_MEMBERS) ──
//   provider                                  === adapter.name, the registry key
//   summarize(adapter, raw, {fields}) -> obj  `show`'s neutral work-item summary
//   scopeQuery(adapter, text) -> string       the query text `search` sends
//   searchOptions({top, fields})              the adapter.query options + the
//     -> { max, options }                     --top ceiling (validated before any request)
//   searchResults(adapter, res, {top, fields}) `search` rows (+ fields) + truncated
//     -> Promise<{ results: [...], truncated: bool }>   ("at the cap; more may exist")
//   batchRead(adapter, ids, fields)           -> { items: [{id, fields}], missing, moved? }
//   comments(adapter, id)                     -> [{author, date, text}] oldest first
//   relations(adapter, ids, kinds, fields)    -> { items: [{id, relations: [{kind, id, type, title, state, …}]}] }
//   iterations(adapter, {team, board, timeframe}) -> [{id, name, path?, startDate, finishDate, timeFrame}]
//   transition(adapter, id, to, {execute})    dry run -> { step, request, extra?, note? }
//                                             execute -> { result, note? }
//   refusedUpdateFields(spec) -> Blocked[]    fields `update` refuses before any request
//   renderDiscussion(text, mention|null)      the EXACT comment body the adapter's
//     -> provider body                        addComment sends (ADO HTML string /
//                                             Jira ADF doc); mention = {id, displayName}
//
// get(name) fails closed (exit 2, before any adapter call) for an unregistered
// provider, a strategy missing a required member, or a provider/key mismatch.
const path = require('node:path');
const { createRegistry } = require(path.join(__dirname, '..', 'registry.js'));

const REQUIRED_MEMBERS = ['provider', 'summarize', 'scopeQuery', 'searchOptions', 'searchResults', 'batchRead', 'comments',
  'relations', 'iterations', 'transition', 'refusedUpdateFields', 'renderDiscussion'];
const LABEL = 'tracker-ops strategy';

const ado = require('./ado.js');
const jira = require('./jira.js');

// One line per provider.
const defaultRegistry = createRegistry({ label: LABEL, requiredMembers: REQUIRED_MEMBERS, map: {
  ado,
  jira,
} });

// For tests and synthetic providers: a registry with the same contract.
function makeRegistry(map) {
  return createRegistry({ label: LABEL, requiredMembers: REQUIRED_MEMBERS, map });
}

module.exports = { REQUIRED_MEMBERS, defaultRegistry, makeRegistry };
