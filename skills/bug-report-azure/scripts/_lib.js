// Shared helpers for the bug-report-azure skill.
//
// This skill is PRODUCT/TEAM AGNOSTIC. Nothing team-specific is hardcoded: org,
// project, area path, template id, assignees, environment, etc. are resolved at
// runtime from `config/project.json`'s `azure` block (primary) with legacy `AZURE_*`
// keys in `.env` as fallback, and anything still unset is left as a {{PLACEHOLDER}}
// for the caller to ask about. See docs/azure-devops.md for setup. JSON values are
// stringified; note `bugTemplateId` (JSON) → `templateBugId` (internal).
//
// TOOLING: every Azure interaction goes through the Azure CLI (`az`). There are NO
// direct REST/API calls here. Reads run freely; writes only run behind --execute and
// are PRINTED before they run (transparency requirement).
//
// SECRETS: the PAT is never read or printed here — `az` picks it up from
// AZURE_DEVOPS_EXT_PAT in the environment (same as task-estimation / test-design).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ---- config: config/project.json "azure" block first, legacy AZURE_* env fallback ----

const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

// Read one env var (process.env → .env), trimmed; empty => null.
function env(name) {
  const v = pc.readEnvVar(process.cwd(), name);
  return v === null || v === '' ? null : v;
}

// One value: azure block key first, env var second; empty/missing => null.
function pick(az, key, envName) {
  const j = az[key];
  if (j !== undefined && j !== null && String(j).trim() !== '') return String(j).trim();
  return env(envName);
}

// Resolve config. Anything null is ASKED at runtime or inherited from the parent
// story — never silently guessed.
function loadConfig() {
  const az = pc.loadProjectConfig(process.cwd()).azure || {};
  return {
    org: (pick(az, 'org', 'AZURE_URL') || '').replace(/\/+$/, '') || null, // {{ORG_URL}}
    project: pick(az, 'project', 'AZURE_PROJECT'),                         // {{PROJECT_NAME}}
    team: pick(az, 'team', 'AZURE_TEAM'),                                  // {{TEAM_NAME}}
    areaPath: pick(az, 'areaPath', 'AZURE_AREA_PATH'),                     // {{AREA_PATH}}
    iterationPath: pick(az, 'iterationPath', 'AZURE_ITERATION_PATH'),      // {{ITERATION_PATH}}
    templateBugId: pick(az, 'bugTemplateId', 'AZURE_BUG_TEMPLATE_ID'),     // {{TEMPLATE_BUG_ID}}
    // One or more assignees, comma-separated. Always asked.
    assignees: (pick(az, 'assignee', 'AZURE_ASSIGNEE') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    valueArea: pick(az, 'valueArea', 'AZURE_VALUE_AREA') || 'Business',
    environment: pick(az, 'environment', 'AZURE_ENVIRONMENT'),             // {{ENVIRONMENT}}
    bugCategory: pick(az, 'bugCategory', 'AZURE_BUG_CATEGORY'),            // {{BUG_CATEGORY}}
    testPlanId: pick(az, 'testPlanId', 'AZURE_TEST_PLAN_ID'),              // {{TEST_PLAN_ID}}
    apiVersion: pick(az, 'apiVersion', 'AZURE_API_VERSION') || '7.1',
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
