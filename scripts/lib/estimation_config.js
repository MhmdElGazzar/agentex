'use strict';
// estimation_config.js — the ONE home of the consumer's estimation file,
// config/estimation.json: its schema, its validator, its starter defaults, and
// its exclusive create. Pure config code: zero dependencies, no tracker code,
// nothing here sends a request.
//
// The file belongs to the user (invariant 11). The plugin creates it ONCE —
// only through createEstimationFileExclusive, an exclusive create ('wx') that
// can never replace or truncate a file — and never rewrites, repairs or
// reformats it afterwards. Reading never writes (loadEstimationConfig is a
// readFileSync and nothing else).
//
// Shape (schemaVersion 1):
//   { "schemaVersion": 1,
//     "tasks":   [ { "name", "enabled", "minHours", "maxHours" }, … ],   order = creation order
//     "factors": { "<factor name>": <weight ≥ 0>, … },                     at least one weight > 0
//     "source":  { "kind", "sprints", "sprintsRead", "tasksCounted",       optional provenance record;
//                  "tasksSkipped", "reason", "createdOn", "note" } }       only `sprints` is checked
//
// Every problem is { code, path, entry?, message }; the message always names
// the file, the problem and the offending entry, for example
//   config/estimation.json: tasks[2] ("Test Execution"): minHours 4 is greater than maxHours 2
// validateEstimationConfig reports EVERY problem at once, in document order.
//
// The task list here is also what other flows read (one source per concept):
// title = '[Testing] ' + normalizeTaskName(name); no file → STARTER_TASKS.
const fs = require('node:fs');
const path = require('node:path');

const ESTIMATION_FILE_REL = 'config/estimation.json';
const SCHEMA_VERSION = 1;
const DEFAULT_SPRINTS = 2;

// Tunable defaults (Q8). The starter defaults: five tasks, all enabled, on the
// half-hour grid, 3.0 h at every min and 5.0 h at every max per story.
const STARTER_TASKS = Object.freeze([
  Object.freeze({ name: 'Requirement Review', enabled: true, minHours: 0.5, maxHours: 1 }),
  Object.freeze({ name: 'Test Creation', enabled: true, minHours: 0.5, maxHours: 1 }),
  Object.freeze({ name: 'Test Execution', enabled: true, minHours: 1, maxHours: 1.5 }),
  Object.freeze({ name: 'Bug Review and Retest', enabled: true, minHours: 0.5, maxHours: 1 }),
  Object.freeze({ name: 'Automation', enabled: true, minHours: 0.5, maxHours: 0.5 }),
]);

// The eight default rating factors, weight 1 each.
const DEFAULT_FACTORS = Object.freeze({
  'Scenarios / ACs': 1,
  'UI elements': 1,
  'Validations': 1,
  'Conditions / logic': 1,
  'Error messages': 1,
  'API integrations': 1,
  'Translations': 1,
  'Edge cases': 1,
});

const TOP_KEYS = ['schemaVersion', 'tasks', 'factors', 'source'];
const TASK_KEYS = ['name', 'enabled', 'minHours', 'maxHours'];

// A leading [Testing] marker is tolerated (case-insensitive) and stripped, so
// the title prefix is never doubled.
function normalizeTaskName(name) {
  return String(name).trim().replace(/^\[testing\]/i, '').trim();
}
const taskKey = (name) => normalizeTaskName(name).toLowerCase();

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// `at` is where the message points (the entry); `pathStr` is the exact path.
function problem(code, pathStr, entry, text, at = pathStr) {
  const where = at ? `${at}${entry !== undefined ? ` (${JSON.stringify(entry)})` : ''}: ` : '';
  return {
    code, path: pathStr,
    ...(entry !== undefined ? { entry } : {}),
    message: `${ESTIMATION_FILE_REL}: ${where}${text}`,
  };
}

// ── the validator (pure) ─────────────────────────────────────────────────────
function validateTasks(tasks, out) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    out.push(problem('tasks-missing', 'tasks', undefined, 'tasks must be a non-empty array of { name, enabled, minHours, maxHours }'));
    return;
  }
  const seen = new Map(); // taskKey -> first index
  let enabledCount = 0;
  tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!isPlainObject(t)) {
      out.push(problem('task-not-object', at, undefined, `each task must be an object { name, enabled, minHours, maxHours } (got ${JSON.stringify(t)})`));
      return;
    }
    const name = typeof t.name === 'string' ? normalizeTaskName(t.name) : '';
    const entry = name || undefined;
    if (!name) {
      out.push(problem('name-missing', at, undefined, `name must be a non-empty string (got ${JSON.stringify(t.name ?? null)})`));
    } else {
      const k = name.toLowerCase();
      if (seen.has(k)) {
        out.push(problem('name-duplicate', at, entry,
          `the name duplicates tasks[${seen.get(k)}] — task names must be unique (case, surrounding spaces and a [Testing] marker are ignored)`));
      } else seen.set(k, i);
    }
    if (typeof t.enabled !== 'boolean') {
      out.push(problem('enabled-not-boolean', at, entry, `enabled must be true or false (got ${JSON.stringify(t.enabled ?? null)})`));
    } else if (t.enabled) enabledCount++;
    let bothValid = true;
    for (const k of ['minHours', 'maxHours']) {
      if (!Object.prototype.hasOwnProperty.call(t, k)) {
        out.push(problem('hours-missing', `${at}.${k}`, entry, `${k} is missing`, at));
        bothValid = false;
      } else if (!isNumber(t[k])) {
        out.push(problem('hours-not-number', `${at}.${k}`, entry, `${k} must be a number (got ${JSON.stringify(t[k])})`, at));
        bothValid = false;
      } else if (t[k] <= 0) {
        out.push(problem('hours-not-positive', `${at}.${k}`, entry, `${k} must be greater than 0 (got ${t[k]})`, at));
        bothValid = false;
      }
    }
    if (bothValid && t.minHours > t.maxHours) {
      out.push(problem('min-greater-than-max', at, entry, `minHours ${t.minHours} is greater than maxHours ${t.maxHours}`));
    }
    for (const k of Object.keys(t)) {
      if (!TASK_KEYS.includes(k)) {
        out.push(problem('unknown-key', at, entry, `unknown key ${JSON.stringify(k)} — a task has exactly ${TASK_KEYS.join(', ')}`));
      }
    }
  });
  if (enabledCount === 0) {
    out.push(problem('no-enabled-task', 'tasks', undefined, 'no task is enabled — at least one task needs "enabled": true'));
  }
}

function validateFactors(factors, out) {
  if (!isPlainObject(factors) || Object.keys(factors).length === 0) {
    out.push(problem('factors-missing', 'factors', undefined, 'factors must be a non-empty object of "<factor name>": <weight>'));
    return;
  }
  const seen = new Map();
  let positive = 0;
  for (const [rawName, w] of Object.entries(factors)) {
    const name = rawName.trim();
    const at = `factors[${JSON.stringify(rawName)}]`;
    if (!name) {
      out.push(problem('factor-name-empty', at, undefined, 'a factor name must not be empty'));
    } else if (seen.has(name.toLowerCase())) {
      out.push(problem('factor-name-duplicate', at, name,
        `the factor name duplicates ${JSON.stringify(seen.get(name.toLowerCase()))} — factor names must be unique (case and surrounding spaces are ignored)`));
    } else seen.set(name.toLowerCase(), rawName);
    if (!isNumber(w)) {
      out.push(problem('weight-not-number', at, name || undefined, `the weight must be a number (got ${JSON.stringify(w)})`));
    } else if (w < 0) {
      out.push(problem('weight-negative', at, name || undefined, `the weight must be 0 or more (got ${w})`));
    } else if (w > 0) positive++;
  }
  if (positive === 0) {
    out.push(problem('no-positive-weight', 'factors', undefined, 'no factor has a positive weight — at least one weight must be greater than 0'));
  }
}

function validateSource(source, out) {
  if (!isPlainObject(source)) {
    out.push(problem('source-not-object', 'source', undefined, `source must be an object (got ${JSON.stringify(source)})`));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sprints') &&
      !(Number.isInteger(source.sprints) && source.sprints > 0)) {
    out.push(problem('sprints-not-positive-integer', 'source.sprints', undefined,
      `the sprint count must be a positive whole number (got ${JSON.stringify(source.sprints)})`));
  }
}

// Every problem at once, in document order (top-level keys as they appear;
// missing required keys after them).
function validateEstimationConfig(obj) {
  const out = [];
  if (!isPlainObject(obj)) {
    out.push(problem('parse-error', '', undefined, `the file must hold one JSON object (got ${Array.isArray(obj) ? 'an array' : JSON.stringify(obj)})`));
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === 'schemaVersion') {
      if (obj.schemaVersion !== SCHEMA_VERSION) {
        out.push(problem('schema-version', 'schemaVersion', undefined,
          `unknown schemaVersion ${JSON.stringify(obj.schemaVersion)} — this plugin reads schemaVersion ${SCHEMA_VERSION}`));
      }
    } else if (k === 'tasks') validateTasks(obj.tasks, out);
    else if (k === 'factors') validateFactors(obj.factors, out);
    else if (k === 'source') validateSource(obj.source, out);
    else {
      out.push(problem('unknown-key', k, undefined, `unknown key ${JSON.stringify(k)} — the file has only ${TOP_KEYS.join(', ')}`));
    }
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'schemaVersion')) {
    out.push(problem('schema-version', 'schemaVersion', undefined, `schemaVersion is missing — this plugin reads schemaVersion ${SCHEMA_VERSION}`));
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'tasks')) validateTasks(undefined, out);
  if (!Object.prototype.hasOwnProperty.call(obj, 'factors')) validateFactors(undefined, out);
  return out;
}

// ── raw-text scan: strict JSON with a position, and duplicate keys ───────────
// JSON.parse silently keeps the LAST duplicate key (a second "factors", a
// repeated factor name) and does not always report a position, so the raw
// text is scanned first. Returns { ok: true, duplicates: [{ path, key }] } or
// { ok: false, offset, what }.
function scanJson(text) {
  let i = 0;
  const duplicates = [];
  const fail = (what) => { const e = new Error(what); e.offset = i; throw e; };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const describe = () => (i >= text.length ? 'end of input' : `${JSON.stringify(text[i])}`);
  function str() {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; return JSON.parse(text.slice(start, i)); }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i += 1; fail('a bad \\u escape'); }
          i += 6;
        } else if ('"\\/bfnrt'.includes(n) && n !== undefined) i += 2;
        else { i += 1; fail('a bad escape'); }
      } else if (c.charCodeAt(0) < 0x20) fail('a control character inside a string');
      else i++;
    }
    return fail('an unterminated string');
  }
  function num() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail(`unexpected ${describe()}`);
    i += m[0].length;
  }
  function value(p) {
    ws();
    const c = text[i];
    if (c === '{') return object(p);
    if (c === '[') return array(p);
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { i += lit.length; return; }
    }
    return fail(`unexpected ${describe()}`);
  }
  function object(p) {
    i++; ws();
    const keys = new Set();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail(`expected a double-quoted key, found ${describe()}`);
      const key = str();
      if (keys.has(key)) duplicates.push({ path: p, key });
      keys.add(key);
      ws();
      if (text[i] !== ':') fail(`expected ":" after a key, found ${describe()}`);
      i++;
      value(p ? (/^[A-Za-z_]\w*$/.test(key) ? `${p}.${key}` : `${p}[${JSON.stringify(key)}]`) : key);
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return; }
      fail(`expected "," or "}" in an object, found ${describe()}`);
    }
  }
  function array(p) {
    i++; ws();
    if (text[i] === ']') { i++; return; }
    for (let n = 0; ; n++) {
      value(`${p}[${n}]`);
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return; }
      fail(`expected "," or "]" in an array, found ${describe()}`);
    }
  }
  try {
    value('');
    ws();
    if (i < text.length) fail(`unexpected ${describe()} after the JSON value`);
    return { ok: true, duplicates };
  } catch (e) {
    if (typeof e.offset !== 'number') throw e;
    return { ok: false, offset: e.offset, what: e.message };
  }
}

function lineCol(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

function normalizeContent(obj) {
  const content = {};
  for (const k of Object.keys(obj)) {
    if (k === 'tasks') content.tasks = obj.tasks.map((t) => ({ ...t, name: normalizeTaskName(t.name) }));
    else if (k === 'factors') content.factors = Object.fromEntries(Object.entries(obj.factors).map(([n, w]) => [n.trim(), w]));
    else content[k] = obj[k];
  }
  return content;
}

// Read (only) the project's estimation file.
//   { state: 'missing' }
//   { state: 'invalid', problems }               parse error (with position), duplicate keys, schema problems
//   { state: 'valid', content, enabledTasks }    content: normalized names, original order
function loadEstimationConfig(cwd) {
  const file = path.join(cwd, ...ESTIMATION_FILE_REL.split('/'));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', problems: [problem('parse-error', '', undefined, `the file could not be read (${e.code || e.message})`)] };
  }
  const scan = scanJson(text);
  if (!scan.ok) {
    const { line, column } = lineCol(text, scan.offset);
    return {
      state: 'invalid',
      problems: [problem('parse-error', '', undefined, `the file is not valid JSON — ${scan.what} at line ${line}, column ${column}`)],
    };
  }
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { state: 'invalid', problems: [problem('parse-error', '', undefined, `the file is not valid JSON — ${e.message}`)] }; }
  const problems = scan.duplicates.map((d) => problem('duplicate-key', d.path, undefined,
    `duplicate key ${JSON.stringify(d.key)} — JSON keeps only the last one, so the file is ambiguous; keep one`));
  problems.push(...validateEstimationConfig(obj));
  if (problems.length) return { state: 'invalid', problems };
  const content = normalizeContent(obj);
  return { state: 'valid', content, enabledTasks: content.tasks.filter((t) => t.enabled) };
}

function serializeEstimationConfig(content) {
  return JSON.stringify(content, null, 2) + '\n';
}

// THE write: an exclusive create ('wx') — it can never replace, truncate or
// rewrite a file; a file that exists by now is reported as a named error.
function createEstimationFileExclusive(cwd, content) {
  const file = path.join(cwd, ...ESTIMATION_FILE_REL.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') {
      const err = new Error(`${ESTIMATION_FILE_REL} appeared after this run's checks — not replaced`);
      err.name = 'EstimationFileExistsError';
      err.code = 'estimation-file-exists';
      throw err;
    }
    throw e;
  }
  try {
    fs.writeSync(fd, serializeEstimationConfig(content));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  ESTIMATION_FILE_REL, SCHEMA_VERSION, DEFAULT_SPRINTS,
  STARTER_TASKS, DEFAULT_FACTORS,
  normalizeTaskName, taskKey,
  validateEstimationConfig, loadEstimationConfig,
  createEstimationFileExclusive, serializeEstimationConfig,
};
