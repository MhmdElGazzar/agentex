// Shared helpers for the report-azure-bug-generic skill.
//
// This skill is PRODUCT/TEAM AGNOSTIC. Nothing team-specific is hardcoded: org,
// project, area path, template id, assignees, environment, etc. are resolved at
// runtime from (in order) config.json → env vars → `az` configured defaults, and
// anything still unset is left as a {{PLACEHOLDER}} for the caller to ask about.
//
// TOOLING: every Azure interaction goes through the Azure CLI (`az`). There are NO
// direct REST/API calls here. Reads run freely; writes only run behind --execute and
// are PRINTED before they run (transparency requirement).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config / placeholders --------------------------------------------------

// Look for config.json next to the skill, then walk up from cwd (repo root, etc.).
function findConfigFile() {
  const candidates = [
    path.join(__dirname, "..", "config.json"),
    path.join(__dirname, "..", "config.local.json"),
  ];
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "bug-skill.config.json"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Resolve one value: explicit config → env var → az configured default → fallback (may be null).
export function loadConfig() {
  const file = findConfigFile();
  const cfg = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

  const org = (cfg.orgUrl || process.env.AZURE_DEVOPS_ORG_URL || "").replace(/\/+$/, "") || null;
  const project = cfg.project || process.env.AZURE_DEVOPS_DEFAULT_PROJECT || null;

  return {
    file,
    org,                                   // {{ORG_URL}}       (may be null → rely on az defaults)
    project,                               // {{PROJECT_NAME}}  (may be null → rely on az defaults)
    team: cfg.team || null,                // {{TEAM_NAME}}
    areaPath: cfg.areaPath || null,        // {{AREA_PATH}}     (else inherit from parent story)
    iterationPath: cfg.iterationPath || null,
    templateBugId: cfg.templateBugId || null,   // {{TEMPLATE_BUG_ID}}
    assignees: Array.isArray(cfg.assignees) ? cfg.assignees : [],
    valueArea: cfg.valueArea || "Business",
    environment: cfg.environment || null,  // {{ENVIRONMENT}}  (Custom.Environment; omit if absent)
    bugCategory: cfg.bugCategory || null,  // {{BUG_CATEGORY}} (Custom.BugCategory; omit if absent)
    testPlanId: cfg.testPlanId || null,    // {{TEST_PLAN_ID}}
    apiVersion: cfg.apiVersion || "7.1",
  };
}

// Common --org/--project args appended to az calls when config provides them.
export function orgArgs(cfg) {
  const a = [];
  if (cfg.org) a.push("--org", cfg.org);
  if (cfg.project) a.push("--project", cfg.project);
  return a;
}

// ---- az CLI runner ----------------------------------------------------------

// Render an argv array as a copy-pasteable shell command (for transparency logging).
export function renderCmd(argv) {
  return argv
    .map((a) => (/[\s"'$`\\]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a))
    .join(" ");
}

// Run an `az ...` command.
//   opts.write   – true if this mutates the board (create/update/link/attach/outcome)
//   opts.execute – global execute flag; a write with execute=false is NOT run, only printed
//   opts.input   – string piped to stdin (used for --in-file "-" style bodies if needed)
// Reads (write=false) always run. Returns { ran, ok, json, stdout, stderr, status, cmd }.
export function az(argv, { write = false, execute = false, input } = {}) {
  const full = ["az", ...argv];
  const cmd = renderCmd(full);

  if (write && !execute) {
    // Requirement: log every write command BEFORE it would run; do not run it in dry mode.
    console.log("  [would run] " + cmd);
    return { ran: false, ok: true, json: null, stdout: "", stderr: "", status: 0, cmd };
  }
  if (write) console.log("  [run] " + cmd);

  const res = spawnSync(full[0], full.slice(1), {
    input,
    encoding: "utf8",
    shell: process.platform === "win32", // az is az.cmd on Windows
    env: { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8" },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    // e.g. az not found — surface the EXACT error, never swallow it.
    throw new Error(`Failed to launch az: ${res.error.message}\n  cmd: ${cmd}`);
  }
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
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
export function showWorkItem(cfg, id, fields) {
  const argv = ["boards", "work-item", "show", "--id", String(id), ...orgArgs(cfg), "-o", "json"];
  const r = az(argv);
  return r.json;
}

// Idempotency: existing work items of a type with an exact title (WIQL via az boards query).
export function findByTitle(cfg, type, title) {
  const safeTitle = String(title).replace(/'/g, "''");
  const projClause = cfg.project ? ` AND [System.TeamProject]='${cfg.project.replace(/'/g, "''")}'` : "";
  const wiql =
    `SELECT [System.Id] FROM workitems WHERE [System.WorkItemType]='${type}'` +
    projClause + ` AND [System.Title]='${safeTitle}'`;
  const argv = ["boards", "query", "--wiql", wiql, ...orgArgs(cfg), "-o", "json"];
  const r = az(argv);
  const rows = Array.isArray(r.json) ? r.json : (r.json?.workItems || r.json?.value || []);
  return rows.map((w) => w.id || w.fields?.["System.Id"]).filter(Boolean);
}

// ---- CLI arg parser: --key value / --key=value / --flag ---------------------
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---- shared validation tables ----------------------------------------------
export const VALID_SEVERITY = ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"];
export const VALID_PRIORITY = [1, 2, 3, 4];

// Recommendation the SKILL workflow shows the user (they still choose). Kept here so the
// script and the skill text agree. `impact` is a coarse label derived from the run.
export const IMPACT_RECOMMENDATION = {
  blocking:    { severity: "1 - Critical", priority: 1, why: "blocks the flow, no workaround" },
  data:        { severity: "2 - High",     priority: 1, why: "wrong/missing data in an issued artifact" },
  functional:  { severity: "3 - Medium",   priority: 2, why: "localized functional error, non-blocking" },
  cosmetic:    { severity: "4 - Low",      priority: 3, why: "minor cosmetic / edge polish" },
};
