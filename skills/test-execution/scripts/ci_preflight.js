'use strict';
// AgenTeX CI preflight — the GATING preflight a CI attempt runs before spending a
// session. Unlike preflight.js (informational, always exit 0), every failed check
// here closes the gate: exit 2 with a named preflight-* reason. Exit 2 — never 1:
// an environment problem must never masquerade as product defects.
//
// Usage: node ci_preflight.js [--env <name>] [--needs browser,api,db] [--plugin-root <path>]
//        (run from the consumer project root; --plugin-root is for tests/callers,
//         default: this script's own plugin)
//
// Prints ONE JSON line:
//   { ok, needs, checks: { tools, target, apiTarget, environment, secrets, browser, pluginVersion },
//     blockedReasons: [{ code, detail }] }
//
// --needs names the drivers the run's specs use (spec_drivers.js); default: browser.
// Browser-only checks (playwright-cli, portalUrl, browser binary) gate ONLY when browser
// is needed, so an API/DB-only run never demands a browser. Needs api: the env's
// api.baseUrl answers HTTP (skipped when the env has no api block — the catalog then
// resolves its own target). Needs db: sqlcmd is usable.
//
// The checks (design: ci-quality-gate):
//   preflight-tools           node; + playwright-cli usable when browser is needed
//                             (posture-fixed probe — judged by output, the benign
//                             exit-crash never gates); + sqlcmd usable when db is needed
//   preflight-target          browser: the environment's portalUrl answers HTTP; api:
//                             its api.baseUrl answers HTTP — ANY response counts (a 500
//                             is the app's problem to fail scenarios on, not preflight's)
//   preflight-environment     named env file exists / defaultEnvironment resolves /
//                             legacy QA_TARGET_URL — never a silent fallback
//   preflight-secrets         every { envSecret: NAME } referenced by the active
//                             environment, config/project.json and integration/
//                             catalogs resolves via process.env or .env — missing
//                             NAMES are listed; a VALUE is never printed
//   preflight-browser         (browser only) a Playwright browser binary is present on disk
//                             (deterministic filesystem check, no exit codes)
//   preflight-plugin-version  plugin manifest + project stamp reported; gates ONLY
//                             on an unreadable plugin manifest — version drift is
//                             report-only (drift: true), never gate-closing
//
// Secrets discipline: names only, never values. Diagnostics go to stderr; stdout
// carries exactly one JSON line. exitCode + event-loop drain — never process.exit
// after async work (the 0.20.1 doctrine; the exit code IS the product here).
const fs = require('node:fs');
const path = require('node:path');
const { probe, probePlaywrightCli } = require(path.join(__dirname, 'preflight.js'));
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const TARGET_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') out.env = argv[++i];
    else if (argv[i] === '--plugin-root') out.pluginRoot = argv[++i];
    else if (argv[i] === '--needs') out.needs = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// Deep-walk any JSON value collecting { envSecret: "NAME" } references.
function collectEnvSecretNames(value, names = new Set()) {
  if (Array.isArray(value)) { for (const v of value) collectEnvSecretNames(v, names); return names; }
  if (value && typeof value === 'object') {
    if (typeof value.envSecret === 'string' && value.envSecret.trim()) names.add(value.envSecret.trim());
    for (const v of Object.values(value)) collectEnvSecretNames(v, names);
  }
  return names;
}

function readJsonQuietly(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// --- checks -------------------------------------------------------------------

function checkEnvironment(cwd, envName) {
  try {
    const env = pc.loadEnvironment(cwd, envName || null); // throws when a wanted env has no file
    if (env) return { ok: true, name: env.name, legacy: false, env };
    const legacyTarget = pc.readEnvVar(cwd, 'QA_TARGET_URL');
    if (legacyTarget) return { ok: true, name: null, legacy: true, legacyTarget };
    return {
      ok: false, name: null, legacy: false,
      error: 'no environment resolves — no --env given, no defaultEnvironment in config/project.json, and no legacy QA_TARGET_URL in .env',
    };
  } catch (e) {
    return { ok: false, name: envName || null, legacy: false, error: e.message };
  }
}

// ANY HTTP response = reachable; only a transport failure or timeout fails.
async function probeUrl(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(TARGET_TIMEOUT_MS) });
      return { ok: true, url, status: res.status };
    } catch (e) {
      if (method === 'GET') {
        const msg = e && (e.name === 'TimeoutError' || e.name === 'AbortError')
          ? `no response within ${TARGET_TIMEOUT_MS}ms` : (e && (e.cause && e.cause.message || e.message)) || String(e);
        return { ok: false, url, error: msg };
      }
    }
  }
  return { ok: false, url, error: 'unreachable' };
}

async function checkTarget(environment) {
  if (!environment.ok) return { ok: false, error: 'skipped: environment did not resolve' };
  const url = environment.legacy ? environment.legacyTarget : (environment.env && environment.env.portalUrl);
  if (!url) {
    return { ok: false, error: `portalUrl missing in environments/${environment.name}.json` };
  }
  return probeUrl(url);
}

async function checkApiTarget(cwd, environment) {
  if (!environment.ok) return { ok: false, error: 'skipped: environment did not resolve' };
  if (environment.legacy) return { ok: true, skipped: 'legacy project — the integration catalog resolves its own target' };
  const api = pc.resolveApiTarget(cwd, environment.name);
  if (!api) return { ok: true, skipped: `no api block in environments/${environment.name}.json — the integration catalog resolves its own target` };
  return probeUrl(api.baseUrl);
}

function checkSecrets(cwd, environment) {
  const names = new Set();
  if (environment.ok && environment.env) collectEnvSecretNames(environment.env, names);
  collectEnvSecretNames(pc.loadProjectConfig(cwd), names);
  const intDir = path.join(cwd, 'integration');
  if (fs.existsSync(intDir)) {
    for (const f of fs.readdirSync(intDir).filter((f) => f.endsWith('.json'))) {
      const cat = readJsonQuietly(path.join(intDir, f));
      if (cat) collectEnvSecretNames(cat, names);
      else process.stderr.write(`ci_preflight: integration/${f} is not valid JSON — skipped for secret-name collection\n`);
    }
  }
  const required = [...names].sort();
  const missing = required.filter((n) => pc.readEnvVar(cwd, n) === null);
  return { ok: missing.length === 0, required, missing };
}

const SKIPPED = { ok: null, skipped: 'not needed by this run' };

// AGENTEX_SQLCMD_PROBE_CMD is a fixture-only test seam, like AGENTEX_PWCLI_PROBE_CMD.
function probeSqlcmd() {
  const seam = process.env.AGENTEX_SQLCMD_PROBE_CMD;
  return seam ? probe(seam, []) : probe('sqlcmd', ['--version']);
}

function checkTools(needs) {
  const tools = {
    node: { ok: true, version: process.version },
    'playwright-cli': needs.has('browser') ? probePlaywrightCli() : SKIPPED,
    sqlcmd: needs.has('db') ? probeSqlcmd() : SKIPPED,
  };
  const failed = ['playwright-cli', 'sqlcmd'].filter((k) => tools[k].ok === false);
  return { ok: tools.node.ok && failed.length === 0, failed, ...tools };
}

function defaultBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = require('node:os').homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

function checkBrowser() {
  const dir = defaultBrowsersDir();
  let found = [];
  try { found = fs.readdirSync(dir).filter((e) => /^(chromium|firefox|webkit)/.test(e)); } catch { /* missing dir */ }
  if (found.length) return { ok: true, dir, found };
  return { ok: false, dir, found, error: `no Playwright browser found under ${dir} — run: npx playwright-cli install-browser chromium` };
}

function checkPluginVersion(cwd, pluginRoot) {
  const manifest = readJsonQuietly(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  if (!manifest || !manifest.version) {
    return { ok: false, plugin: null, project: null, drift: false, error: `plugin manifest unreadable at ${path.join(pluginRoot, '.claude-plugin', 'plugin.json')}` };
  }
  const stamp = readJsonQuietly(path.join(cwd, '.agentex', 'version.json'));
  const project = (stamp && stamp.version) || null;
  const drift = Boolean(project && project !== manifest.version);
  if (drift) process.stderr.write(`ci_preflight: plugin ${manifest.version} vs project stamp ${project} — drift reported, not gating (run /update-agentex)\n`);
  return { ok: true, plugin: manifest.version, project, drift };
}

// --- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const pluginRoot = args.pluginRoot || path.resolve(__dirname, '..', '..', '..');

  const needs = new Set(args.needs && args.needs.length ? args.needs : ['browser']);

  const environment = checkEnvironment(cwd, args.env);
  const target = needs.has('browser') ? await checkTarget(environment) : { ok: true, skipped: 'no browser steps in this run' };
  const apiTarget = needs.has('api') ? await checkApiTarget(cwd, environment) : SKIPPED;
  const tools = checkTools(needs);
  const secrets = checkSecrets(cwd, environment);
  const browser = needs.has('browser') ? checkBrowser() : { ok: true, skipped: 'no browser steps in this run' };
  const pluginVersion = checkPluginVersion(cwd, pluginRoot);

  const blockedReasons = [];
  if (!tools.ok) blockedReasons.push({ code: 'preflight-tools', detail: tools.failed.map((k) => `${k}: ${tools[k].error || 'unusable'}`).join('; ') || 'a required tool is unusable' });
  if (!target.ok) blockedReasons.push({ code: 'preflight-target', detail: target.url ? `${target.url}: ${target.error}` : target.error });
  if (apiTarget.ok === false) blockedReasons.push({ code: 'preflight-target', detail: `api ${apiTarget.url ? `${apiTarget.url}: ${apiTarget.error}` : apiTarget.error}` });
  if (!environment.ok) blockedReasons.push({ code: 'preflight-environment', detail: environment.error });
  if (!secrets.ok) blockedReasons.push({ code: 'preflight-secrets', detail: `missing secret values for: ${secrets.missing.join(', ')} — provide them by NAME via the CI secret store or .env` });
  if (!browser.ok) blockedReasons.push({ code: 'preflight-browser', detail: browser.error });
  if (!pluginVersion.ok) blockedReasons.push({ code: 'preflight-plugin-version', detail: pluginVersion.error });

  const view = (c) => ({ ok: c.ok, ...(c.url ? { url: c.url } : {}), ...(c.status !== undefined ? { status: c.status } : {}), ...(c.error ? { error: c.error } : {}), ...(c.skipped ? { skipped: c.skipped } : {}) });
  const out = {
    ok: blockedReasons.length === 0,
    needs: [...needs].sort(),
    checks: {
      tools: { ok: tools.ok, node: tools.node, 'playwright-cli': tools['playwright-cli'], sqlcmd: tools.sqlcmd },
      target: view(target),
      apiTarget: view(apiTarget),
      environment: { ok: environment.ok, name: environment.name, legacy: environment.legacy, ...(environment.error ? { error: environment.error } : {}) },
      secrets,
      browser,
      pluginVersion,
    },
    blockedReasons,
  };
  console.log(JSON.stringify(out));
  process.exitCode = out.ok ? 0 : 2;
}

if (require.main === module) {
  main().catch((e) => {
    // Fail closed: an unexpected error is an environment/indeterminate problem — exit 2.
    console.log(JSON.stringify({ ok: false, blockedReasons: [{ code: 'preflight-tools', detail: `ci_preflight crashed: ${e.message}` }] }));
    process.exitCode = 2;
  });
}

module.exports = { collectEnvSecretNames };
