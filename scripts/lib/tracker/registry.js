'use strict';
// registry.js — the generic, fail-closed per-provider strategy registry.
//
// Extracted from task-estimation's strategies/index.js once a second consumer
// existed (the tracker CLI's ops strategies, scripts/lib/tracker/ops/) — the
// ARCHITECTURE.md rule "a shared component only once a second consumer exists".
// Each consumer supplies its own label (the noun in every refusal), its own
// required-member list (its strategy contract), and its static map from
// tracker provider (adapter.name) to strategy.
//
// get(name) fails closed (exit 2, before any adapter call) for an unregistered
// provider, a strategy missing a required member, or a provider/key mismatch —
// never a fallback to another provider's behavior (invariant 10).

function refusal(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// { label: 'task-estimation strategy', requiredMembers: ['provider', …], map: { ado, jira } }
// 'provider' in requiredMembers must be a string; every other member a function.
function createRegistry({ label, requiredMembers, map } = {}) {
  if (typeof label !== 'string' || !label) throw new Error('createRegistry needs a label');
  if (!Array.isArray(requiredMembers)) throw new Error('createRegistry needs requiredMembers (an array)');
  if (!map || typeof map !== 'object') throw new Error('createRegistry needs a map (provider -> strategy)');
  const providers = () => Object.keys(map);
  const nothing = 'Refusing rather than falling back to another provider\'s behavior; nothing was read or written.';
  return {
    providers,
    get(name) {
      const strategy = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
      if (!strategy) {
        throw refusal(
          `No ${label} is registered for tracker provider '${name}' — providers with one: ` +
          `${providers().join(', ') || 'none'}. ${nothing}`);
      }
      const missing = requiredMembers.filter((m) =>
        (m === 'provider' ? typeof strategy[m] !== 'string' : typeof strategy[m] !== 'function'));
      if (missing.length) {
        throw refusal(
          `The ${label} registered for tracker provider '${name}' is missing required member(s): ` +
          `${missing.join(', ')}. ${nothing}`);
      }
      if (strategy.provider !== name) {
        throw refusal(
          `The ${label} registered under '${name}' declares provider '${strategy.provider}' — ` +
          `a strategy must be registered under its own provider. ${nothing}`);
      }
      return strategy;
    },
  };
}

module.exports = { createRegistry };
