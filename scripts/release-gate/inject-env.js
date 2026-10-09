'use strict';
// Release-gate inject-env — the post-wizard env injection step (design Amendment 1).
//
// Runs AFTER the wizard's /api/done and BEFORE the tracker lane. Copies the
// documented tracker keys from the plugin repo's untracked .env into the
// throwaway consumer project's .env — append/merge, never clobbering a
// wizard-written value (a key already holding a non-empty value is preserved
// verbatim). VALUES ARE NEVER PRINTED (invariant 5 / never-name rule): stdout
// carries key NAMES only.
//
// This step exists because injection cannot happen before scripts/init.js:
// AZURE_URL / AZURE_PROJECT are ENV_KEY_MAP legacy signals, and pre-seeding
// them made init take the legacy/migration branch instead of the fresh-consumer
// path the gate attests. prepare.js therefore seeds nothing; this script closes
// the gap once the wizard is done.
//
// Output: exactly one JSON line on stdout —
//   {"ok": true, "mode": "sentinel"|"live", "injected": [keys], "preserved": [keys]}.
// Exit codes: 0 ok · 2 configuration error (missing PAT — the message names the
// sentinel option — or live mode without org/project; fail closed, nothing is
// written on failure).
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', 'lib', 'project_config.js'));
const { detectMode, assertLiveSourceComplete, configError } = require(path.join(__dirname, 'prepare.js'));

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
// adapter tests and scripts/release-gate/fixtures/) so descriptor composition
// runs end to end with zero real values.
const SENTINEL_DEFAULTS = {
  AZURE_URL: 'https://dev.azure.com/exampleorg',
  AZURE_PROJECT: 'Sample Project',
};

function injectEnv({ destDir, sourceEnvDir } = {}) {
  if (!destDir) throw configError('usage: node inject-env.js <throwaway-dir> [--source-env-dir <plugin-repo-root>]');
  const dest = path.resolve(destDir);
  const source = path.resolve(sourceEnvDir || path.resolve(__dirname, '..', '..'));

  // Fail-closed validation first — nothing is written unless the run can proceed.
  const mode = detectMode(source);
  if (mode === 'live') assertLiveSourceComplete(source);

  // What travels: source values for the documented keys, plus generic
  // placeholders in sentinel mode so the tracker lane composes without real values.
  const values = {};
  for (const key of COPY_KEYS) {
    const v = pc.readEnvVar(source, key);
    if (v !== null && v !== '') values[key] = v;
  }
  if (mode === 'sentinel') {
    for (const [key, v] of Object.entries(SENTINEL_DEFAULTS)) {
      if (!(key in values)) values[key] = v;
    }
  }

  // Merge into the throwaway .env: a non-empty existing value is the wizard's
  // (or the consumer's) — preserved verbatim; an empty scaffolded `KEY=` line is
  // filled in place; a missing key is appended. Everything else is untouched.
  const envFile = path.join(dest, '.env');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const lines = existing === '' ? [] : existing.split(/\r?\n/);

  const injected = [];
  const preserved = [];
  const handled = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !(m[1] in values) || handled.has(m[1])) continue;
    handled.add(m[1]);
    if (m[2].trim() !== '') {
      preserved.push(m[1]);            // wizard-written value wins — never clobbered
    } else {
      lines[i] = `${m[1]}=${values[m[1]]}`;
      injected.push(m[1]);             // scaffolded keys-only line, filled in place
    }
  }
  const toAppend = Object.keys(values).filter(k => !handled.has(k));
  if (toAppend.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const key of toAppend) { lines.push(`${key}=${values[key]}`); injected.push(key); }
  }
  if (injected.length) fs.writeFileSync(envFile, lines.join('\n') + '\n');

  return { ok: true, mode, injected, preserved };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// node inject-env.js <throwaway-dir> [--source-env-dir <plugin-repo-root>]
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    let destDir = null;
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('--')) {
        if (argv[i + 1] === undefined) throw configError(`bad flag pair near ${argv[i]}`);
        flags[argv[i].slice(2)] = argv[++i];
      } else if (destDir === null) {
        destDir = argv[i];
      } else {
        throw configError(`unexpected argument: ${argv[i]}`);
      }
    }
    console.log(JSON.stringify(injectEnv({ destDir, sourceEnvDir: flags['source-env-dir'] })));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = { injectEnv, COPY_KEYS, SENTINEL_DEFAULTS };
