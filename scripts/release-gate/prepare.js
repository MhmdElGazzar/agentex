'use strict';
// Release-gate prepare — step 0 of the E2E release gate (design: release-e2e-gate).
//
// Creates the throwaway consumer project directory OUTSIDE the plugin repo
// (system temp dir, agentex-gate-<ts>) and detects sentinel vs live mode from
// the PAT prefix (EVAL_SENTINEL_PAT_ → sentinel, the evals' pattern). It READS
// the plugin repo's untracked .env for detection only (VALUES ARE NEVER
// PRINTED — invariant 5 / never-name rule) and writes NOTHING into the
// throwaway dir: to scripts/init.js the dir must look like a genuinely fresh
// consumer folder, or hasLegacySignals() fires and init takes the
// legacy/migration branch instead of the fresh-consumer path the gate attests
// (design Amendment 1). Tracker env values are injected AFTER the wizard's
// /api/done by inject-env.js, before the tracker lane.
//
// Output: exactly one JSON line on stdout — {"dir": "<path>", "mode": "sentinel"|"live"}.
// Exit codes: 0 ok · 2 configuration error (missing PAT, or live mode without
// org/project — fail closed early, before a wizard run is wasted).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', 'lib', 'project_config.js'));
const { PAT_ENV_NAMES } = require(path.join(__dirname, '..', 'lib', 'tracker', 'adapters', 'ado.js'));

const SENTINEL_PREFIX = 'EVAL_SENTINEL_PAT_';

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// Resolve the PAT (mode detection) from the source dir's .env / process env.
// Shared with inject-env.js — one detection, no drift. Fail closed: no PAT is
// exit 2 naming every key and the sentinel option.
function detectMode(source) {
  let pat = null;
  for (const name of PAT_ENV_NAMES) {
    const v = pc.readEnvVar(source, name);
    if (v) { pat = v; break; }
  }
  if (!pat) {
    throw configError(
      `No PAT found — looked for ${PAT_ENV_NAMES.join(', ')} in the environment and in ${path.join(source, '.env')}. ` +
      `For a sentinel-mode gate run set AZURE_PAT=${SENTINEL_PREFIX}<anything>; a live run needs the real PAT there.`);
  }
  return pat.startsWith(SENTINEL_PREFIX) ? 'sentinel' : 'live';
}

// Live mode needs org/project in the source .env (inject-env will copy them
// later; prepare checks early so a doomed run fails before the wizard).
function assertLiveSourceComplete(source) {
  const missing = [];
  if (!pc.readEnvVar(source, 'AZURE_URL')) missing.push('AZURE_URL');
  if (!pc.readEnvVar(source, 'AZURE_PROJECT')) missing.push('AZURE_PROJECT');
  if (missing.length) {
    throw configError(
      `Live mode needs the tracker org/project in the plugin repo's untracked .env — missing: ${missing.join(', ')}. ` +
      'inject-env.js copies them into the throwaway project after the wizard; it never asks anyone to type them (never-name rule).');
  }
}

function prepareRun({ sourceEnvDir, destParent } = {}) {
  const source = path.resolve(sourceEnvDir || path.resolve(__dirname, '..', '..'));
  const parent = path.resolve(destParent || os.tmpdir());

  const mode = detectMode(source);
  if (mode === 'live') assertLiveSourceComplete(source);

  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const dir = fs.mkdtempSync(path.join(parent, `agentex-gate-${ts}-`));
  return { dir, mode };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// node prepare.js [--source-env-dir <plugin-repo-root>] [--dest-parent <dir>]
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw configError(`bad flag pair near ${argv[i]}`);
      flags[argv[i].slice(2)] = argv[i + 1];
    }
    const { dir, mode } = prepareRun({ sourceEnvDir: flags['source-env-dir'], destParent: flags['dest-parent'] });
    console.log(JSON.stringify({ dir, mode }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = { prepareRun, detectMode, assertLiveSourceComplete, configError, SENTINEL_PREFIX };
