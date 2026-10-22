#!/usr/bin/env node
'use strict';
// Release-gate lane planner — which live lanes a release needs (policy Q16).
//
//   node scripts/release-gate/gate-plan.js [--base <ref>]
//
//   --base  the last release (default: the most recent commit whose SUBJECT starts
//           "chore: bump to"). Head is always HEAD.
//
// Reads `git diff --name-only --no-renames <base>..HEAD` (a rename names both its old
// and its new path) and maps every changed file through the table below:
//   - INERT (docs, evals, tests, never-shipped maintainer tooling) → no lane;
//   - FULL  (the execution core and the libraries every lane uses) → every lane;
//   - LANE_MAP → the lanes whose consumer flows exercise that file;
//   - anything else is UNMAPPED and forces the full gate — fail safe: a lane is never
//     skipped for a file the table does not know.
// setup and wizard always run (every consumer starts there); a lane that reads another
// lane's output (REQUIRES) runs with it. A diff of INERT files only (or none) is
// docsOnly — the gate is skipped per the release checklist, so every lane is off.
//
// Output: ONE JSON line on stdout
//   {base, head, full, docsOnly, lanes:{<lane>:{run, because:[files]}}, unmapped:[files]}
// and a short human summary on stderr. Exit 0 · 2 git/usage error ({error} line).
// Read-only. Maintainer tooling: never shipped by any host (scripts/hosts COMMON_EXCLUDES).
const { execFileSync } = require('node:child_process');

// ── The mapping table (data) ────────────────────────────────────────────────
const LANES = ['setup', 'wizard', 'ui', 'api', 'tracker', 'reporting', 'git'];
const ALWAYS_ON = ['setup', 'wizard'];
// The reporting lane verifies the UI lane's report.md / extent-report.html.
const REQUIRES = { reporting: ['ui'] };

// No lane: nothing here runs in a consumer flow.
const INERT = [
  'docs/**', 'README.md', 'CHANGELOG.md', 'LICENSE', 'executions/README.md',
  'evals/**', '**/*.test.js', 'skills/*/scripts/golden/**',
  '.github/**', '.gitattributes', '.gitignore',
  'scripts/hosts/**', 'scripts/run-tests.js', 'scripts/release-gate/gate-plan.js', 'scripts/release-gate/README.md',
  'scripts/dev/**', 'scripts/lint_plugin.js',
];

// The full gate (Q16): the execution core — browser-testing, qa-executor, run
// merging/reporting scripts — and the shared libraries every lane uses.
const FULL = [
  'skills/browser-testing/**',
  'agents/qa-executor.md',
  'skills/test-execution/scripts/init_run.js',
  'skills/test-execution/scripts/merge_run.js',
  'skills/test-execution/scripts/write_verdict.js',
  'skills/extent-report/scripts/**',
  'scripts/lib/tracker/**',
  'scripts/lib/project_config.js',
];

// [glob, lanes]. A file collects the lanes of EVERY entry it matches.
const LANE_MAP = [
  // setup — /init-test, the scaffold, update-agentex and what they copy or stamp
  ['.claude-plugin/**', ['setup']],
  ['hosts/**', ['setup']],
  ['commands/init-test.md', ['setup', 'git']],              // git-readiness step
  ['commands/update-agentex.md', ['setup', 'git']],         // pre-commit hook offer
  ['scripts/init.js', ['setup']],
  ['scripts/lib/scaffold.js', ['setup', 'git']],            // .gitignore entries
  ['scripts/lib/version.js', ['setup']],
  ['scripts/lib/env_key_map.js', ['setup', 'wizard', 'git']],
  ['scripts/migrate.js', ['setup']],
  ['scripts/migrations/**', ['setup']],
  ['scripts/self_update.js', ['setup']],
  ['templates/**', ['setup', 'wizard']],
  ['test/README.md', ['setup']],
  ['test/suite1/**', ['setup']],
  ['.env.example', ['setup', 'wizard']],
  ['settings.example.json', ['setup']],
  ['scripts/release-gate/prepare.js', ['setup']],
  ['scripts/release-gate/scan-secrets.js', ['setup']],
  // wizard
  ['scripts/wizard/**', ['wizard']],
  ['scripts/release-gate/verify-wizard.js', ['wizard']],
  // ui — the test-execution orchestration and what a UI run drives
  ['skills/test-execution/**', ['ui', 'reporting']],
  ['skills/browser-driver/**', ['ui']],
  ['skills/ui-check/**', ['ui']],
  ['skills/optimize-login/**', ['ui']],
  ['skills/define-flow/**', ['ui']],
  ['commands/execute-test.md', ['ui']],
  ['commands/define-flow.md', ['ui']],
  // api — cataloged integration steps and the API test flows
  ['skills/api-integration/**', ['api']],
  ['skills/db-integration/**', ['api']],
  ['skills/endpoint-testing/**', ['api']],
  ['skills/swagger-import/**', ['api']],
  ['skills/ask-kb/**', ['api']],
  ['agents/api-executor.md', ['api']],
  ['commands/test-endpoints.md', ['api']],
  ['commands/import-swagger.md', ['api']],
  ['commands/ask-kb.md', ['api']],
  // tracker — /design-test, /estimate-story, bug-report-azure, tracker-ops
  ['skills/task-estimation/**', ['tracker']],
  ['skills/test-design/**', ['tracker']],
  ['skills/bug-report-azure/**', ['tracker']],
  ['skills/tracker-ops/**', ['tracker']],
  ['references/tracker/**', ['tracker']],
  ['scripts/lib/estimation_config.js', ['tracker']],
  ['commands/estimate-story.md', ['tracker']],
  ['commands/estimate-sprint.md', ['tracker']],
  ['commands/design-test.md', ['tracker']],
  ['scripts/release-gate/inject-env.js', ['tracker']],
  ['scripts/release-gate/gate-ledger.js', ['tracker']],
  ['scripts/release-gate/teardown.js', ['tracker']],
  ['scripts/release-gate/fixtures/**', ['tracker']],
  // reporting
  ['skills/extent-report/**', ['reporting']],
  ['scripts/release-gate/verify-reports.js', ['reporting']],
  // git — the consumer secret scan and the opt-in pre-commit hook
  ['scripts/secret_scan.js', ['git']],
  ['scripts/precommit_hook.js', ['git']],
  ['scripts/lib/secret_scan_core.js', ['git']],
  ['scripts/lib/precommit_hook.js', ['git']],
  ['scripts/lib/git_plumbing.js', ['git']],
  // Deliberately NOT mapped (→ full gate when changed): skills/mobile-testing/**,
  // agents/mobile-qa-executor.md, commands/execute-mobile-test.md, test/mobile-suite1/**,
  // skills/azure-integration/** — no live lane exercises them.
];

// ── Planner (pure) ──────────────────────────────────────────────────────────
// Globs: ** spans folders, * and ? stay inside one path segment, the rest is literal.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const compiled = (globs) => globs.map((g) => globToRegExp(g));
const INERT_RE = compiled(INERT);
const FULL_RE = compiled(FULL);
const LANE_RE = LANE_MAP.map(([g, lanes]) => [globToRegExp(g), lanes]);
const hit = (res, f) => res.some((re) => re.test(f));

function planLanes(changed) {
  const files = [...new Set(changed)].sort();
  const because = Object.fromEntries(LANES.map((l) => [l, new Set()]));
  const unmapped = [];
  let full = false;
  let active = 0;
  for (const f of files) {
    if (hit(INERT_RE, f)) continue;
    active++;
    if (hit(FULL_RE, f)) {
      full = true;
      for (const l of LANES) because[l].add(f);
      continue;
    }
    const lanes = LANE_RE.filter(([re]) => re.test(f)).flatMap(([, ls]) => ls);
    if (!lanes.length) { unmapped.push(f); full = true; continue; }
    for (const l of lanes) {
      because[l].add(f);
      for (const r of REQUIRES[l] || []) because[r].add(f);
    }
  }
  const docsOnly = active === 0;
  const lanes = {};
  for (const l of LANES) {
    const run = !docsOnly && (full || ALWAYS_ON.includes(l) || because[l].size > 0);
    lanes[l] = { run, because: [...because[l]].sort() };
  }
  return { full, docsOnly, lanes, unmapped };
}

// ── git side ────────────────────────────────────────────────────────────────
const USAGE = 'usage: gate-plan.js [--base <ref>]';

function usageError(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

function parseArgs(argv) {
  const opts = { base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw usageError(`--base needs a ref. ${USAGE}`);
      opts.base = v;
    } else throw usageError(`unknown argument ${JSON.stringify(argv[i])}. ${USAGE}`);
  }
  return opts;
}

function gitText(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
  } catch (e) {
    const why = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    throw new Error(`git ${args[0]} failed: ${why}`);
  }
}

// The latest commit reachable from HEAD whose subject starts "chore: bump to".
function lastBump(cwd) {
  const log = gitText(cwd, ['log', '--format=%H%x09%s', 'HEAD']);
  for (const line of log.split('\n')) {
    const [sha, subject = ''] = line.split('\t');
    if (subject.startsWith('chore: bump to')) return sha;
  }
  return null;
}

function plan(cwd, opts) {
  gitText(cwd, ['rev-parse', '--show-toplevel']);
  const baseRef = opts.base || lastBump(cwd);
  if (!baseRef) throw new Error('no commit with a subject starting "chore: bump to" — pass --base <ref>');
  let base;
  try { base = gitText(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]); }
  catch { throw new Error(`--base ${JSON.stringify(baseRef)} is not a commit in this repo`); }
  const head = gitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const changed = gitText(cwd, ['diff', '--name-only', '--no-renames', `${base}..${head}`]).split('\n').filter(Boolean);
  const short = (sha) => gitText(cwd, ['rev-parse', '--short', sha]);
  return { base: short(base), head: short(head), ...planLanes(changed), changed: changed.length };
}

function main(argv) {
  let result;
  try {
    result = plan(process.cwd(), parseArgs(argv));
  } catch (e) {
    process.stderr.write(`gate-plan: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    return 2;
  }
  const { changed, ...out } = result;
  const on = LANES.filter((l) => out.lanes[l].run);
  const off = LANES.filter((l) => !out.lanes[l].run);
  process.stderr.write(`gate-plan: ${out.base}..${out.head}, ${changed} files changed — `
    + (out.docsOnly ? 'docs/evals/tests only: the gate is skipped\n'
      : `${out.full ? 'FULL gate' : 'scoped gate'}: run ${on.join(', ')}${off.length ? `; skip ${off.join(', ')}` : ''}\n`));
  if (out.unmapped.length) process.stderr.write(`gate-plan: unmapped (forces full): ${out.unmapped.join(', ')}\n`);
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

module.exports = { LANES, ALWAYS_ON, REQUIRES, INERT, FULL, LANE_MAP, globToRegExp, planLanes, lastBump, parseArgs };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
