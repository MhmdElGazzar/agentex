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
//   searchResults(adapter, res, {top})        `search` rows + truncated flag
//     -> { results: [...], truncated: bool }
//   transition(adapter, id, to, {execute})    dry run -> { step, request, extra?, note? }
//                                             execute -> { result, note? }
//   refusedUpdateFields(spec) -> Blocked[]    fields `update` refuses before any request
//
// get(name) fails closed (exit 2, before any adapter call) for an unregistered
// provider, a strategy missing a required member, or a provider/key mismatch.
const path = require('node:path');
const { createRegistry } = require(path.join(__dirname, '..', 'registry.js'));

const REQUIRED_MEMBERS = ['provider', 'summarize', 'scopeQuery', 'searchResults', 'transition', 'refusedUpdateFields'];
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
