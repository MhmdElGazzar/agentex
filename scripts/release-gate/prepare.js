'use strict';
// Release-gate prepare — step 0 of the E2E release gate (design: release-e2e-gate).
//
// Creates the throwaway consumer project directory OUTSIDE the plugin repo
// (system temp dir, agentex-gate-<ts>), copies the tracker env values from the
// plugin repo's untracked .env into the throwaway project's .env (VALUES ARE
// NEVER PRINTED — invariant 5 / never-name rule), and detects sentinel vs live
// mode from the PAT prefix (EVAL_SENTINEL_PAT_ → sentinel, the evals' pattern).
//
// Output: exactly one JSON line on stdout — {"dir": "<path>", "mode": "sentinel"|"live"}.
// Exit codes: 0 ok · 2 configuration error (missing PAT, or live mode without
// org/project — fail closed, the tracker lane could not run).
//
// Sentinel mode is fully self-contained: when org/project are not configured,
// generic placeholders are written so descriptor composition and the flows run
// end to end with zero real values (they mirror the adapter tests' fixtures).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', 'lib', 'project_config.js'));
const { PAT_ENV_NAMES } = require(path.join(__dirname, '..', 'lib', 'tracker', 'adapters', 'ado.js'));

const SENTINEL_PREFIX = 'EVAL_SENTINEL_PAT_';

// Every tracker key the gate may carry into the throwaway project — exactly the
// adapter's env fallbacks (resolveConfig) plus the PAT names. Documented (key
// names only) in .env.example. Nothing outside this list ever travels.
const COPY_KEYS = [
  'AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT',
  'AZURE_URL', 'AZURE_PROJECT', 'AZURE_TEAM',
  'AZURE_AREA_PATH', 'AZURE_ITERATION_PATH', 'AZURE_BUG_TEMPLATE_ID',
  'AZURE_ASSIGNEE', 'AZURE_VALUE_AREA', 'AZURE_ENVIRONMENT', 'AZURE_BUG_CATEGORY',
  'AZURE_TEST_PLAN_ID', 'AZURE_API_VERSION',
];

// Generic sentinel-mode placeholders (never real values; same shape as the
// adapter tests and scripts/release-gate/fixtures/).
const SENTINEL_DEFAULTS = {
  AZURE_URL: 'https://dev.azure.com/exampleorg',
  AZURE_PROJECT: 'Sample Project',
};

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

function prepareRun({ sourceEnvDir, destParent } = {}) {
  const source = path.resolve(sourceEnvDir || path.resolve(__dirname, '..', '..'));
  const parent = path.resolve(destParent || os.tmpdir());

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
  const mode = pat.startsWith(SENTINEL_PREFIX) ? 'sentinel' : 'live';

  const lines = [];
  const copied = {};
  for (const key of COPY_KEYS) {
    const v = pc.readEnvVar(source, key);
    if (v !== null && v !== '') { lines.push(`${key}=${v}`); copied[key] = true; }
  }
  if (mode === 'sentinel') {
    for (const [key, v] of Object.entries(SENTINEL_DEFAULTS)) {
      if (!copied[key]) lines.push(`${key}=${v}`);
    }
  } else {
    const missing = [];
    if (!copied.AZURE_URL) missing.push('AZURE_URL');
    if (!copied.AZURE_PROJECT) missing.push('AZURE_PROJECT');
    if (missing.length) {
      throw configError(
        `Live mode needs the tracker org/project in the plugin repo's untracked .env — missing: ${missing.join(', ')}. ` +
        'The gate copies them into the throwaway project; it never asks anyone to type them (never-name rule).');
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const dir = fs.mkdtempSync(path.join(parent, `agentex-gate-${ts}-`));
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
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

module.exports = { prepareRun, COPY_KEYS, SENTINEL_PREFIX };
