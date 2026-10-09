'use strict';
// AgenTeX project-config resolver — the ONE place that knows where project data lives.
//
// Three kinds of data, three homes:
//   secrets            → .env                        (only secrets)
//   project settings   → config/project.json         (azure, kb, login, defaultEnvironment)
//   environment data   → environments/<env>.json     (portalUrl, defaults, users, db, api)
//
// Resolution order everywhere: new files first, .env fallback second — so legacy
// projects (everything in .env) keep working untouched.
//
// Secret-valued JSON fields are either a plain string (throwaway test creds only)
// or { "envSecret": "NAME" } naming the .env variable that holds the real value.
const fs = require('fs');
const path = require('path');

// Read an env var: process.env first, then a KEY=value line in <cwd>/.env
// (the harness does not always load .env into process.env). null when unset.
function readEnvVar(cwd, name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const re = new RegExp('^' + name + '\\s*=\\s*(.+)$', 'm');
    const m = fs.readFileSync(path.join(cwd, '.env'), 'utf8').match(re);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return null;
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
}

// config/project.json — {} when absent (legacy project).
function loadProjectConfig(cwd) {
  return readJsonIfExists(path.join(cwd, 'config', 'project.json')) || {};
}

// Names of defined environments; [] when environments/ doesn't exist.
function listEnvironments(cwd) {
  const dir = path.join(cwd, 'environments');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

// Active environment: explicit name → defaultEnvironment → null (legacy project).
// A wanted environment with no file is an error (fail fast, list what exists) —
// never a silent fallback to another environment.
function loadEnvironment(cwd, name) {
  const wanted = name || loadProjectConfig(cwd).defaultEnvironment || null;
  if (!wanted) return null;
  const file = path.join(cwd, 'environments', `${wanted}.json`);
  const data = readJsonIfExists(file);
  if (data === null) {
    const avail = listEnvironments(cwd);
    throw new Error(`environment "${wanted}" not found — ${avail.length ? `available: ${avail.join(', ')}` : 'this project has no environments/ folder'}`);
  }
  return { name: wanted, ...data };
}

// A secret-valued field: plain string = the literal value; { envSecret: "NAME" } =
// that variable's value (process.env → .env). null when unset/unresolvable.
function resolveSecret(cwd, field) {
  if (field == null) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && typeof field.envSecret === 'string') return readEnvVar(cwd, field.envSecret);
  return null;
}

// Human-readable pointer for "not set" error messages.
function secretHint(field) {
  return field && typeof field === 'object' && field.envSecret ? `env var ${field.envSecret}` : 'value';
}

// DB connection: active environment's db block first, legacy catalog "connection"
// env-var names second. Throws a BLOCKED-worthy Error when nothing resolves.
function resolveDbConnection(cwd, envName, catalogConn) {
  const environment = loadEnvironment(cwd, envName);
  const db = environment && environment.db;
  if (db) {
    if (!db.server) throw new Error(`environment "${environment.name}" db block has no "server"`);
    return {
      server: String(db.server),
      port: db.port !== undefined && db.port !== null && db.port !== '' ? String(db.port) : '',
      database: db.name ? String(db.name) : '',
      user: db.user ? String(db.user) : '',
      password: resolveSecret(cwd, db.password) || readEnvVar(cwd, 'SQLCMDPASSWORD'),
      passwordHint: db.password ? secretHint(db.password) : 'env var SQLCMDPASSWORD',
      source: `environments/${environment.name}.json`,
    };
  }
  const conn = catalogConn || {};
  const fromEnv = key => (conn[key] ? readEnvVar(cwd, conn[key]) : null);
  const server = fromEnv('serverEnv');
  if (!server) {
    throw new Error(conn.serverEnv
      ? `env var ${conn.serverEnv} (server) is not set`
      : 'no db config: add a "db" block to the active environment file (environments/<env>.json) or a "connection" block to the catalog');
  }
  const database = fromEnv('databaseEnv');
  if (conn.databaseEnv && !database) throw new Error(`env var ${conn.databaseEnv} (database) is not set`);
  const user = fromEnv('userEnv');
  if (conn.userEnv && !user) throw new Error(`env var ${conn.userEnv} (user) is not set`);
  return {
    server,
    port: fromEnv('portEnv') || '',
    database: database || '',
    user: user || '',
    password: readEnvVar(cwd, 'SQLCMDPASSWORD'),
    passwordHint: 'env var SQLCMDPASSWORD',
    source: 'catalog connection (.env)',
  };
}

// API target from the active environment's api block; null → caller falls back
// to the catalog's ${ENV_VAR} baseUrl / auth block (legacy path).
function resolveApiTarget(cwd, envName) {
  const environment = loadEnvironment(cwd, envName);
  const api = environment && environment.api;
  if (!api || !api.baseUrl) return null;
  return {
    baseUrl: String(api.baseUrl).replace(/\/$/, ''),
    token: resolveSecret(cwd, api.token),
    hasToken: api.token !== undefined && api.token !== null,
    tokenHint: secretHint(api.token),
    source: `environments/${environment.name}.json`,
  };
}

// ════ Structured settings (skill-consolidation-foundation R5) ═════════════════
// pick()-style readers turn values into flat strings; the plugin-owned blocks
// below are nested and typed, so they get ONE getter: per-key merged over
// STRUCTURED_DEFAULTS, types kept, validated strictly. A malformed value is a
// ConfigError (exit 2) naming the key path and the accepted values — never a
// silent default (invariant 10). The flat readers above are untouched.
//
// Where each block lives in config/project.json:
//   testingTasks, testDesign, estimation, qaRecords  -> top-level keys
//   workflow, reproSummaryRow                        -> the CONFIGURED provider's
//     block (azure.* or jira.*, the same shape on both); no tracker -> workflow null
//
// The defaults reproduce today's behaviour exactly: the five [Testing] tasks in
// task-estimation SKILL.md's order (a test pins the table), workflow states
// EMPTY (a lifecycle step whose state is unset names the key and skips — never
// guesses), the repro summary row on, consolidated approval, no independent
// coverage check.
const TESTING_PREFIX = '[Testing] '; // the estimation contract (task-estimation rules.js TITLE_PREFIX)

const STRUCTURED_DEFAULTS = Object.freeze({
  testingTasks: [
    { stage: 'requirementReview', title: '[Testing] Requirement Review', enabled: true },
    { stage: 'testCreation', title: '[Testing] Test Creation', enabled: true },
    { stage: 'testExecution', title: '[Testing] Test Execution', enabled: true },
    { stage: 'bugRetest', title: '[Testing] Bug Review and Retest', enabled: true },
    { stage: 'automation', title: '[Testing] Automation', enabled: true },
  ],
  workflow: {
    devDoneStates: [], devActiveStates: [], inTestState: '', qaStates: [], terminalStates: [],
    taskActiveState: '', taskClosedState: '', testCaseReadyState: '',
    closeOut: { state: '', assignee: '' },
  },
  reproSummaryRow: true,
  testDesign: { approval: 'consolidated', independentCoverageCheck: false },
  estimation: { modelPath: '.agentex/task-estimation.json', historyPath: '.agentex/estimation-history.jsonl' },
  // The QA-record files: one committed folder at the project root, all Markdown,
  // each file created lazily on its first append. THE one home of these default
  // paths — everything else (tests, docs, migration, wizard) reads or is pinned
  // against this constant.
  qaRecords: {
    pendingQuestions: 'qa-records/open-questions.md',
    pendingRechecks: 'qa-records/pending-rechecks.md',
    envIssues: 'qa-records/env-issues.md',
    deferredConditions: 'qa-records/deferred-conditions.md',
  },
});
deepFreeze(STRUCTURED_DEFAULTS);

const STRUCTURED_KEYS = ['testingTasks', 'workflow', 'reproSummaryRow', 'testDesign', 'estimation', 'qaRecords'];
const TOP_LEVEL_BLOCKS = ['testingTasks', 'testDesign', 'estimation', 'qaRecords'];
const APPROVAL_MODES = ['consolidated', 'per-story'];
const QA_RECORD_EXTENSIONS = ['.md', '.jsonl'];
const WORKFLOW_LISTS = ['devDoneStates', 'devActiveStates', 'qaStates', 'terminalStates'];
const WORKFLOW_STATES = ['inTestState', 'taskActiveState', 'taskClosedState', 'testCaseReadyState'];

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
const copy = (v) => JSON.parse(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const where = 'config/project.json';

function expectObject(v, keyPath) {
  if (!isPlainObject(v)) throw new ConfigError(`${where}: ${keyPath} must be an object (got ${typeOf(v)}).`);
}
function rejectUnknownKeys(obj, known, keyPath) {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      throw new ConfigError(`${where}: unknown key ${keyPath}.${k} — the known keys are: ${known.join(', ')}.`);
    }
  }
}
function expectBoolean(v, keyPath) {
  if (typeof v !== 'boolean') throw new ConfigError(`${where}: ${keyPath} must be true or false (a JSON boolean; got ${JSON.stringify(v)}).`);
}
// A project-relative path: a non-empty string, never absolute, no '..' segment.
function expectRelativePath(v, keyPath, extensions) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConfigError(`${where}: ${keyPath} must be a non-empty project-relative path (got ${JSON.stringify(v)}).`);
  }
  if (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\')) {
    throw new ConfigError(`${where}: ${keyPath} must be a project-relative path, not absolute (got ${JSON.stringify(v)}).`);
  }
  if (v.split(/[\\/]/).includes('..')) {
    throw new ConfigError(`${where}: ${keyPath} must stay inside the project — no '..' segment (got ${JSON.stringify(v)}).`);
  }
  if (extensions && !extensions.some((ext) => v.toLowerCase().endsWith(ext))) {
    throw new ConfigError(`${where}: ${keyPath} must end in ${extensions.join(' or ')} — the file format follows the extension (got ${JSON.stringify(v)}).`);
  }
}

// The provider-block rule — the same as scripts/lib/tracker/index.js
// resolveTracker (kept as its own copy there to avoid a require cycle; a test
// pins that the two agree): one non-empty `azure`/`jira` block, or legacy
// AZURE_URL / AZURE_PROJECT lines in .env -> 'azure'. null when no tracker is
// configured; two blocks are an error worded exactly like resolveTracker's.
const PROVIDER_BLOCKS = ['azure', 'jira'];
function detectTrackerBlock(cfg, cwd) {
  // Exactly resolveTracker's test (any non-empty object value counts).
  const configured = PROVIDER_BLOCKS.filter((p) => cfg[p] && typeof cfg[p] === 'object' && Object.keys(cfg[p]).length > 0);
  if (configured.length === 0 && cwd && (readEnvVar(cwd, 'AZURE_URL') || readEnvVar(cwd, 'AZURE_PROJECT'))) {
    configured.push('azure');
  }
  if (configured.length > 1) {
    throw new ConfigError(
      `More than one tracker provider is configured (${configured.join(', ')}) — ` +
      'a project uses one tracker, so this fails closed rather than silently picking one. ' +
      'Keep exactly one provider block in config/project.json — re-run the /init-test wizard and answer its tracker question to switch cleanly.');
  }
  return configured[0] || null;
}

// ── per-block resolvers: validate the user's value, merge over the default ──
function resolveTestingTasks(user) {
  const defaults = STRUCTURED_DEFAULTS.testingTasks;
  if (user === undefined) return copy(defaults);
  if (!Array.isArray(user)) throw new ConfigError(`${where}: testingTasks must be an array of { stage, title?, enabled? } entries (got ${typeOf(user)}).`);
  const stages = defaults.map((t) => t.stage);
  const byStage = new Map();
  user.forEach((entry, i) => {
    const kp = `testingTasks[${i}]`;
    expectObject(entry, kp);
    rejectUnknownKeys(entry, ['stage', 'title', 'enabled'], kp);
    if (!stages.includes(entry.stage)) {
      throw new ConfigError(`${where}: ${kp}.stage is ${JSON.stringify(entry.stage)} — accepted stages: ${stages.join(', ')}.`);
    }
    if (byStage.has(entry.stage)) {
      throw new ConfigError(`${where}: ${kp}.stage "${entry.stage}" is a duplicate — each stage appears at most once (accepted stages: ${stages.join(', ')}).`);
    }
    if (entry.title !== undefined && (typeof entry.title !== 'string' || !entry.title.startsWith(TESTING_PREFIX) || entry.title.trim() === TESTING_PREFIX.trim())) {
      throw new ConfigError(`${where}: ${kp}.title must be a string starting with "${TESTING_PREFIX}" (the estimation contract; got ${JSON.stringify(entry.title)}).`);
    }
    if (entry.enabled !== undefined) expectBoolean(entry.enabled, `${kp}.enabled`);
    byStage.set(entry.stage, entry);
  });
  return defaults.map((d) => {
    const u = byStage.get(d.stage) || {};
    return { stage: d.stage, title: u.title !== undefined ? u.title : d.title, enabled: u.enabled !== undefined ? u.enabled : d.enabled };
  });
}

function resolveTestDesign(user) {
  const out = copy(STRUCTURED_DEFAULTS.testDesign);
  if (user === undefined) return out;
  expectObject(user, 'testDesign');
  rejectUnknownKeys(user, Object.keys(out), 'testDesign');
  if (user.approval !== undefined) {
    if (!APPROVAL_MODES.includes(user.approval)) {
      throw new ConfigError(`${where}: testDesign.approval is ${JSON.stringify(user.approval)} — accepted values: ${APPROVAL_MODES.join(', ')}.`);
    }
    out.approval = user.approval;
  }
  if (user.independentCoverageCheck !== undefined) {
    expectBoolean(user.independentCoverageCheck, 'testDesign.independentCoverageCheck');
    out.independentCoverageCheck = user.independentCoverageCheck;
  }
  return out;
}

function resolvePaths(name, user, extensions) {
  const out = copy(STRUCTURED_DEFAULTS[name]);
  if (user === undefined) return out;
  expectObject(user, name);
  rejectUnknownKeys(user, Object.keys(out), name);
  for (const [k, v] of Object.entries(user)) {
    expectRelativePath(v, `${name}.${k}`, extensions);
    out[k] = v;
  }
  return out;
}

function resolveWorkflow(user, block) {
  const out = copy(STRUCTURED_DEFAULTS.workflow);
  if (user === undefined) return out;
  const kp = `${block}.workflow`;
  expectObject(user, kp);
  rejectUnknownKeys(user, Object.keys(out), kp);
  for (const k of WORKFLOW_LISTS) {
    if (user[k] === undefined) continue;
    if (!Array.isArray(user[k]) || !user[k].every((x) => typeof x === 'string')) {
      throw new ConfigError(`${where}: ${kp}.${k} must be an array of strings (state names; got ${JSON.stringify(user[k])}).`);
    }
    out[k] = [...user[k]]; // arrays replace wholesale
  }
  for (const k of WORKFLOW_STATES) {
    if (user[k] === undefined) continue;
    if (typeof user[k] !== 'string') throw new ConfigError(`${where}: ${kp}.${k} must be a string (one state name, '' = not configured; got ${JSON.stringify(user[k])}).`);
    out[k] = user[k];
  }
  if (user.closeOut !== undefined) {
    expectObject(user.closeOut, `${kp}.closeOut`);
    rejectUnknownKeys(user.closeOut, Object.keys(out.closeOut), `${kp}.closeOut`);
    for (const k of Object.keys(out.closeOut)) {
      if (user.closeOut[k] === undefined) continue;
      if (typeof user.closeOut[k] !== 'string') throw new ConfigError(`${where}: ${kp}.closeOut.${k} must be a string (got ${JSON.stringify(user.closeOut[k])}).`);
      out.closeOut[k] = user.closeOut[k];
    }
  }
  return out;
}

function resolveReproSummaryRow(v, block) {
  if (v === undefined) return STRUCTURED_DEFAULTS.reproSummaryRow;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;   // the pick()-era spelling — a typed parse, not a fallback
  if (v === 'false') return false;
  throw new ConfigError(`${where}: ${block}.reproSummaryRow must be true or false (a JSON boolean, or exactly "true"/"false"; got ${JSON.stringify(v)}).`);
}

// getStructured(cwd)       -> { testingTasks, workflow, reproSummaryRow, testDesign, estimation, qaRecords }
// getStructured(cwd, key)  -> that one block (only that block is validated)
// Every value is a fresh copy — callers may mutate it freely.
function getStructured(cwd, key) {
  if (key !== undefined && !STRUCTURED_KEYS.includes(key)) {
    throw new ConfigError(`getStructured: unknown key ${JSON.stringify(key)} — known keys: ${STRUCTURED_KEYS.join(', ')}.`);
  }
  const cfg = loadProjectConfig(cwd);
  const wanted = key === undefined ? STRUCTURED_KEYS : [key];
  let block; // the configured provider block, resolved only when needed
  const providerBlock = () => (block === undefined ? (block = detectTrackerBlock(cfg, cwd)) : block);
  const out = {};
  for (const k of wanted) {
    if (k === 'testingTasks') out[k] = resolveTestingTasks(cfg.testingTasks);
    else if (k === 'testDesign') out[k] = resolveTestDesign(cfg.testDesign);
    else if (k === 'estimation') out[k] = resolvePaths('estimation', cfg.estimation);
    else if (k === 'qaRecords') out[k] = resolvePaths('qaRecords', cfg.qaRecords, QA_RECORD_EXTENSIONS);
    else if (k === 'workflow') {
      const b = providerBlock();
      out[k] = b ? resolveWorkflow((cfg[b] || {}).workflow, b) : null;
    } else if (k === 'reproSummaryRow') {
      const b = providerBlock();
      out[k] = b ? resolveReproSummaryRow((cfg[b] || {}).reproSummaryRow, b) : STRUCTURED_DEFAULTS.reproSummaryRow;
    }
  }
  return key === undefined ? out : out[key];
}

// The ONE function the wizard's save and migration 12 share, so a fresh
// project and a migrated one end with identical plugin blocks. Pure: returns a
// new object (key order kept, new keys appended) and never mutates its input.
//   - each absent top-level block (testingTasks, testDesign, estimation,
//     qaRecords) is added from STRUCTURED_DEFAULTS;
//   - `workflow` (the empty defaults) is added to the ONE non-empty provider
//     block when that block lacks it;
//   - never creates a provider block, never touches a second one (two blocks
//     are left alone for the wizard to fix), never overwrites a present block,
//     never writes reproSummaryRow.
function withPluginConfigBlocks(projectConfig) {
  const out = copy(projectConfig || {});
  for (const k of TOP_LEVEL_BLOCKS) {
    if (!(k in out)) out[k] = copy(STRUCTURED_DEFAULTS[k]);
  }
  const configured = PROVIDER_BLOCKS.filter((p) => isPlainObject(out[p]) && Object.keys(out[p]).length > 0);
  if (configured.length === 1 && !('workflow' in out[configured[0]])) {
    out[configured[0]].workflow = copy(STRUCTURED_DEFAULTS.workflow);
  }
  return out;
}

module.exports = {
  readEnvVar, loadProjectConfig, listEnvironments, loadEnvironment,
  resolveSecret, secretHint, resolveDbConnection, resolveApiTarget,
  STRUCTURED_DEFAULTS, ConfigError, getStructured, withPluginConfigBlocks, detectTrackerBlock,
};
