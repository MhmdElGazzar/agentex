// Shared helpers for the bug-report-azure skill.
//
// This skill is PRODUCT/TEAM AGNOSTIC. Nothing team-specific is hardcoded: org,
// project, area path, template id, assignees, environment, etc. are resolved at
// runtime from the AgenTeX `.env` (the plugin convention — keys-only file, values
// exported into the shell), and anything still unset is left as a {{PLACEHOLDER}}
// for the caller to ask about. There is NO config.json — config lives in `.env`
// alongside every other AgenTeX integration (see the repo-root `.env.example`).
//
// TOOLING: every Azure interaction goes through the Azure CLI (`az`). There are NO
// direct REST/API calls here. Reads run freely; writes only run behind --execute and
// are PRINTED before they run (transparency requirement).
//
// SECRETS: the PAT is never read or printed here — `az` picks it up from
// AZURE_DEVOPS_EXT_PAT in the environment (same as task-estimation / test-design).

'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// ---- config from .env (plugin convention: env-var names, resolved at runtime) ----

// Read one env var, trimmed; empty/whitespace => null.
function env(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Resolve config from the AgenTeX `.env` Azure keys. Anything null is ASKED at
// runtime or inherited from the parent story — never silently guessed.
function loadConfig() {
  return {
    org: (env('AZURE_URL') || '').replace(/\/+$/, '') || null, // {{ORG_URL}}
    project: env('AZURE_PROJECT'),                             // {{PROJECT_NAME}}
    team: env('AZURE_TEAM'),                                   // {{TEAM_NAME}}
    areaPath: env('AZURE_AREA_PATH'),                          // {{AREA_PATH}} (else inherit from story)
    iterationPath: env('AZURE_ITERATION_PATH'),               // {{ITERATION_PATH}}
    templateBugId: env('AZURE_BUG_TEMPLATE_ID'),              // {{TEMPLATE_BUG_ID}}
    // One or more assignees, comma-separated (e.g. AZURE_ASSIGNEE=a@x.com,b@x.com). Always asked.
    assignees: (env('AZURE_ASSIGNEE') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    valueArea: env('AZURE_VALUE_AREA') || 'Business',
    environment: env('AZURE_ENVIRONMENT'),                    // {{ENVIRONMENT}} (Custom.Environment)
    bugCategory: env('AZURE_BUG_CATEGORY'),                   // {{BUG_CATEGORY}} (Custom.BugCategory)
    testPlanId: env('AZURE_TEST_PLAN_ID'),                    // {{TEST_PLAN_ID}}
    apiVersion: env('AZURE_API_VERSION') || '7.1',
  };
}

// Common --org/--project args appended to az calls when the env provides them.
function orgArgs(cfg) {
  const a = [];
  if (cfg.org) a.push('--org', cfg.org);
  if (cfg.project) a.push('--project', cfg.project);
  return a;
}

// ---- az CLI runner ----------------------------------------------------------

const IS_WIN = process.platform === 'win32';
// On Windows `az` is `az.cmd` (a batch file); on POSIX it's `az`.
const AZ_BIN = IS_WIN ? 'az.cmd' : 'az';

// Quote ONE argument for the platform shell so spaces and metacharacters
// (< > & | ; " and the HTML in ReproSteps) survive intact — NO word-splitting,
// NO injection. This is why we build a single command string instead of passing
// an args array with shell:true (which Node neither quotes nor supports for a
// .cmd without shell — see browser-testing/preflight.js DEP0190 note).
function shQuote(a) {
  const s = String(a);
  if (IS_WIN) {
    // cmd.exe: wrap in double quotes and double any embedded quote. Inside double
    // quotes, & < > | ^ are literal. (% and ! only expand for real vars / delayed
    // expansion, which we don't enable — safe for bug text.)
    return `"${s.replace(/"/g, '""')}"`;
  }
  // POSIX sh: single-quote, closing/escaping/reopening for embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build the exact, copy-pasteable command string that will be executed. The printed
// command IS the executed command (transparency requirement).
function buildCmd(argv) {
  return [AZ_BIN, ...argv].map(shQuote).join(' ');
}

// Run an `az ...` command.
//   opts.write   – true if this mutates the board (create/update/link/attach/outcome)
//   opts.execute – global execute flag; a write with execute=false is NOT run, only printed
//   opts.input   – string piped to stdin
// Reads (write=false) always run. Returns { ran, ok, json, stdout, stderr, status, cmd }.
function az(argv, { write = false, execute = false, input } = {}) {
  const cmd = buildCmd(argv);

  if (write && !execute) {
    // Requirement: log every write command BEFORE it would run; do not run it in dry mode.
    console.log('  [would run] ' + cmd);
    return { ran: false, ok: true, json: null, stdout: '', stderr: '', status: 0, cmd };
  }
  if (write) console.log('  [run] ' + cmd);

  // A single command string + shell:true: args are pre-quoted by shQuote, so the
  // shell re-splits them exactly as intended (and this is the only reliable way to
  // launch az.cmd on Windows). No unquoted user input ever reaches the shell.
  const res = spawnSync(cmd, {
    input,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8' },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    // e.g. az not found — surface the EXACT error, never swallow it.
    throw new Error(`Failed to launch az: ${res.error.message}\n  cmd: ${cmd}`);
  }
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (res.status !== 0) {
    // Requirement: surface the exact az error to the user; never auto-retry a write.
    throw new Error(`az exited ${res.status}\n  cmd: ${cmd}\n  stderr:\n${stderr.trim()}`);
  }
  let json = null;
  if (stdout.trim()) { try { json = JSON.parse(stdout); } catch { /* not json */ } }
  return { ran: true, ok: true, json, stdout, stderr, status: res.status, cmd };
}

// ---- reusable az operations (reads + write builders) ------------------------

// Read + validate a work item; returns its fields or throws with the exact az error.
function showWorkItem(cfg, id) {
  const argv = ['boards', 'work-item', 'show', '--id', String(id), ...orgArgs(cfg), '-o', 'json'];
  const r = az(argv);
  return r.json;
}

// Idempotency: existing work items of a type with an exact title (WIQL via az boards query).
function findByTitle(cfg, type, title) {
  const safeTitle = String(title).replace(/'/g, "''");
  const projClause = cfg.project ? ` AND [System.TeamProject]='${cfg.project.replace(/'/g, "''")}'` : '';
  const wiql =
    `SELECT [System.Id] FROM workitems WHERE [System.WorkItemType]='${type}'` +
    projClause + ` AND [System.Title]='${safeTitle}'`;
  const argv = ['boards', 'query', '--wiql', wiql, ...orgArgs(cfg), '-o', 'json'];
  const r = az(argv);
  const rows = Array.isArray(r.json) ? r.json : (r.json?.workItems || r.json?.value || []);
  return rows.map((w) => w.id || w.fields?.['System.Id']).filter(Boolean);
}

// ---- CLI arg parser: --key value / --key=value / --flag ---------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---- shared validation tables ----------------------------------------------
const VALID_SEVERITY = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
const VALID_PRIORITY = [1, 2, 3, 4];

// Recommendation the SKILL workflow shows the user (they still choose). Kept here so the
// script and the skill text agree. `impact` is a coarse label derived from the run.
const IMPACT_RECOMMENDATION = {
  blocking: { severity: '1 - Critical', priority: 1, why: 'blocks the flow, no workaround' },
  data: { severity: '2 - High', priority: 1, why: 'wrong/missing data in an issued artifact' },
  functional: { severity: '3 - Medium', priority: 2, why: 'localized functional error, non-blocking' },
  cosmetic: { severity: '4 - Low', priority: 3, why: 'minor cosmetic / edge polish' },
};

module.exports = {
  loadConfig, orgArgs, az, buildCmd, shQuote, showWorkItem, findByTitle,
  parseArgs, VALID_SEVERITY, VALID_PRIORITY, IMPACT_RECOMMENDATION,
};
