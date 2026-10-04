#!/usr/bin/env node
'use strict';

// Codex package-lifecycle adapter. Project migration remains scripts/migrate.js.
// check is non-destructive; refresh needs a saved, reviewed check result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const scaffold = require('./lib/scaffold.js');
const { compareVersions, isReleaseVersion } = require('./lib/version.js');
const { acquireUpdateLock } = require('./lib/update_lock.js');

const SKILLS = [
  'agentex-init', 'agentex-test', 'agentex-executor', 'agentex-define-flow',
  'agentex-ask-kb', 'agentex-estimate-story', 'agentex-design-test',
  'agentex-bug-report-azure', 'agentex-update',
];
const CRITICAL = [
  ...SKILLS.map((skill) => path.join('skills', skill, 'SKILL.md')),
  'scripts/codex_update.js', 'scripts/migrate.js', 'scripts/lib/scaffold.js',
];
const LIST_TIMEOUT = 30_000;
const ADD_TIMEOUT = 300_000;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const validName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);

function defaultRunCli(args, timeoutMs) {
  const result = spawnSync('codex', args, {
    encoding: 'utf8', timeout: timeoutMs, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''), status: result.status };
}

function sourceRelease(pluginRoot) {
  const versions = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']
    .map((relative) => JSON.parse(fs.readFileSync(path.join(pluginRoot, relative), 'utf8')));
  if (versions.some((m) => m.name !== 'agentex' || !isReleaseVersion(m.version) || m.version !== versions[0].version)) {
    throw new Error('AgenTeX source manifests disagree or contain a malformed version');
  }
  return versions[0].version;
}

function trustedSourceRoot(runtimeRoot, entry) {
  if (!entry || entry.source?.source !== 'local') return runtimeRoot;
  const candidate = fs.realpathSync(entry.source.path);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'agentex') throw new Error('Codex marketplace source is not AgenTeX');
  return candidate;
}

function sourceFingerprint(source) {
  return sha256(CRITICAL.map((relative) => sha256(fs.readFileSync(path.join(source, relative)))).join(':'));
}

function installedEntry(runCli, pluginInventory) {
  let raw;
  if (pluginInventory) raw = typeof pluginInventory === 'string' ? pluginInventory : JSON.stringify(pluginInventory);
  else {
    const response = runCli(['plugin', 'list', '--json'], LIST_TIMEOUT);
    if (!response.ok) throw new Error(`codex plugin list failed: ${(response.stderr || response.stdout).trim().slice(0, 500)}`);
    raw = response.stdout;
  }
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('codex plugin list returned invalid JSON'); }
  const entries = (data.installed || []).filter((entry) => entry.name === 'agentex' && entry.installed === true);
  if (entries.length > 1) throw new Error('multiple AgenTeX Codex installations found; select one before updating');
  const entry = entries[0] || null;
  if (entry && (!validName(entry.marketplaceName) || !isReleaseVersion(entry.version))) {
    throw new Error('installed AgenTeX identity or version is malformed');
  }
  return entry;
}

function projectState(projectRoot, sourceVersion) {
  const stamp = scaffold.inspectVersionStamp(projectRoot);
  if (stamp.kind === 'malformed') return { version: null, state: 'malformed', migrationNeeded: false };
  if (stamp.kind === 'missing') return { version: null, state: 'legacy-unstamped', migrationNeeded: true };
  const cmp = compareVersions(stamp.version, sourceVersion);
  return { version: stamp.version, state: cmp > 0 ? 'future' : cmp < 0 ? 'older' : 'current', migrationNeeded: cmp < 0 };
}

function makeDigest(plan) {
  return sha256(JSON.stringify({ sourceVersion: plan.sourceVersion, installedVersion: plan.installedVersion,
    sourceFingerprint: plan.sourceFingerprint, runtimeFingerprint: plan.runtimeFingerprint,
    pluginId: plan.pluginId, pluginAction: plan.pluginAction, requestedRefresh: plan.requestedRefresh,
    projectRoot: plan.projectRoot, projectVersion: plan.projectVersion,
    projectState: plan.projectState, migrationNeeded: plan.migrationNeeded }));
}

function check({ pluginRoot = path.resolve(__dirname, '..'), projectRoot = process.cwd(), runCli = defaultRunCli,
  requestedRefresh = false, pluginInventory } = {}) {
  const source = fs.realpathSync(pluginRoot);
  const project = fs.realpathSync(projectRoot);
  const installed = installedEntry(runCli, pluginInventory);
  const availableSource = trustedSourceRoot(source, installed);
  const sourceVersion = sourceRelease(availableSource);
  const sourceHash = sourceFingerprint(availableSource);
  let runtimeHash = null;
  try { runtimeHash = sourceFingerprint(source); } catch { /* an older package may lack a new skill */ }
  const projectInfo = projectState(project, sourceVersion);
  let pluginAction = 'none';
  let blocked = null;
  if (!installed) blocked = 'AgenTeX is not installed in Codex; install it from a trusted marketplace first';
  else if (compareVersions(installed.version, sourceVersion) > 0) blocked = 'installed Codex plugin is newer than this source; refusing downgrade';
  else if (compareVersions(installed.version, sourceVersion) < 0 || requestedRefresh || runtimeHash !== sourceHash) pluginAction = 'refresh';
  if (projectInfo.state === 'future') blocked = 'consumer project is newer than this AgenTeX source; refusing downgrade';
  if (projectInfo.state === 'malformed') blocked = 'consumer project version stamp is malformed; refusing migration';
  let forecast = [];
  if (projectInfo.migrationNeeded) {
    forecast = scaffold.scaffoldProject(project, availableSource, { dryRun: true })
      .filter((a) => a.kind === 'created').map((a) => a.path);
    forecast.push('.agentex/version.json');
  }
  const plan = {
    ok: !blocked, mode: 'check', sourceVersion, sourceRoot: availableSource,
    sourceFingerprint: sourceHash, runtimeFingerprint: runtimeHash, installedVersion: installed?.version || null,
    pluginId: installed ? `agentex@${installed.marketplaceName}` : null,
    pluginAction, requestedRefresh: Boolean(requestedRefresh), projectRoot: project,
    projectVersion: projectInfo.version, projectState: projectInfo.state,
    migrationNeeded: projectInfo.migrationNeeded, expectedProjectFiles: [...new Set(forecast)],
    forecastNote: 'Scaffold additions and version stamp only; legacy migration steps may affect more files. Review the shared migrator report and require a clean Git rollback point.',
    ...(blocked ? { blocked } : {}),
  };
  plan.approvalDigest = makeDigest(plan);
  return { code: blocked ? 2 : 0, out: plan };
}

function verifyInstalled(source, installedPath, sourceVersion) {
  if (!installedPath || !fs.existsSync(installedPath)) throw new Error('Codex add returned no readable installedPath');
  const manifest = JSON.parse(fs.readFileSync(path.join(installedPath, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'agentex' || manifest.version !== sourceVersion) throw new Error('installed package version does not match source');
  for (const relative of CRITICAL) {
    const expected = sha256(fs.readFileSync(path.join(source, relative)));
    const actual = sha256(fs.readFileSync(path.join(installedPath, relative)));
    if (expected !== actual) throw new Error(`installed package hash mismatch: ${relative}`);
  }
  return { installedPath, verifiedSkills: SKILLS.length };
}

function refresh({ pluginRoot = path.resolve(__dirname, '..'), projectRoot = process.cwd(),
  approvedPlan, runCli = defaultRunCli, pluginInventory } = {}) {
  if (!approvedPlan) return { code: 2, out: { ok: false, mode: 'refresh', blocked: 'saved approved plan is required' } };
  let saved;
  try { saved = JSON.parse(fs.readFileSync(approvedPlan, 'utf8')); }
  catch { return { code: 2, out: { ok: false, mode: 'refresh', blocked: 'approved plan is unreadable' } }; }
  const current = check({ pluginRoot, projectRoot, runCli, pluginInventory, requestedRefresh: saved.requestedRefresh === true });
  if (current.code !== 0 || current.out.approvalDigest !== saved.approvalDigest || saved.ok !== true ||
      saved.pluginAction !== 'refresh' || !validName(saved.pluginId?.split('@')[1]) ||
      saved.pluginId !== current.out.pluginId) {
    return { code: 2, out: { ok: false, mode: 'refresh', blocked: 'approved update plan is stale or does not authorize a plugin refresh' } };
  }
  let lock;
  try { lock = acquireUpdateLock('plugin', pluginRoot); }
  catch (e) { return { code: 2, out: { ok: false, mode: 'refresh', blocked: e.message } }; }
  try {
    const response = runCli(['plugin', 'add', saved.pluginId, '--json'], ADD_TIMEOUT);
    if (!response.ok) throw new Error(`codex plugin add failed: ${(response.stderr || response.stdout).trim().slice(0, 500)}`);
    let result;
    try { result = JSON.parse(response.stdout); }
    catch { throw new Error('codex plugin add returned invalid JSON'); }
    const verified = verifyInstalled(current.out.sourceRoot, result.installedPath, current.out.sourceVersion);
    return { code: 0, out: { ok: true, mode: 'refreshed', pluginId: saved.pluginId,
      from: current.out.installedVersion, to: current.out.sourceVersion, ...verified,
      migrationNeeded: current.out.migrationNeeded,
      note: 'start a fresh Codex session to discover the refreshed installed package' } };
  } catch (e) {
    return { code: 1, out: { ok: false, mode: 'refresh', error: e.message,
      migrationNotRun: true, note: 'reconcile plugin installation before consumer migration' } };
  } finally { lock.release(); }
}

// In sandboxed Codex sessions, a direct CLI tool call can be allowed even when
// Node cannot spawn codex.exe. These two pure handoff operations retain the
// adapter's selector, approval binding, and installed-package verification.
function refreshCommand({ pluginRoot = path.resolve(__dirname, '..'), projectRoot = process.cwd(),
  approvedPlan, pluginInventory, runCli = defaultRunCli } = {}) {
  if (!pluginInventory) return { code: 2, out: { ok: false, blocked: 'fresh Codex plugin-list JSON is required' } };
  let saved;
  try { saved = JSON.parse(fs.readFileSync(approvedPlan, 'utf8')); }
  catch { return { code: 2, out: { ok: false, blocked: 'approved plan is unreadable' } }; }
  const current = check({ pluginRoot, projectRoot, pluginInventory, runCli,
    requestedRefresh: saved.requestedRefresh === true });
  if (current.code !== 0 || !saved.ok || saved.pluginAction !== 'refresh' ||
      current.out.approvalDigest !== saved.approvalDigest || saved.pluginId !== current.out.pluginId) {
    return { code: 2, out: { ok: false, blocked: 'approved plugin refresh plan is stale' } };
  }
  return { code: 0, out: { ok: true, mode: 'refresh-command',
    command: 'codex', args: ['plugin', 'add', saved.pluginId, '--json'],
    approvalDigest: saved.approvalDigest,
    note: 'run exactly this supported CLI command, then verify its JSON result before migration' } };
}

function verifyRefresh({ pluginRoot = path.resolve(__dirname, '..'), approvedPlan, installResult } = {}) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(approvedPlan, 'utf8')); }
  catch { return { code: 2, out: { ok: false, blocked: 'approved plan is unreadable' } }; }
  if (!saved.ok || saved.pluginAction !== 'refresh' || saved.approvalDigest !== makeDigest(saved)) {
    return { code: 2, out: { ok: false, blocked: 'approved plan is invalid' } };
  }
  let result;
  try { result = typeof installResult === 'string' ? JSON.parse(installResult) : installResult; }
  catch { return { code: 1, out: { ok: false, error: 'Codex plugin add returned invalid JSON', migrationNotRun: true } }; }
  try {
    if (!result || result.pluginId !== saved.pluginId || result.version !== saved.sourceVersion) {
      throw new Error('Codex plugin add result does not match approved identity/version');
    }
    const source = trustedSourceRoot(fs.realpathSync(pluginRoot), {
      source: { source: 'local', path: saved.sourceRoot },
    });
    if (sourceFingerprint(source) !== saved.sourceFingerprint) throw new Error('source changed after approval');
    const verified = verifyInstalled(source, result.installedPath, saved.sourceVersion);
    return { code: 0, out: { ok: true, mode: 'verified-refresh', pluginId: saved.pluginId,
      from: saved.installedVersion, to: saved.sourceVersion, ...verified,
      migrationNeeded: saved.migrationNeeded } };
  } catch (e) { return { code: 1, out: { ok: false, error: e.message, migrationNotRun: true } }; }
}

function main(argv, deps = {}) {
  const [verb, ...rest] = argv;
  const value = (flag) => { const i = rest.indexOf(flag); return i < 0 ? null : rest[i + 1]; };
  try {
    const pluginInventory = rest.includes('--plugin-list-stdin') ? fs.readFileSync(0, 'utf8') : deps.pluginInventory;
    if (verb === 'check') return check({ ...deps, projectRoot: value('--project') || deps.projectRoot,
      requestedRefresh: rest.includes('--refresh-requested'), pluginInventory });
    if (verb === 'refresh') return refresh({ ...deps, projectRoot: value('--project') || deps.projectRoot,
      approvedPlan: value('--approved-plan'), pluginInventory });
    if (verb === 'refresh-command') return refreshCommand({ ...deps, projectRoot: value('--project') || deps.projectRoot,
      approvedPlan: value('--approved-plan'), pluginInventory });
    if (verb === 'verify-refresh') return verifyRefresh({ ...deps, approvedPlan: value('--approved-plan'),
      installResult: rest.includes('--install-result-stdin') ? fs.readFileSync(0, 'utf8') : deps.installResult });
    return { code: 2, out: { ok: false, error: 'usage: codex_update.js check|refresh|refresh-command|verify-refresh [options]' } };
  } catch (e) { return { code: 1, out: { ok: false, error: e.message } }; }
}

module.exports = { check, refresh, refreshCommand, verifyRefresh, main, projectState, verifyInstalled, SKILLS };
if (require.main === module) {
  const { code, out } = main(process.argv.slice(2));
  console.log(JSON.stringify(out));
  process.exitCode = code;
}
