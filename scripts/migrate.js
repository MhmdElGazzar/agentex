#!/usr/bin/env node
'use strict';
// AgenTeX project migrator — the engine behind /update-agentex. Inspects the consumer
// project's AgenTeX setup and migrates it to the installed plugin version's
// conventions. Refactor/merge, not re-scaffold: user values are carried into their
// new homes, never reset to samples or placeholders.
//
// Usage: node migrate.js [projectDir]   (default: current working directory)
//
// Apply-then-report, no preview gate. A clean git tree is required — git is the
// rollback; the one gitignored file the engine rewrites (.env) is handled loss-proof
// by construction instead: values are written to their committed JSON homes BEFORE
// any .env key is removed, so no value ever exists in fewer than one file.
//
// Pipeline: state-based detectors in scripts/migrations/NN-<slug>.js, run in order,
// each independently idempotent (detect() returns false after apply()). The version
// stamp (.agentex/version.json) is only the fast-path no-op check and the
// exact-version comparison; detection never depends on it.
//
// Report: one [migrated]/[ok]/[flag]/[manual] line per action, then a summary. Only
// key NAMES ever appear — never secret values. Exit codes: 0 success (including
// "already up to date"), 2 guard abort with a single clear reason line, 1 unexpected
// error.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const scaffold = require('./lib/scaffold.js');
const { loadProjectConfig } = require('./lib/project_config.js');

const pluginRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || process.cwd());

function abort(reason) {
  console.error(`[abort] ${reason}`);
  process.exit(2);
}

function git(args) {
  return execFileSync('git', ['-C', projectRoot, '-c', 'core.quotepath=off', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Dotted-version compare: negative when a < b, 0 when equal, positive when a > b.
function compareVersions(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || '0', 10), nb = parseInt(pb[i] || '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if ((pa[i] || '') !== (pb[i] || '')) return (pa[i] || '') < (pb[i] || '') ? -1 : 1;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ── Guard 1: never run inside the plugin itself ──────────────────────────────
if (projectRoot === pluginRoot) {
  abort('refusing to run inside the AgenTeX plugin itself — run from your project root');
}
if (!fs.existsSync(projectRoot)) abort(`project directory not found: ${projectRoot}`);

// ── Guard 2: git present + inside a repository (the rollback mechanism) ──────
let insideRepo = false;
try { insideRepo = git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; }
catch { insideRepo = false; }
if (!insideRepo) {
  abort('not a git repository (or git is unavailable) — git is the rollback for a migration; run "git init" and commit your project first');
}

// ── Version gate fast paths (they write nothing, so they need no clean tree;
//    the clean-tree guard below protects only actual migration work) ──────────
const installed = scaffold.readPluginVersion(pluginRoot);
const stamped = scaffold.readVersionStamp(projectRoot);   // null = legacy, infer from files
if (stamped !== null) {
  const cmp = compareVersions(stamped, installed);
  if (cmp === 0) {
    console.log(`already up to date — project is at plugin version ${installed}; nothing to do.`);
    process.exit(0);
  }
  if (cmp > 0) {
    abort(`project was set up by a NEWER plugin (stamp ${stamped} > installed ${installed}) — update the AgenTeX plugin first`);
  }
}

// ── Guard 3: clean working tree ───────────────────────────────────────────────
// Tracked changes always abort. Untracked files abort only when they sit in a path
// the migration owns (git could not roll those back); other untracked files —
// typically executions/ run noise — do not block.
const OWNED_DIRS = ['config/', 'environments/', 'integration/', 'integrations/', '.agentex/'];
const OWNED_FILES = ['agentex.config.json', 'CLAUDE.md', '.gitignore'];
const statusLines = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
const trackedChanges = statusLines.filter(l => !l.startsWith('?? '));
if (trackedChanges.length) {
  abort(`working tree has uncommitted changes to ${trackedChanges.length} tracked file(s) — commit first; git is the rollback for a migration (this includes changes left by an interrupted migration: commit or git-restore them, then re-run to finish)`);
}
const untrackedOwned = statusLines
  .filter(l => l.startsWith('?? '))
  .map(l => l.slice(3).replace(/^"|"$/g, ''))
  .filter(p => OWNED_FILES.includes(p) || OWNED_DIRS.some(d => p === d || p.startsWith(d)));
if (untrackedOwned.length) {
  abort(`untracked file(s) in migration-owned paths (${untrackedOwned.join(', ')}) — commit or remove them first; git could not roll them back (files created by an interrupted migration count too: commit them, then re-run to finish)`);
}

// ── Report collector — house style, streamed as it happens ───────────────────
const report = {
  applied: 0, flags: 0, manuals: 0,
  migrated(id, detail) { this.applied++; console.log(`[migrated] ${id} — ${detail}`); },
  ok(msg) { console.log(`[ok] ${msg}`); },
  flag(msg) { this.flags++; console.log(`[flag] ${msg}`); },
  manual(msg) { this.manuals++; console.log(`[manual] ${msg}`); },
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const ctx = {
  projectRoot, pluginRoot, report,
  templates: {
    project: readJson(path.join(pluginRoot, 'templates', 'config', 'project.json')),
    environment: readJson(path.join(pluginRoot, 'templates', 'environments', 'qa.json')),
  },
  // Active environment name — recomputed on demand because earlier migrations may
  // create config/project.json mid-pipeline.
  envName() { return loadProjectConfig(projectRoot).defaultEnvironment || 'qa'; },
  saveJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  },
};

// ── Pipeline — fixed order (rename before gap-fill; carries before gap-fill) ──
const migrationsDir = path.join(__dirname, 'migrations');
const modules = fs.readdirSync(migrationsDir)
  .filter(f => /^\d{2}-.*\.js$/.test(f))
  .sort()
  .map(f => require(path.join(migrationsDir, f)));

try {
  for (const m of modules) {
    if (m.detect(ctx)) m.apply(ctx);
  }
} catch (e) {
  // Stop without stamping: state-based detectors let the next run resume from here —
  // but the clean-tree guard is absolute, so this run's partial changes must be
  // committed (or git-restored) before that re-run.
  console.error(`[error] migration failed: ${e.message}`);
  console.error('fix the cause, commit the partial state (or roll it back with git), then re-run — migrations resume from detected state.');
  process.exit(1);
}

// ── Stamp + summary ───────────────────────────────────────────────────────────
// The stamp means "this project matches the installed version's conventions". While
// [manual] items remain it does not — and stamping anyway would dead-end the
// advertised re-run on the version-gate fast path — so the stamp is withheld until
// a run finishes with zero manual items.
if (report.manuals > 0) {
  console.log(`[stamp] withheld — ${report.manuals} manual item(s) above must be resolved first; re-run /update-agentex afterwards`);
} else {
  scaffold.writeVersionStamp(projectRoot, installed);
  console.log(`[stamp] ${scaffold.STAMP_REL} → ${installed}`);
}
if (report.applied === 0) {
  console.log(report.manuals > 0
    ? `\nno migrations applied — resolve the ${report.manuals} manual item(s) above, then re-run /update-agentex.`
    : `\nno migrations needed — project already follows current conventions (stamp refreshed to ${installed}).`);
} else {
  console.log(`\nAgenTeX migration done: ${report.applied} migration(s) applied, ${report.flags} flag(s), ${report.manuals} manual item(s).`);
  console.log('verify with a normal test run, then commit the migration as one commit — git is the rollback.');
}
