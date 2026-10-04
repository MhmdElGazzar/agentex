#!/usr/bin/env node
'use strict';

// Copilot package-lifecycle adapter. Under GitHub Copilot there is no
// `claude`/`codex` plugin CLI: the plugin is installed as a locally built
// package registered via the host's `chat.pluginLocations` setting. This
// script is therefore a read-only CHECK ONLY:
//   - installed package  = the package this script is packaged inside
//     (`package-integrity.json` at the package root — set by the Copilot
//     package build; this script always runs from `<package>/scripts/`);
//   - shared core source = the verified `coreRoot` from resolve_runtime.js;
//   - consumer project   = the stamp state via the shared scaffold/version
//     libs (same semantics as scripts/codex_update.js projectState).
// It NEVER writes project files, never refreshes, never publishes, and never
// touches host cache files. Refresh means rebuilding + re-registering the
// local package, which stays a user-directed action described by the
// agentex-update skill. Project migration remains scripts/migrate.js.
// In SOURCE mode (running from copilot/scripts in the repo), the "installed
// package" IS this source tree; package-integrity.json is only present in
// built packages, and the check reports that state honestly.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveRuntime } = require('./resolve_runtime.js');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Shared libs are loaded from the RESOLVED core root, never from a hardcoded
// path: in a built package they live at <package>/core/..., while in source
// mode coreRoot is the repo root itself. One resolution, one code path.
function coreLibs(coreRoot) {
  return {
    scaffold: require(path.join(coreRoot, 'scripts', 'lib', 'scaffold.js')),
    version: require(path.join(coreRoot, 'scripts', 'lib', 'version.js')),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Installed package identity: the package-integrity.json beside this script
// (the package root is exactly one level up from scripts/).
function installedPackage(packageRoot) {
  const file = path.join(packageRoot, 'package-integrity.json');
  if (!fs.existsSync(file)) return { name: null, version: null, fingerprint: null, file };
  const integrity = readJson(file);
  const files = integrity.files || {};
  const fingerprint = sha256(Object.keys(files).sort().map((relative) => files[relative]).join(':'));
  return { name: integrity.name || null, version: integrity.version || null, fingerprint, file };
}

function coreVersion(coreRoot) {
  return readJson(path.join(coreRoot, '.claude-plugin', 'plugin.json')).version;
}

// Copilot package source freshness: package version vs core version plus an
// exact package-vs-core identity probe over the entry skill contracts.
function pluginActionFor({ package: pkg, packageRoot, coreVer, requestedRefresh, version: versionLib }) {
  if (!pkg.version) return 'unknown';
  const cmp = versionLib.compareVersions(pkg.version, coreVer);
  if (cmp > 0) return 'newer-than-source';
  if (cmp < 0 || requestedRefresh) return 'refresh';
  // Same version: confirm the registered package is the current build by
  // checking every entry skill exists in the package skills directory.
  const skillsDir = path.join(packageRoot, 'skills');
  const missing = CORE_ENTRY_SKILLS.filter((skill) => !fs.existsSync(path.join(skillsDir, skill, 'SKILL.md')));
  return missing.length ? 'rebuild' : 'none';
}

const CORE_ENTRY_SKILLS = [
  'agentex-init', 'agentex-ask-kb', 'agentex-test', 'agentex-define-flow',
  'agentex-estimate-story', 'agentex-design-test', 'agentex-bug-report-azure', 'agentex-update',
];

function projectState(projectRoot, sourceVersion, { scaffold, version }) {
  const stamp = scaffold.inspectVersionStamp(projectRoot);
  if (stamp.kind === 'malformed') return { version: null, state: 'malformed', migrationNeeded: false };
  if (stamp.kind === 'missing') return { version: null, state: 'legacy-unstamped', migrationNeeded: true };
  const cmp = version.compareVersions(stamp.version, sourceVersion);
  return { version: stamp.version, state: cmp > 0 ? 'future' : cmp < 0 ? 'older' : 'current', migrationNeeded: cmp < 0 };
}

function forecast(coreRoot, projectRoot, scaffold) {
  const actions = scaffold.scaffoldProject(projectRoot, coreRoot, { dryRun: true })
    .filter((a) => a.kind === 'created').map((a) => a.path);
  actions.push('.agentex/version.json');
  return actions;
}

function makeDigest(plan) {
  return sha256(JSON.stringify({
    coreVersion: plan.coreVersion, packageVersion: plan.packageVersion,
    packageFingerprint: plan.packageFingerprint, packageAction: plan.packageAction,
    requestedRefresh: plan.requestedRefresh, projectRoot: plan.projectRoot,
    projectVersion: plan.projectVersion, projectState: plan.projectState,
    migrationNeeded: plan.migrationNeeded,
  }));
}

// Returns { code, out }; prints nothing. opts.installed is a test seam.
function check({ packageRoot = path.resolve(__dirname, '..'), projectRoot = process.cwd(),
  requestedRefresh = false, installed } = {}) {
  const pkg = installed || installedPackage(packageRoot);
  const pkgVersion = pkg.version;
  let coreRoot; let coreVer; let libs;
  try {
    ({ coreRoot } = resolveRuntime({ packageRoot }));
    coreVer = coreVersion(coreRoot);
    libs = coreLibs(coreRoot);
  } catch (e) {
    return { code: 2, out: { ok: false, mode: 'check', blocked: `runtime resolution failed: ${e.message}` } };
  }
  const project = fs.realpathSync(projectRoot);
  const info = projectState(project, coreVer, libs);
  const blocked = info.state === 'future' ? 'consumer project is newer than this AgenTeX source; refusing downgrade'
    : info.state === 'malformed' ? 'consumer project version stamp is malformed; refusing migration'
      : pkgVersion && libs.version.compareVersions(pkgVersion, coreVer) > 0 ? 'installed Copilot package is newer than this core; refusing downgrade'
        : null;
  const packageAction = pluginActionFor({
    package: pkg, packageRoot, coreVer, requestedRefresh, version: libs.version,
  });
  const plan = {
    ok: !blocked,
    mode: 'check',
    host: 'github-copilot',
    packageVersion: pkgVersion,
    packageFingerprint: pkg.fingerprint,
    coreVersion: coreVer,
    coreRoot,
    packageAction,
    requestedRefresh: Boolean(requestedRefresh),
    projectRoot: project,
    projectVersion: info.version,
    projectState: info.state,
    migrationNeeded: info.migrationNeeded,
    expectedProjectFiles: info.migrationNeeded ? forecast(coreRoot, project, libs.scaffold) : [],
    forecastNote: 'Scaffold additions + version stamp only; legacy migration steps may affect more files. The shared migrator requires a clean Git rollback point.',
    ...(blocked ? { blocked } : {}),
  };
  plan.approvalDigest = makeDigest(plan);
  return { code: blocked ? 2 : 0, out: plan };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--refresh-requested') args.refresh = true;
    else if (a === '--installed-json') args.installedJson = argv[++i];
  }
  const result = check({
    projectRoot: args.project || process.cwd(),
    requestedRefresh: Boolean(args.refresh),
    ...(args.installedJson ? { installed: JSON.parse(fs.readFileSync(args.installedJson, 'utf8')) } : {}),
  });
  process.stdout.write(JSON.stringify(result.out) + '\n');
  return result.code;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, installedPackage, projectState, coreVersion, CORE_ENTRY_SKILLS };
