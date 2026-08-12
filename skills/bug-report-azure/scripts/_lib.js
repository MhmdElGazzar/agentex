// Shared helpers for the bug-report-azure skill.
//
// This skill is PRODUCT/TEAM AGNOSTIC. Nothing team-specific is hardcoded: org,
// project, area path, template id, assignees, environment, etc. are resolved at
// runtime from `config/project.json`'s `azure` block (primary), then `AZURE_*` in
// `.env` — process.env, then a flat `KEY=value` line, then (see readEnvGroupedJsonVar)
// the grouped-by-tool `.env` format some projects use, e.g. `"azureDevOps": { "env": {
// "AZURE_DEVOPS_ORG_URL": "..." } }` — and anything still unset is left as a
// {{PLACEHOLDER}} for the caller to ask about. See docs/azure-devops.md for setup.
// Each value accepts SEVERAL env names (see pick()): both AgenTeX's canonical AZURE_URL /
// AZURE_PROJECT and the azure-devops MCP server's AZURE_DEVOPS_ORG_URL /
// AZURE_DEVOPS_DEFAULT_PROJECT resolve, so neither convention breaks the other.
// JSON values are stringified; note `bugTemplateId` (JSON) → `templateBugId` (internal), which
// is a REFERENCE bug id the workflow shows the user — never a source fields are copied from.
// Area Path / Iteration Path are resolved in create-bug.js, not here: Area Path is
// spec override -> inherit from the parent story -> AZURE_AREA_PATH -> hard error (never
// Azure DevOps' own default — omitting it lands the Bug at the bare project root, not the
// team's area). Iteration Path is spec override ->
// inherit from the parent story -> AZURE_ITERATION_PATH -> omit (Azure DevOps' own default
// is acceptable for Iteration, unlike Area Path). cfg.areaPath / cfg.iterationPath here
// resolve AZURE_AREA_PATH / AZURE_ITERATION_PATH; both are consulted by that chain.
//
// TOOLING: every Azure interaction goes through the Azure CLI (`az`), with two diagnosed
// exceptions that go over direct HTTPS because `az` provably cannot make those two calls:
// `uploadAttachmentBinary` (az devops invoke text-decodes --in-file, so it can never carry
// raw binary) and `patchWorkItem` (az devops invoke mis-routes every PATCH-by-id on the
// workitems resource; the `az boards work-item update --fields` alternative puts a multi-KB
// HTML body on the command line, past cmd.exe's 8191-char cap). Both are documented in
// SKILL.md's "Tooling" section — the code and that section must not drift apart.
// Reads run freely; writes only run behind --execute and are PRINTED before they run
// (transparency requirement) — in dry-run mode the SAME call prints instead of sending, so
// what the user confirms is what executes.
//
// SECRETS: `az` picks up its own PAT from AZURE_DEVOPS_EXT_PAT (same as task-estimation /
// test-design). The two direct-HTTPS calls above can't use az's auth, so `resolvePat()`
// reads a PAT for their Authorization header — the ONE place this skill touches a secret.
// It is never logged, never printed, and never leaves this module; see resolvePat().

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---- config: config/project.json "azure" block first, legacy AZURE_* env fallback ----

const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

// Fallback for this project's .env, which groups values by tool as quoted pseudo-JSON —
// e.g. `"azureDevOps": { "env": { "AZURE_DEVOPS_ORG_URL": "...", ... } }` — instead of flat
// `KEY=value` lines. project_config.js's readEnvVar() (line-based regex) can't see these, so
// this scans the raw file text for a quoted `"NAME": "value"` pair anywhere in it. Good
// enough given these keys (AZURE_DEVOPS_*) are namespaced/unique; not a full JSON parse
// (the file isn't valid JSON as a whole — no outer braces, and other blocks mix in bare
// `KEY=value` lines too, e.g. the DB blocks). Read-only. `resolvePat()` goes through env()
// — and therefore through here — too, since a PAT stored in .env lives in the same grouped
// block as the org URL; see resolvePat()'s comment for why the skill reads a PAT at all.
function readEnvGroupedJsonVar(name) {
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const m = txt.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
    return m && m[1] !== '' ? m[1] : null;
  } catch {
    return null;
  }
}

// Read one env var: process.env → flat `KEY=value` line in .env → this project's
// grouped-by-tool .env format (see readEnvGroupedJsonVar above). Trimmed; empty => null.
function env(name) {
  const v = pc.readEnvVar(process.cwd(), name);
  if (v !== null && v !== '') return v;
  return readEnvGroupedJsonVar(name);
}

// One value: azure block key first, then each env var name in order; first non-empty wins,
// empty/missing => null. Several names per value on purpose — this skill has to read two
// naming conventions that both exist in the wild: AgenTeX's canonical keys (AZURE_URL /
// AZURE_PROJECT — what the wizard's ENV_KEY_MAP, .env.example, and the task-estimation /
// test-design skills all use) and the azure-devops MCP server's keys
// (AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_DEFAULT_PROJECT), which some projects already have
// in .env. Reading only one set silently resolved org/project to null for everyone on the
// other set. Aliases, never a replacement.
function pick(az, key, ...envNames) {
  const j = az[key];
  if (j !== undefined && j !== null && String(j).trim() !== '') return String(j).trim();
  for (const n of envNames) {
    const v = env(n);
    if (v !== null && v !== '') return v;
  }
  return null;
}

// Resolve config. Anything null is ASKED at runtime or inherited from the parent
// story — never silently guessed.
function loadConfig() {
  const az = pc.loadProjectConfig(process.cwd()).azure || {};
  return {
    // org/project accept both naming conventions — see pick()'s comment.
    org: (pick(az, 'org', 'AZURE_DEVOPS_ORG_URL', 'AZURE_URL', 'AZURE_ORG', 'AZURE_DEVOPS_ORG') || '')
      .replace(/\/+$/, '') || null,                                                    // {{ORG_URL}}
    project: pick(az, 'project', 'AZURE_DEVOPS_DEFAULT_PROJECT', 'AZURE_PROJECT'),     // {{PROJECT_NAME}}
    team: pick(az, 'team', 'AZURE_TEAM'),                                  // {{TEAM_NAME}}
    areaPath: pick(az, 'areaPath', 'AZURE_AREA_PATH'),                     // {{AREA_PATH}}
    iterationPath: pick(az, 'iterationPath', 'AZURE_ITERATION_PATH'),      // {{ITERATION_PATH}}
    // Reference bug only: the workflow opens it to SHOW the user what the standard layout
    // looks like on the board (SKILL.md step 2). No script reads fields off it and nothing is
    // copied from it — the Bug's shape comes from create-bug.js's own field list and
    // buildReproHtml(). Exposed here so the workflow can resolve the id from config.
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

// Common --org arg appended to az calls when the env provides one. Org-only on purpose:
// most `az boards work-item ...` subcommands (show, update, relation add) REJECT --project
// outright ("unrecognized arguments") — a work item ID is global to the org, not scoped by
// a project flag. This only stayed hidden before because cfg.project used to always resolve
// to null; now that org/project resolve from the real .env, passing --project to those
// subcommands breaks them. The two subcommands that DID accept --project (`work-item create`,
// `boards query`) are no longer used at all: both carried user text on the command line, so
// both moved to `az devops invoke --in-file` (see createBug and findByTitle). Every remaining
// `az boards` call in this skill takes ids only, hence org-only.
function orgArgs(cfg) {
  const a = [];
  if (cfg.org) a.push('--org', cfg.org);
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
    // cmd.exe: wrap in double quotes and double any embedded quote. Inside double quotes
    // & < > | ^ are literal, and ! is literal too (delayed expansion is off — we never
    // launch cmd with /V:ON). `%NAME%` is the ONE thing quoting does NOT contain — see
    // assertNoShellExpansion below, which refuses rather than pretending it's escaped.
    return `"${s.replace(/"/g, '""')}"`;
  }
  // POSIX sh: single-quote, closing/escaping/reopening for embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The one hole in shQuote, closed by refusing instead of escaping.
//
// cmd.exe performs %NAME% expansion while PARSING the command line, before quoting is
// considered — so a double-quoted argument is NOT protected (verified locally: an argument
// written as "%PATH%" arrives at the child process as the expanded path). And there is no
// escape for it: `%%` is a batch-FILE rule, not a command-line one (verified: `%%NAME%%`
// yields `%value%`, not `%NAME%`). Two consequences, both real:
//   - silent rewriting — a bug/test-case title or a WIQL query carrying %NAME% is written
//     to Azure DevOps as something the user never typed;
//   - injection — if that variable's value happens to contain a double quote, the expansion
//     breaks out of the quoting and the rest of the value is parsed as command syntax.
// Since neither can be escaped away, this fails closed: name the variable and stop. Only a
// NAME that actually EXISTS in the environment expands (cmd leaves unknown ones alone), so
// ordinary text — "50% off", "100% of the time" — passes through untouched.
//
// The permanent fix for any payload that legitimately needs arbitrary text is to keep it OFF
// the command line entirely (`--in-file` / stdin), which is what the ReproSteps patch, the
// work-item create and every testplan.js write already do.
function assertNoShellExpansion(argv) {
  if (!IS_WIN) return; // POSIX single quotes are fully literal — nothing to expand.
  for (const a of argv) {
    for (const m of String(a).matchAll(/%([^%\r\n]+)%/g)) {
      const name = m[1];
      const real = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
      if (!real) continue; // cmd leaves an unknown %NAME% alone; so do we.
      throw new Error(
        `refusing to run: an argument contains "%${name}%", and cmd.exe expands that to the value `
        + `of the ${real} environment variable before az ever sees it — even inside double quotes, `
        + `and with no way to escape it. The text would reach Azure DevOps silently rewritten. `
        + `Remove or rename "%${name}%" in the title / comment / field value and re-run.`);
    }
  }
}

// Build the exact, copy-pasteable command string that will be executed. The printed
// command IS the executed command (transparency requirement). The expansion guard lives
// here so it covers BOTH the printed dry-run command and the executed one — a payload cmd
// would mangle is caught while the user is still reviewing, not after they confirm.
function buildCmd(argv) {
  assertNoShellExpansion(argv);
  // AZ_BIN (az / az.cmd) is never quoted: it has no spaces, and on Windows
  // quoting the .cmd launcher's own name breaks its internal python lookup
  // ("Failed to load python executable") because the batch file resolves
  // its own path via %0 / %~dp0, which mis-parses when %0 carries literal
  // quote characters. Every actual argument still gets quoted below.
  return [AZ_BIN, ...argv.map(shQuote)].join(' ');
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

// Idempotency: existing work items of a type with an exact title.
//
// The query travels in a FILE, not on the command line. `az boards query --wiql "<query>"` put
// the user's title into a shell argument, and on Windows cmd.exe expands %NAME% inside a
// quoted argument with no way to escape it (see assertNoShellExpansion) — so a title
// containing a live %NAME% silently searched for something else and the duplicate check
// reported "none found" for a title that was already on the board. A fail-OPEN answer on the
// one check constraint 7 makes a precondition for creating. Posting the WIQL as a JSON body
// via `az devops invoke --in-file` removes the title from the command line entirely, so no
// shell ever parses it.
//
// This is the documented POST {project}/_apis/wit/wiql route, which answers
// `{ workItems: [{id, url}] }` — the response parsing below already accepted that shape, plus
// the `az boards query` shape, so both stay readable.
function findByTitle(cfg, type, title) {
  const { org, project } = resolveOrgProject(cfg);
  if (!org || !project) {
    throw new Error('cannot resolve org/project for the duplicate-title check — set '
      + 'azure.org/azure.project (config/project.json) or run `az devops configure -d '
      + 'organization=... project=...`');
  }
  const safeTitle = String(title).replace(/'/g, "''");
  const wiql = `SELECT [System.Id] FROM workitems WHERE [System.WorkItemType]='${type}'`
    + ` AND [System.TeamProject]='${project.replace(/'/g, "''")}'`
    + ` AND [System.Title]='${safeTitle}'`;

  const tmp = path.join(os.tmpdir(), `wiql-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ query: wiql }));
  let r;
  try {
    r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'wiql',
      '--route-parameters', `project=${project}`, '--http-method', 'POST',
      '--api-version', cfg.apiVersion || '7.1', '--in-file', tmp, '--org', org, '-o', 'json']);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const rows = Array.isArray(r.json) ? r.json : (r.json?.workItems || r.json?.value || []);
  return rows.map((w) => w.id || w.fields?.['System.Id']).filter(Boolean);
}

// ---- work-item-type field metadata (picklists + required flags) -------------
// ONE `az devops invoke` call returns every field on a work item type with both its
// `allowedValues` and its `alwaysRequired` flag — so a picklist rejection can be explained
// with real data instead of a guess, and required fields can be named.
//
// Route choice matters here. The obvious alternative — resolve the field's `picklistId`,
// then GET /_apis/work/processes/lists/{listId} — is worse on four counts: it is
// organisation-scoped rather than project-scoped, it is a `-preview` api-version, it needs
// process-level read permission that an ordinary contributor PAT does not have, and it
// returns the RAW list rather than the values actually allowed on this work item type
// (process rules can narrow them). This route is stable 7.1, project-scoped, needs only the
// permissions the skill already uses, and — importantly — stays inside `az`, adding no new
// direct-HTTPS exception.
//
// Cached per (project, type): picklists change rarely and a single run can consult them
// several times (validation, rejection explanation, listing).
const _fieldMetaCache = new Map();

function workItemTypeFields(cfg, type = 'Bug') {
  const { org, project } = resolveOrgProject(cfg);
  if (!org || !project) {
    throw new Error('cannot resolve org/project for the field lookup — set azure.org/azure.project '
      + '(config/project.json) or run `az devops configure -d organization=... project=...`');
  }
  const key = `${project}|${type}`;
  if (_fieldMetaCache.has(key)) return _fieldMetaCache.get(key);

  const r = az(['devops', 'invoke', '--area', 'wit', '--resource', 'workitemtypesfield',
    '--route-parameters', `project=${project}`, `type=${type}`,
    '--query-parameters', '$expand=allowedValues',
    '--api-version', cfg.apiVersion || '7.1', '--org', org, '-o', 'json']);

  const rows = r.json?.value || (Array.isArray(r.json) ? r.json : []);
  const map = new Map();
  for (const f of rows) {
    if (!f?.referenceName) continue;
    map.set(f.referenceName, {
      name: f.name || f.referenceName,
      referenceName: f.referenceName,
      alwaysRequired: Boolean(f.alwaysRequired),
      allowedValues: Array.isArray(f.allowedValues) ? f.allowedValues : [],
    });
  }
  _fieldMetaCache.set(key, map);
  return map;
}

// Azure's field errors name the field by its DISPLAY name ("Environment"), never its
// reference name ("Custom.Environment") — so callers cannot match the message against the
// fields they sent without this translation. Returns {field, value, kind} or null.
//   kind: 'not-in-list'  the value isn't one of the picklist's allowed values
//         'required'     the field is required and was missing/empty
function parseFieldRejection(errorText) {
  const t = String(errorText || '');
  let m = t.match(/field '([^']+)' contains the value '([^']*)' that is not in the list of supported values/i);
  if (m) return { field: m[1], value: m[2], kind: 'not-in-list' };
  m = t.match(/Rule Error for field ([^.]+)\.\s*Error code:\s*Required/i);
  if (m) return { field: m[1].trim(), value: null, kind: 'required' };
  m = t.match(/field '([^']+)'.*required/i);
  if (m) return { field: m[1], value: null, kind: 'required' };
  return null;
}

// Turn a rejection message into the data a human needs to choose correctly: the rejected
// field's real allowed values, straight from the process. Returns null when the message
// isn't a field rejection, so callers can fall through to the plain error path.
function describeFieldRejection(cfg, type, errorText) {
  const hit = parseFieldRejection(errorText);
  if (!hit) return null;
  let meta = null;
  try {
    for (const m of workItemTypeFields(cfg, type).values()) {
      if (m.name.toLowerCase() === hit.field.toLowerCase()) { meta = m; break; }
    }
  } catch (e) {
    return { ...hit, meta: null, lookupError: e.message.split('\n')[0] };
  }
  return { ...hit, meta };
}

// ---- the two direct-HTTPS exceptions to "az CLI only" -----------------------
// Both are here, together, so the whole REST surface of this skill is one block you can
// read in one go — and so SKILL.md's "Tooling" section has a single place to point at.
// Everything else (create, parent link, queries, test-plan routes) still goes through `az`.
//   1. uploadAttachmentBinary — `az devops invoke --in-file` text-decodes the file before
//      sending (tries utf-8/ascii/utf-16), so it can never carry raw binary: a PNG fails
//      with "Unable to decode file ... encoding" before any network call. No native
//      `az boards` attachment verb exists either.
//   2. patchWorkItem — `az devops invoke ... PATCH --route-parameters id=<id>` mis-routes
//      (see that function), and the `az boards work-item update --fields` alternative puts
//      the whole ReproSteps HTML on the command line, which cmd.exe caps at 8191 chars.
// Both need an Authorization header of their own; see resolvePat().

let _orgProjectCache = null;

// org/project for the raw HTTP calls: cfg first (config/project.json azure block, or any of
// the accepted AZURE_* env aliases — see pick()), else read az's OWN persisted defaults
// (whatever `az devops configure -d organization=... project=...` already set) — reuses the
// existing setup rather than asking for anything new.
function resolveOrgProject(cfg) {
  if (cfg.org && cfg.project) return { org: cfg.org, project: cfg.project };
  if (_orgProjectCache) return _orgProjectCache;
  const r = az(['devops', 'configure', '--list']);
  const org = cfg.org || (r.stdout.match(/^organization\s*=\s*(\S+)/m) || [])[1] || null;
  const project = cfg.project || (r.stdout.match(/^project\s*=\s*(.+)$/m) || [])[1]?.trim() || null;
  _orgProjectCache = { org, project };
  return _orgProjectCache;
}

// PAT for the Authorization header on the direct-REST calls below.
//
// THIS IS THE ONE PLACE THE SKILL READS A SECRET ITSELF. It exists only because the two
// calls it serves cannot go through `az` at all (raw binary upload; PATCH-by-id that
// `az devops invoke` mis-routes — both diagnosed in the comments on those functions).
// Everything else still lets `az` handle its own auth. SKILL.md's "Tooling" section states
// this exception explicitly — keep the two in sync if this ever changes.
//
// Order: the variable `az` itself documents (AZURE_DEVOPS_EXT_PAT) first, then the two
// names projects already keep in .env, so no NEW secret has to be introduced anywhere.
// Uses the same env() reader as every other value, so flat `KEY=value` lines and the
// grouped-by-tool .env format both resolve. Never logged, never printed (call sites print
// `<PAT, not printed>`), never returned outside this module.
function resolvePat() {
  for (const name of ['AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_PAT']) {
    const v = env(name);
    if (v) return String(v).trim();
  }
  return null;
}

// Upload one screenshot as a real Work Item attachment → {name, id, url}. All binary
// file handling is encapsulated here: the caller only ever passes a file path in, never
// bytes or base64. Dry run (execute=false) only prints the request it WOULD send.
async function uploadAttachmentBinary(cfg, filePath, { execute = false } = {}) {
  const name = path.basename(filePath);
  const { org, project } = resolveOrgProject(cfg);
  const apiVersion = cfg.apiVersion || '7.1';
  if (!org || !project) {
    throw new Error('cannot resolve org/project for attachment upload — set azure.org/azure.project '
      + '(config/project.json) or run `az devops configure -d organization=... project=...`');
  }
  const uploadUrl = `${org.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_apis/wit/attachments`
    + `?fileName=${encodeURIComponent(name)}&api-version=${apiVersion}`;

  console.log(`  [${execute ? 'run' : 'would run'}] POST ${uploadUrl}`);
  console.log('    Content-Type: application/octet-stream');
  console.log('    Authorization: Basic <PAT, not printed>');
  console.log(`    body: <raw bytes of ${name}>`);

  if (!execute) return { name, id: '<dry-run>', url: '<dry-run-attachment-url>' };

  const pat = resolvePat();
  if (!pat) {
    throw new Error('no PAT available for the direct attachment upload — '
      + 'set AZURE_DEVOPS_EXT_PAT (the same variable `az` itself uses)');
  }
  const body = fs.readFileSync(filePath);
  const auth = Buffer.from(':' + pat).toString('base64');

  let res;
  try {
    res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Basic ${auth}` },
      body,
    });
  } catch (e) {
    throw new Error(`attachment upload request failed: ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`attachment upload failed: HTTP ${res.status} ${res.statusText}`
      + (json ? ` — ${JSON.stringify(json).slice(0, 500)}` : ''));
  }
  return { name, id: json?.id, url: json?.url };
}

// ---- direct-REST JSON Patch on an existing work item ------------------------
// Sets fields and/or adds relations on a work item that already exists. Used for the
// ReproSteps HTML + the AttachedFile relations, in ONE request.
//
// Why not `az`, both options having been tried live:
//  - `az boards work-item update --fields "Microsoft.VSTS.TCM.ReproSteps=<html>"` puts the
//    entire HTML body on the command line. cmd.exe caps a command at 8191 characters
//    (CreateProcess allows 32767, but Node's shell:true goes through cmd.exe). Measured
//    with this skill's own buildReproHtml(): ~1.2k for the boilerplate alone, ~4.5k for a
//    12-step bug with 3 screenshots, ~7.6k for a 20-step one — i.e. a rich repro lands on
//    top of the limit and the command is truncated rather than cleanly rejected. The
//    original design deliberately kept ReproSteps OFF the command line for exactly this
//    reason; this restores that property permanently instead of leaving headroom to eat.
//  - `az devops invoke --area wit --resource workitems --http-method PATCH
//    --route-parameters id=<id>` would take the body from a file, but its location lookup
//    (azext_devops/dev/team/invoke.py) matches purely on (area, resource) and keeps the
//    first location at the highest api-version — never looking at route_parameters or
//    http_method. So it always resolves to the work-item CREATE location, whose route
//    template needs a `type` parameter, and every PATCH-by-id dies with KeyError: 'type'.
//    This is reproducible from a cold `az` invocation.
// The body therefore goes over HTTPS from memory: no shell, no temp file, no length cap.
//
// Bonus over the previous typed-`az` path: a JSON Patch can carry the relation's
// attributes.comment, so each attachment keeps its filename caption on the Attachments tab.
//
// Dry run (execute=false) prints exactly the request it WOULD send and touches nothing.
// Throws on failure — callers decide what a partial write means; nothing is auto-retried.
async function patchWorkItem(cfg, id, patch, { execute = false } = {}) {
  const { org, project } = resolveOrgProject(cfg);
  const apiVersion = cfg.apiVersion || '7.1';
  if (!org || !project) {
    throw new Error('cannot resolve org/project for the work-item update — set azure.org/azure.project '
      + '(config/project.json) or run `az devops configure -d organization=... project=...`');
  }
  const url = `${org.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}`
    + `?api-version=${apiVersion}`;
  const body = JSON.stringify(patch);

  console.log(`  [${execute ? 'run' : 'would run'}] PATCH ${url}`);
  console.log('    Content-Type: application/json-patch+json');
  console.log('    Authorization: Basic <PAT, not printed>');
  console.log(`    body: JSON Patch, ${patch.length} op(s), ${body.length} bytes`);
  for (const op of patch) {
    // Show WHAT each op touches and how big it is, without dumping multi-KB HTML into the
    // confirmation. The rendered repro text is printed separately by create-bug.js.
    const size = typeof op.value === 'string' ? `${op.value.length} chars` : JSON.stringify(op.value);
    console.log(`      - ${op.op} ${op.path} : ${size}`);
  }

  if (!execute) return { ok: true, id, dryRun: true };

  const pat = resolvePat();
  if (!pat) {
    throw new Error('no PAT available for the direct work-item update — '
      + 'set AZURE_DEVOPS_EXT_PAT (the same variable `az` itself uses)');
  }
  const auth = Buffer.from(':' + pat).toString('base64');

  let res;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json', Authorization: `Basic ${auth}` },
      body,
    });
  } catch (e) {
    throw new Error(`work-item update request failed: ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`work-item update failed: HTTP ${res.status} ${res.statusText}`
      + (json ? ` — ${JSON.stringify(json).slice(0, 500)}` : ''));
  }
  return { ok: true, id: json?.id, rev: json?.rev };
}

// ---- work item create via `az devops invoke` (replaces `az boards work-item create`) ----
// `az boards work-item create` has a confirmed bug on this project's Bug type: sending
// `Custom.Environment` + `Custom.BugCategory` together makes it reject one of them with a
// fabricated "Rule Error", even on the minimal 3-field payload (Title + the two fields) —
// diagnosed via validateOnly=true, which runs the exact same server-side rule engine and
// accepts the identical payload cleanly. The bug is specific to that CLI subcommand's own
// request construction; it is NOT a real Azure DevOps process rule, not the field values,
// not their types, and not the api-version. See SKILL.md / diagnostic notes for the full
// trace. This sends the equivalent JSON Patch directly via `az devops invoke`, which is
// unaffected and has been verified (repeatedly, via validateOnly) to accept the same data
// `az boards work-item create` rejects.
//
// `fields` is an array of "Reference.Name=value" strings — the exact same shape callers
// already build for `--fields` — so field-selection logic doesn't move or duplicate.
//
// Returns only what a caller needs: {ok:true, id, url} or {ok:false, error}. Never the raw
// Azure DevOps response.
function createBug(cfg, { type = 'Bug', title, fields = [], validateOnly = false, execute = false } = {}) {
  const { org, project } = resolveOrgProject(cfg);
  const apiVersion = cfg.apiVersion || '7.1';
  if (!org || !project) {
    return { ok: false, error: 'cannot resolve org/project for work item create — set azure.org/azure.project '
      + '(config/project.json) or run `az devops configure -d organization=... project=...`' };
  }

  const patch = [
    { op: 'add', path: '/fields/System.Title', value: title },
    ...fields.map((f) => {
      const eq = f.indexOf('=');
      return { op: 'add', path: `/fields/${f.slice(0, eq)}`, value: f.slice(eq + 1) };
    }),
  ];

  // Build the temp-file path and the argv BEFORE the execute check, so the dry run prints
  // the actual `az devops invoke` command rather than a REST URL that never runs. (It used
  // to print `POST <rest-url>` while executing `az devops invoke` — a dry-run/execute
  // mismatch that broke the skill's "the exact commands they will run" promise.)
  const tmp = path.join(os.tmpdir(), `create-${type}-${Date.now()}.json`);
  const argv = ['devops', 'invoke', '--area', 'wit', '--resource', 'workitems',
    '--route-parameters', `project=${project}`, `type=${type}`,
    '--http-method', 'POST', '--media-type', 'application/json-patch+json',
    '--api-version', apiVersion, '--in-file', tmp,
    ...(validateOnly ? ['--query-parameters', 'validateOnly=true'] : []),
    '--org', org, '-o', 'json'];

  if (!execute) {
    console.log('  [would run] ' + buildCmd(argv));
    console.log(`    --in-file holds the JSON Patch (${patch.length} fields, `
      + `${JSON.stringify(patch).length} bytes); it is written just before the call and `
      + `deleted right after.`);
    return { ok: true, id: '<dry-run>', url: '<dry-run-work-item-url>' };
  }

  fs.writeFileSync(tmp, JSON.stringify(patch));

  let r;
  try {
    r = az(argv, { write: true, execute: true });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: e.message };
  }
  fs.rmSync(tmp, { force: true });

  if (!r.json?.id && !validateOnly) {
    return { ok: false, error: r.stderr?.trim() || 'work item create failed (no id in response)' };
  }
  const id = r.json?.id;
  const url = id ? `${org.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}` : null;
  return { ok: true, id, url, validated: validateOnly || undefined };
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
  loadConfig, orgArgs, az, buildCmd, shQuote, assertNoShellExpansion,
  showWorkItem, findByTitle,
  uploadAttachmentBinary, patchWorkItem, createBug, parseArgs,
  workItemTypeFields, parseFieldRejection, describeFieldRejection,
  VALID_SEVERITY, VALID_PRIORITY, IMPACT_RECOMMENDATION,
};
