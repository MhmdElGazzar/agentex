#!/usr/bin/env node
'use strict';
// AgenTeX plugin self-update — the mechanics behind /update-agentex step 0.
//
// Usage: node self_update.js check    freshness check against the plugin's own
//                                     marketplace (refreshes its local cache first)
//        node self_update.js pull     install the latest version (run ONLY after the
//                                     user's explicit yes — consent lives in the
//                                     command choosing to invoke this verb; there is
//                                     no interactive prompt here)
//
// Identity is derived at runtime from this script's own location — the plugin root
// is path.resolve(__dirname, '..'), and a marketplace install always sits at
// …/plugins/cache/<marketplace>/<plugin>/<version>. The plugin name comes from the
// plugin's own plugin.json (authoritative), cross-checked against the path segment;
// the marketplace name comes only from the path. Nothing is ever hardcoded.
//
// Comparison source: the marketplace's REFRESHED local cache
// (…/plugins/marketplaces/<marketplace>/.claude-plugin/marketplace.json) — the same
// source the installer uses, so check and pull can never disagree. No stale-cache
// comparison.
//
// Output: exactly ONE JSON line on stdout (diagnostics may go to stderr).
// Exit codes: 0 determinate answer (update-available / up-to-date / pulled),
// 2 check unavailable, 1 pull failure or unexpected error.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { compareVersions } = require('./lib/version.js');

const CHECK_TIMEOUT_MS = 60_000;    // marketplace cache refresh
const PULL_TIMEOUT_MS = 300_000;    // plugin install

// ── identity derivation ───────────────────────────────────────────────────────
// Parse a plugin root into { pluginsHome, marketplace, plugin, version } when its
// tail matches …/plugins/cache/<marketplace>/<plugin>/<version>; null otherwise
// (dev clone, hand-copied install). Accepts both win32 and POSIX separators — the
// consumer's Claude home is never assumed POSIX.
function parseInstallPath(pluginRoot) {
  const norm = String(pluginRoot).replace(/[\\/]+$/, '');
  const segs = norm.split(/[\\/]+/).filter(Boolean);
  if (segs.length < 5) return null;
  const [plugins, cache, marketplace, plugin, version] = segs.slice(-5);
  if (plugins !== 'plugins' || cache !== 'cache') return null;
  if (!marketplace || !plugin || !version) return null;
  let home = norm;
  for (let i = 0; i < 4; i++) {
    home = home.slice(0, Math.max(home.lastIndexOf('/'), home.lastIndexOf('\\')));
  }
  return { pluginsHome: home, marketplace, plugin, version };
}

function readOwnManifest(pluginRoot) {
  const file = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!manifest.name || !manifest.version) {
    throw new Error(`plugin manifest ${file} lacks name/version`);
  }
  return { name: manifest.name, installed: String(manifest.version) };
}

// Full identity: manifest (authoritative name + installed version) cross-checked
// against the install-path segments. Never trusts arguments for names.
function deriveIdentity(pluginRoot) {
  const manifest = readOwnManifest(pluginRoot);
  const parsed = parseInstallPath(pluginRoot);
  if (!parsed) {
    return {
      ok: false, reason: 'not-marketplace-install', installed: manifest.installed,
      detail: 'plugin root is not under the marketplace cache layout (plugins/cache/<marketplace>/<plugin>/<version>) — e.g. a local dev clone or hand-copied install',
    };
  }
  if (parsed.plugin !== manifest.name) {
    return {
      ok: false, reason: 'not-marketplace-install', installed: manifest.installed,
      detail: `plugin.json name "${manifest.name}" does not match the install path segment "${parsed.plugin}" — cannot trust this layout as a marketplace install`,
    };
  }
  return { ok: true, ...parsed, name: manifest.name, installed: manifest.installed };
}

// ── marketplace cache reading ─────────────────────────────────────────────────
// Returns { ok:true, latest } or { ok:false, reason, detail } with the
// check-unavailable reason vocabulary (cache-missing / marketplace-entry-missing).
function readLatestFromCache(identity) {
  const file = path.join(identity.pluginsHome, 'marketplaces', identity.marketplace,
    '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'cache-missing', detail: `marketplace cache file not found: ${file.replace(/\\/g, '/')} (marketplace.json)` };
  }
  let mp;
  try { mp = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    return { ok: false, reason: 'cache-missing', detail: `marketplace.json unreadable: ${e.message}` };
  }
  const entry = (Array.isArray(mp.plugins) ? mp.plugins : []).find(p => p && p.name === identity.name);
  if (!entry) {
    return { ok: false, reason: 'marketplace-entry-missing', detail: `no plugins[] entry named "${identity.name}" in the "${identity.marketplace}" marketplace cache` };
  }
  if (!entry.version) {
    return { ok: false, reason: 'marketplace-entry-missing', detail: `the "${identity.name}" entry in the "${identity.marketplace}" marketplace cache has no version field` };
  }
  return { ok: true, latest: String(entry.version) };
}

// ── claude CLI invocation ─────────────────────────────────────────────────────
// The composed call, pure and testable. Non-interactive by construction: stdin is
// 'ignore', so a CLI that tries to prompt hangs into the timeout — a loud
// cache-refresh-failed / pull-failed, never a silent stall. On win32 the claude
// CLI is a .cmd shim, so the call goes through the shell.
function buildCliCall(args, { platform, timeoutMs }) {
  return {
    command: 'claude',
    args,
    options: {
      shell: platform === 'win32',
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  };
}

// Default runner — swappable (tests inject a stub; nothing here is mocked-over).
// Returns { ok, timedOut, status, stdout, stderr }.
function defaultRunCli(args, { timeoutMs }) {
  const call = buildCliCall(args, { platform: process.platform, timeoutMs });
  const r = spawnSync(call.command, call.args, call.options);
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  return {
    ok: !r.error && r.status === 0,
    timedOut,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message || r.error) : ''),
  };
}

function describeCliFailure(args, r, timeoutMs) {
  const cmd = ['claude', ...args].join(' ');
  if (r.timedOut) return `${cmd} timed out after ${timeoutMs}ms (a hung or interactive CLI counts as failure)`;
  const err = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
  return `${cmd} failed: ${err}`;
}

// ── check ─────────────────────────────────────────────────────────────────────
function check({ pluginRoot, runCli }) {
  const identity = deriveIdentity(pluginRoot);
  if (!identity.ok) {
    return {
      result: { status: 'check-unavailable', reason: identity.reason, detail: identity.detail, installed: identity.installed },
      exitCode: 2,
    };
  }
  // Refresh the marketplace's local cache — the settled comparison source is the
  // REFRESHED cache; comparing stale data would let check and pull disagree.
  const refreshArgs = ['plugin', 'marketplace', 'update', identity.marketplace];
  const refresh = runCli(refreshArgs, { timeoutMs: CHECK_TIMEOUT_MS });
  if (!refresh.ok) {
    return {
      result: {
        status: 'check-unavailable', reason: 'cache-refresh-failed',
        detail: describeCliFailure(refreshArgs, refresh, CHECK_TIMEOUT_MS),
        installed: identity.installed,
      },
      exitCode: 2,
    };
  }
  const cached = readLatestFromCache(identity);
  if (!cached.ok) {
    return {
      result: { status: 'check-unavailable', reason: cached.reason, detail: cached.detail, installed: identity.installed },
      exitCode: 2,
    };
  }
  const base = {
    installed: identity.installed, latest: cached.latest,
    marketplace: identity.marketplace, plugin: identity.name,
  };
  const cmp = compareVersions(cached.latest, identity.installed);
  if (cmp > 0) return { result: { status: 'update-available', ...base }, exitCode: 0 };
  if (cmp === 0) return { result: { status: 'up-to-date', ...base }, exitCode: 0 };
  // Installed ahead of the marketplace (dev-ahead installs) — never offer a downgrade.
  return { result: { status: 'up-to-date', ...base, note: 'installed-ahead' }, exitCode: 0 };
}

// ── pull (consent already relayed by the command choosing this verb) ──────────
function pull({ pluginRoot, runCli }) {
  const identity = deriveIdentity(pluginRoot);
  if (!identity.ok) {
    return {
      result: { status: 'pull-failed', detail: `identity derivation failed: ${identity.detail}`, installed: identity.installed },
      exitCode: 1,
    };
  }
  // The target version comes from the marketplace cache `check` just refreshed —
  // without it there is nothing to verify a pull against, so fail closed BEFORE
  // installing anything.
  const cached = readLatestFromCache(identity);
  if (!cached.ok) {
    return {
      result: { status: 'pull-failed', detail: `cannot determine the latest version to pull: ${cached.detail}`, installed: identity.installed },
      exitCode: 1,
    };
  }
  const installArgs = ['plugin', 'install', `${identity.name}@${identity.marketplace}`];
  const install = runCli(installArgs, { timeoutMs: PULL_TIMEOUT_MS });
  if (!install.ok) {
    return {
      result: {
        status: 'pull-failed',
        detail: describeCliFailure(installArgs, install, PULL_TIMEOUT_MS),
        installed: identity.installed,
      },
      exitCode: 1,
    };
  }
  // Post-condition, verified deterministically (fail closed): the new versioned
  // dir exists and its plugin.json version equals the marketplace cache's latest.
  const landedManifest = path.join(identity.pluginsHome, 'cache', identity.marketplace,
    identity.name, cached.latest, '.claude-plugin', 'plugin.json');
  let landedVersion = null;
  try { landedVersion = String(JSON.parse(fs.readFileSync(landedManifest, 'utf8')).version); }
  catch { landedVersion = null; }
  if (landedVersion !== cached.latest) {
    return {
      result: {
        status: 'pull-failed',
        detail: `install command exited 0 but the post-condition failed: expected version ${cached.latest} under the marketplace cache dir, found ${landedVersion === null ? 'no readable plugin.json there' : `version ${landedVersion}`}`,
        installed: identity.installed,
      },
      exitCode: 1,
    };
  }
  return { result: { status: 'pulled', from: identity.installed, to: cached.latest }, exitCode: 0 };
}

// ── entry ─────────────────────────────────────────────────────────────────────
function main(argv, deps = {}) {
  const verb = argv[0];
  const pluginRoot = deps.pluginRoot || path.resolve(__dirname, '..');
  const runCli = deps.runCli || defaultRunCli;
  try {
    let out;
    if (verb === 'check') out = check({ pluginRoot, runCli });
    else if (verb === 'pull') out = pull({ pluginRoot, runCli });
    else {
      out = {
        result: { status: 'error', detail: `unknown subcommand "${verb || ''}" — usage: self_update.js check|pull` },
        exitCode: 1,
      };
    }
    return { line: JSON.stringify(out.result), exitCode: out.exitCode };
  } catch (e) {
    return { line: JSON.stringify({ status: 'error', detail: e.message }), exitCode: 1 };
  }
}

module.exports = {
  parseInstallPath, deriveIdentity, buildCliCall, check, pull, main,
  CHECK_TIMEOUT_MS, PULL_TIMEOUT_MS,
};

if (require.main === module) {
  const { line, exitCode } = main(process.argv.slice(2));
  process.stdout.write(line + '\n');
  process.exitCode = exitCode;   // never force-exit — set exitCode and let the event loop drain
}
