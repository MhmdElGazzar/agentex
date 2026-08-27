'use strict';
// Tracker resolution — the provider-neutral entrypoint of scripts/lib/tracker/.
//
// resolveTracker(cwd[, {fetch, timeoutMs}]) reads the consumer's
// config/project.json and returns the configured provider's adapter — one
// optional block per provider (`azure` → adapters/ado.js, `jira` →
// adapters/jira.js). Provider SELECTION is a wizard-time question (Q12): the
// wizard writes exactly one block, and this resolver is the fail-closed
// runtime backstop behind it.
//
// Fail-closed rules (invariant 10 / owner decision D-10):
//   - no provider block and no legacy AZURE_* keys  -> explicit exit-2 error
//     naming exactly what was looked for and where;
//   - more than one provider block                  -> exit-2 error listing the
//     configured providers (tracker SELECTION is a Phase-3 question — an honest
//     stopgap beats a silent pick);
//   - a provider block we have no adapter for       -> exit-2 error naming it.
//
// The optional {fetch} is the offline-test seam (injected, never monkey-patched).
const path = require('node:path');
const pc = require(path.join(__dirname, '..', 'project_config.js'));
const { TrackerError } = require('./errors.js');
const ado = require('./adapters/ado.js');
const jira = require('./adapters/jira.js');

// Provider blocks the config shape knows about, and their adapters.
const KNOWN_PROVIDERS = ['azure', 'jira'];
const ADAPTERS = { azure: ado.createAdapter, jira: jira.createAdapter };

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

function resolveTracker(cwd = process.cwd(), { fetch, timeoutMs } = {}) {
  const cfg = pc.loadProjectConfig(cwd);
  const configured = KNOWN_PROVIDERS.filter(
    (p) => cfg[p] && typeof cfg[p] === 'object' && Object.keys(cfg[p]).length > 0,
  );
  // Legacy projects: everything in .env, no config/project.json blocks.
  if (configured.length === 0 && (pc.readEnvVar(cwd, 'AZURE_URL') || pc.readEnvVar(cwd, 'AZURE_PROJECT'))) {
    configured.push('azure');
  }
  if (configured.length === 0) {
    throw configError(
      'No tracker is configured — looked for an `azure` block (keys: azure.org, azure.project) ' +
      'and a `jira` block (keys: jira.site, jira.project) in config/project.json, ' +
      'and for legacy AZURE_URL / AZURE_PROJECT lines in .env, and found none. ' +
      'Fill exactly one provider block (the /init-test wizard writes it).');
  }
  if (configured.length > 1) {
    throw configError(
      `More than one tracker provider is configured (${configured.join(', ')}) — ` +
      'selecting between providers is not supported yet, so this fails closed rather than silently picking one. ' +
      'Keep exactly one provider block in config/project.json.');
  }
  const provider = configured[0];
  const make = ADAPTERS[provider];
  if (!make) {
    throw configError(
      `Tracker provider '${provider}' is configured but not supported yet (a Phase 3 adapter). ` +
      `Supported today: ${Object.keys(ADAPTERS).join(', ')}.`);
  }
  return make({ cwd, fetch, timeoutMs });
}

module.exports = {
  resolveTracker,
  TrackerError,
  PAT_ENV_NAMES: ado.PAT_ENV_NAMES,
  JIRA_CRED_ENV_NAMES: jira.CRED_ENV_NAMES,
};
