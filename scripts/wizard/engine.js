// AgenTeX Wizard Engine
// Shared logic: maps wizard answers → config/project.json + environments/<env>.json
// Used by: server.js (local plugin) and future web app (same logic, different save action)

'use strict';

// The prefilled, freely-editable default environment name — the ONE definition.
// schema.json's default/placeholder, server.js's config-read fallback, and
// ui.html's fallbacks all mirror this value; migrate.js requires it too.
const DEFAULT_ENV_NAME = 'qc';

/* ── Consumer-owned field schema (wizard design #4) ─────────────────────────
 * The test-user and defaults field sets are DESCRIPTOR ARRAYS in the
 * consumer's config/project.json (`userFields`, `defaultsFields`): defined
 * once, shared across ALL environments — only VALUES are per-environment.
 * `handle` is reserved: it keys the `users` object and is never in the array.
 * The built-ins below describe exactly the fields the wizard has always
 * written; templates/config/project.json ships the same arrays (m11 backfills
 * existing projects) and ui.html mirrors them (browser copy — keep in sync).
 * Descriptor: { key, label, labelEn?, type?: text|email|number|url,
 * secret?: bool, required?: bool, default?, hint?, placeholder? }.
 */
const BUILTIN_USER_FIELDS = [
  { key: 'phone', label: 'رقم الهاتف', labelEn: 'Phone', type: 'text', placeholder: '0550000001' },
  { key: 'email', label: 'البريد الإلكتروني', labelEn: 'Email', type: 'email', placeholder: 'test@example.com' },
  { key: 'role', label: 'الدور', labelEn: 'Role', type: 'text', placeholder: 'customer' },
  { key: 'notes', label: 'ملاحظات', labelEn: 'Notes', type: 'text', placeholder: 'for negative login scenarios' },
];
const BUILTIN_DEFAULTS_FIELDS = [
  { key: 'password', label: 'كلمة المرور الافتراضية', labelEn: 'Default Password', default: 'Test@1234',
    hint: 'كلمة مرور حسابات الاختبار المشتركة — تُكتب كما هي في ملف البيئة (ليست سراً حقيقياً)' },
  { key: 'otp', label: 'OTP الافتراضي', labelEn: 'Default OTP', default: '0000' },
];

const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_TYPES = ['text', 'email', 'number', 'url'];

/**
 * Validate one field-descriptor array (`userFields` / `defaultsFields`).
 * `opts.reserved` names keys that may never appear (e.g. `handle`).
 * Returns array of error strings (empty = valid).
 */
function validateFieldDescriptors(arr, which, opts = {}) {
  if (!Array.isArray(arr)) return [`${which} must be an array of field descriptors`];
  const errors = [];
  const reserved = opts.reserved || [];
  const seen = new Set();
  arr.forEach((f, i) => {
    const at = `${which}[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(`${at}: descriptor must be an object`); return; }
    const key = String(f.key || '');
    if (!FIELD_KEY_RE.test(key)) {
      errors.push(`${at}: key "${key}" must start with a letter and use only letters/digits/_ (it becomes a JSON key)`);
      return;
    }
    if (reserved.includes(key)) {
      errors.push(`${at}: key "${key}" is reserved — it keys the users object, always present, never renamed or removed`);
    }
    if (seen.has(key)) errors.push(`${at}: duplicate key "${key}"`);
    seen.add(key);
    if (f.type !== undefined && !FIELD_TYPES.includes(f.type)) {
      errors.push(`${at}: type "${f.type}" is not one of ${FIELD_TYPES.join('|')} (secret is a flag, not a type)`);
    }
    if (f.secret !== undefined && typeof f.secret !== 'boolean') errors.push(`${at}: secret must be a boolean`);
  });
  return errors;
}

/** Descriptor-array validation for a projectConfig payload — both arrays, when present. */
function validateProjectFieldSchema(projectConfig) {
  if (!projectConfig || typeof projectConfig !== 'object') return [];
  const errors = [];
  if (projectConfig.userFields !== undefined) {
    errors.push(...validateFieldDescriptors(projectConfig.userFields, 'userFields', { reserved: ['handle'] }));
  }
  if (projectConfig.defaultsFields !== undefined) {
    errors.push(...validateFieldDescriptors(projectConfig.defaultsFields, 'defaultsFields'));
  }
  return errors;
}

/**
 * Given a flat answers object (keyed by field.key), build the two output config objects.
 * @param {object} answers  - e.g. { "name": "my-app", "azure.org": "myorg", "db.server": "..." }
 * @param {object[]} steps  - from schema.json
 * @param {{userFields?: object[], defaultsFields?: object[]}} fields - the effective
 *   consumer field schema (design #4); built-ins when absent.
 * @returns {{ projectConfig: object, envConfig: object, envName: string }}
 */
function buildConfigs(answers, steps, fields = {}) {
  // envName names the environment FILE being configured. defaultEnvironment in
  // project.json is derived output only (first-configured-claims-default) —
  // never a page input.
  const envName = answers['envName'] || DEFAULT_ENV_NAME;
  const userFields = Array.isArray(fields.userFields) ? fields.userFields : BUILTIN_USER_FIELDS;
  const defaultsFields = Array.isArray(fields.defaultsFields) ? fields.defaultsFields : BUILTIN_DEFAULTS_FIELDS;

  // ── project config skeleton ──────────────────────────────────────────────
  const projectConfig = {
    name: answers['name'] || 'my-project',
    defaultEnvironment: envName,
    azure: {
      org: answers['azure.org'] || '',
      project: answers['azure.project'] || '',
      team: answers['azure.team'] || '',
      assignee: answers['azure.assignee'] || '',
    },
    kb: {
      baseUrl: answers['kb.baseUrl'] || '',
      project: answers['kb.project'] || '',
    },
    login: { mode: answers['login.mode'] || 'session' },
    // The EFFECTIVE field schema is always written — explicit round-trip, no
    // hidden divergence between "absent" and "default" (design #4).
    userFields: userFields.map(f => ({ ...f })),
    defaultsFields: defaultsFields.map(f => ({ ...f })),
  };

  // ── environment config skeleton ──────────────────────────────────────────
  // defaults iterates the descriptors (no hardcoded otp/password): a value
  // sets the key, the descriptor's default fills an empty one, a secret
  // descriptor stores the env-var NAME as { envSecret } (invariant #5).
  const defaults = {};
  for (const f of defaultsFields) {
    if (f.secret) {
      const n = answers[`defaults.${f.key}EnvVar`];
      if (n) defaults[f.key] = { envSecret: String(n) };
      continue;
    }
    const raw = answers[`defaults.${f.key}`];
    const v = (raw !== undefined && raw !== null && raw !== '') ? raw : f.default;
    if (v !== undefined && v !== null && v !== '') defaults[f.key] = v;
  }
  const envConfig = {
    portalUrl: answers['portalUrl'] || 'https://example.com',
    defaults,
    users: buildUsers(answers, userFields),
  };

  // DB block (only if server is provided)
  if (answers['db.server']) {
    envConfig.db = {
      server: answers['db.server'],
      port: Number(answers['db.port']) || 1433,
      name: answers['db.name'] || '',
      user: answers['db.user'] || '',
      password: { envSecret: answers['db.passwordEnvVar'] || 'SQLCMDPASSWORD' },
    };
  }

  // API block (only if baseUrl is provided)
  if (answers['api.baseUrl']) {
    envConfig.api = {
      baseUrl: answers['api.baseUrl'],
      token: { envSecret: answers['api.tokenEnvVar'] || 'API_TOKEN' },
    };
  }

  // Figma block (only if a file key is provided) — ui-check: design baselines
  if (answers['figma.fileKey']) {
    projectConfig.figma = {
      fileKey: answers['figma.fileKey'],
      token: { envSecret: answers['figma.tokenEnvVar'] || 'FIGMA_TOKEN' },
    };
  }

  // Strip empty azure block
  if (!projectConfig.azure.org && !projectConfig.azure.project &&
      !projectConfig.azure.team && !projectConfig.azure.assignee) {
    delete projectConfig.azure;
  }

  // Strip empty kb block
  if (!projectConfig.kb.baseUrl && !projectConfig.kb.project) {
    delete projectConfig.kb;
  }

  return { projectConfig, envConfig, envName };
}

/**
 * Build the users object from answers.
 * Answers carry users as:
 *   users[0].handle, users[0].<fieldKey>, ...
 *   users[1].handle, ...
 * Schema-driven (design #4): the entry carries exactly the effective field
 * set's keys — a secret field's value is an env-var NAME, stored as
 * { envSecret } (the actual value goes to .env, never here).
 */
function buildUsers(answers, userFields = BUILTIN_USER_FIELDS) {
  const users = {};
  const rawUsers = answers['users'];

  if (Array.isArray(rawUsers) && rawUsers.length > 0) {
    for (const u of rawUsers) {
      if (!u.handle) continue;
      const entry = {};
      for (const f of userFields) {
        const v = u[f.key];
        if (!v) continue;
        entry[f.key] = f.secret ? { envSecret: String(v) } : v;
      }
      users[u.handle] = entry;
    }
  }

  // Fallback defaults if no users provided
  if (Object.keys(users).length === 0) {
    users.valid_user   = { phone: '', role: 'customer' };
    users.expired_user = { phone: '', notes: 'for negative login scenarios' };
  }

  return users;
}

/**
 * Validate answers against schema steps.
 * Returns array of error strings (empty = valid).
 * @param {object} answers
 * @param {object[]} steps  - from schema.json
 * @returns {string[]}
 */
function validate(answers, steps) {
  const errors = [];
  for (const step of steps) {
    if (!step.fields) continue;
    for (const field of step.fields) {
      if (field.required && !answers[field.key]) {
        errors.push(`"${field.label || field.key}" is required (step: ${step.id})`);
      }
      if (field.type === 'url' && answers[field.key]) {
        try { new URL(answers[field.key]); }
        catch { errors.push(`"${field.label || field.key}" must be a valid URL`); }
      }
      if (field.type === 'email' && answers[field.key]) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers[field.key])) {
          errors.push(`"${field.label || field.key}" must be a valid email`);
        }
      }
      if (field.pattern && answers[field.key] &&
          !new RegExp(field.pattern).test(String(answers[field.key]))) {
        errors.push(`"${field.label || field.key}" has an invalid format`);
      }
    }
  }
  return errors;
}

/* ── Text extraction ──────────────────────────────────────────────────────
 * Turn pasted/uploaded text (an old .env, a BRD paragraph, a handover note)
 * into schema-shaped answers. Deterministic and offline: it reads only what is
 * plainly stated and leaves everything else for the user to fill in.
 * Secrets are never extracted — passwords/tokens/PATs belong in .env, typed by
 * the user into the wizard's own secret fields.
 */

// Canonical .env variable names → wizard answer keys — shared with the migration
// engine (scripts/migrations/03-env-split.js): one mapping, no drift.
const { ENV_KEY_MAP } = require('../lib/env_key_map.js');

// Grouped lines: "DB: server=x, name=y" / "Azure Org: o, Project: p".
const GROUPS = [
  [/^\s*(?:db|database|قاعدة\s*البيانات)\b/i, {
    server: 'db.server', host: 'db.server', port: 'db.port',
    name: 'db.name', database: 'db.name', user: 'db.user', username: 'db.user',
  }],
  [/^\s*(?:api)\b/i, { baseurl: 'api.baseUrl', base_url: 'api.baseUrl', url: 'api.baseUrl', api: 'api.baseUrl' }],
  [/^\s*(?:azure|أزور)\b/i, {
    org: 'azure.org', organization: 'azure.org', 'azure org': 'azure.org',
    project: 'azure.project', team: 'azure.team', assignee: 'azure.assignee',
  }],
  [/^\s*(?:kb|knowledge\s*base)\b/i, { baseurl: 'kb.baseUrl', url: 'kb.baseUrl', project: 'kb.project' }],
];

// Standalone "label: value" lines.
const LABELS = [
  [/^(?:اسم\s*المشروع|المشروع|project\s*name)$/i, 'name'],
  [/^(?:رابط\s*التطبيق|الرابط|portal\s*url|app\s*url|target\s*url|website|site)$/i, 'portalUrl'],
  [/^(?:البيئة(?:\s*الافتراضية)?|environment|default\s*environment|env)$/i, 'envName'],
  [/^(?:otp|رمز\s*التحقق|كلمة\s*المرور\s*المؤقتة)$/i, 'defaults.otp'],
];

const stripQuotes = (s) => String(s).trim().replace(/^["']|["']$/g, '').trim();

/** Split "a=1, b: 2" into [key, value] pairs. */
function pairsIn(segment) {
  const out = [];
  for (const part of segment.split(/[,،;؛|]/)) {
    const m = part.match(/^\s*([^:=]{1,40}?)\s*[:=]\s*(.+?)\s*$/);
    if (m) out.push([m[1].trim().toLowerCase(), stripQuotes(m[2])]);
  }
  return out;
}

function extractFromText(text) {
  const out = {};
  const set = (key, val) => { if (key && val && out[key] === undefined) out[key] = val; };
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // .env style — KEY=value (canonical names only, so no guessing).
    const envMatch = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (envMatch && ENV_KEY_MAP[envMatch[1].toUpperCase()]) {
      set(ENV_KEY_MAP[envMatch[1].toUpperCase()], stripQuotes(envMatch[2]));
      continue;
    }

    // Grouped line — "DB: server=x, name=y".
    const group = GROUPS.find(([re]) => re.test(line));
    if (group) {
      const [, fieldMap] = group;
      // Drop the group token first, or it is read as the first pair's label
      // ("DB: server=x" → label "DB", value "server=x").
      const body = line.replace(/^\s*[^\s:=]+\s*:?\s*/, '');
      const pairs = pairsIn(body);
      let matched = false;
      for (const [k, v] of pairs) {
        const key = fieldMap[k] || fieldMap[k.replace(/\s+/g, '_')];
        if (key) { set(key, v); matched = true; }
      }
      // "API: https://…" — a bare URL after the group token.
      if (!matched) {
        const url = body.match(/https?:\/\/\S+/);
        if (url) set(fieldMap.url || fieldMap.baseurl, url[0]);
      }
      continue;
    }

    // Plain "label: value".
    const m = line.match(/^\s*([^:=]{1,40}?)\s*[:=]\s*(.+?)\s*$/);
    if (m) {
      const label = m[1].trim();
      const hit = LABELS.find(([re]) => re.test(label));
      if (hit) set(hit[1], stripQuotes(m[2]));
    }
  }

  const users = extractUsers(text);
  if (users.length) out.users = users;
  return out;
}

/** Users written as `handle (phone)` or `handle (email)` anywhere in the text. */
function extractUsers(text) {
  const users = [];
  const seen = new Set();
  const re = /\b([a-z][a-z0-9_]{2,30})\s*\(\s*([^)]{5,60}?)\s*\)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const handle = m[1];
    const detail = m[2].trim();
    if (seen.has(handle)) continue;
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(detail);
    const digits = detail.replace(/\D/g, '');
    if (!isEmail && digits.length < 6) continue;   // not a phone, not an email → not a user
    seen.add(handle);
    users.push(isEmail ? { handle, email: detail } : { handle, phone: detail });
  }
  return users;
}

const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

/**
 * Server-side validation of the built configs (defense-in-depth: the UI validates
 * per step, but /api/save must never trust the browser).
 * envName is also the target file name — reject anything that could escape
 * environments/ (path traversal).
 * Returns array of error strings (empty = valid).
 */
function validateConfigs(projectConfig, envConfig, envName) {
  const errors = [];
  if (!projectConfig || typeof projectConfig !== 'object') errors.push('projectConfig is required');
  else if (!String(projectConfig.name || '').trim()) errors.push('project name is required');
  errors.push(...validateProjectFieldSchema(projectConfig));
  return errors.concat(validateEnvConfig(envConfig, envName));
}

/**
 * Per-environment validation — one environment config against its target file
 * name. Split out of validateConfigs so the multi-environment save plan can run
 * it once per environment.
 */
function validateEnvConfig(envConfig, envName) {
  const errors = [];
  if (!ENV_NAME_RE.test(String(envName || ''))) {
    errors.push('envName must be lowercase letters/digits/-/_ (max 31 chars)');
  }
  if (!envConfig || typeof envConfig !== 'object') errors.push('envConfig is required');
  else {
    if (!isHttpUrl(envConfig.portalUrl)) errors.push('portalUrl must be a valid http(s) URL');
    if (envConfig.api && !isHttpUrl(envConfig.api.baseUrl)) errors.push('api.baseUrl must be a valid http(s) URL');
    // Schema declares minItems: 1 — an empty users object reaching disk would
    // wipe every saved user on a re-run.
    if (!envConfig.users || typeof envConfig.users !== 'object' ||
        Object.keys(envConfig.users).length === 0) {
      errors.push('at least one test user is required');
    }
    // Secret fields (invariant #5): a stored { envSecret } must name a valid
    // env var — garbage here becomes a broken .env lookup at run time.
    for (const [handle, entry] of Object.entries(envConfig.users || {})) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [k, v] of Object.entries(entry)) {
        if (v && typeof v === 'object' && 'envSecret' in v && !ENV_VAR_NAME_RE.test(String(v.envSecret || ''))) {
          errors.push(`users.${handle}.${k}: envSecret must be a valid env var name (letters/digits/_ only)`);
        }
      }
    }
    for (const [k, v] of Object.entries(envConfig.defaults || {})) {
      if (v && typeof v === 'object' && 'envSecret' in v && !ENV_VAR_NAME_RE.test(String(v.envSecret || ''))) {
        errors.push(`defaults.${k}: envSecret must be a valid env var name (letters/digits/_ only)`);
      }
    }
  }
  return errors;
}

/**
 * Plan a multi-environment batch save (wizard design #3): validate every
 * environment config plus the explicit, user-confirmed ops (renames/deletes),
 * and compute the resulting on-disk state. Pure function — disk state comes in
 * as data — so every rejection path of the wizard's first destructive
 * capability is testable without IO.
 *
 * Consent is data (invariant #11): every rename/delete op must carry
 * `confirmed: true`, set by the UI only after its confirm dialog. The server
 * never renames or deletes anything not explicitly listed here — pristine
 * sample reconciliation (announced, echoed) is the one design-#1 exception,
 * and it too is computed in this plan, never improvised at write time.
 *
 * @param {{projectConfig: object, environments: object, ops: {renames?: {from,to,confirmed}[], deletes?: {name,confirmed}[]}}} payload
 * @param {{envNames: string[], pristineNames: string[], unreadableNames?: string[]}} diskState  environments/*.json base names on disk; which are pristine samples; which would not parse
 * @returns {{errors: string[], reconcile: string[], finalEnvNames: string[]}}
 */
function planSave(payload, diskState) {
  const errors = [];
  const projectConfig = payload && payload.projectConfig;
  const environments = (payload && payload.environments) || {};
  const ops = (payload && payload.ops) || {};
  const renames = Array.isArray(ops.renames) ? ops.renames : [];
  const deletes = Array.isArray(ops.deletes) ? ops.deletes : [];
  const diskEnvs = ((diskState && diskState.envNames) || []).map(String);
  const pristine = ((diskState && diskState.pristineNames) || []).map(String);
  const unreadable = ((diskState && diskState.unreadableNames) || []).map(String);

  if (!projectConfig || typeof projectConfig !== 'object') errors.push('projectConfig is required');
  else if (!String(projectConfig.name || '').trim()) errors.push('project name is required');
  // Field-descriptor arrays (design #4), when the payload carries them —
  // defense-in-depth: the UI validates in its editor, the save re-checks.
  errors.push(...validateProjectFieldSchema(projectConfig));

  if (!environments || typeof environments !== 'object' || Array.isArray(environments)) {
    return { errors: errors.concat('environments must be an object keyed by environment name'), reconcile: [], finalEnvNames: [] };
  }

  // ── Per-environment validation, each error naming its file ──────────────
  const written = Object.keys(environments);
  for (const [name, cfg] of Object.entries(environments)) {
    for (const e of validateEnvConfig(cfg, name)) errors.push(`environments/${name}.json: ${e}`);
  }

  // ── An unreadable on-disk file is untouchable (design #3): the wizard
  // could not read it, so it must not write over it, rename it, rename onto
  // it, or delete it — the user fixes or removes it by hand.
  const touchesUnreadable = (n) => unreadable.includes(n);
  for (const n of written) {
    if (touchesUnreadable(n)) {
      errors.push(`environments/${n}.json exists but is not readable JSON — the wizard never overwrites what it could not read; fix or remove the file by hand`);
    }
  }
  for (const r of renames) {
    if (r && (touchesUnreadable(String(r.from || '')) || touchesUnreadable(String(r.to || '')))) {
      errors.push(`rename touches an unreadable environment file ("${r.from}" → "${r.to}") — fix or remove it by hand`);
    }
  }
  for (const d of deletes) {
    if (d && touchesUnreadable(String(d.name || ''))) {
      errors.push(`delete "${d.name}" refused — the file is not readable JSON, so its content was never shown; remove it by hand if you mean it`);
    }
  }

  // ── Ops: explicit, enumerated, consented — or refused ───────────────────
  const unconsented = [];
  for (const r of renames) if (!r || r.confirmed !== true) unconsented.push(`rename "${r && r.from}" → "${r && r.to}"`);
  for (const d of deletes) if (!d || d.confirmed !== true) unconsented.push(`delete "${d && d.name}"`);
  if (unconsented.length) {
    errors.push(`refused without explicit consent (confirmed: true): ${unconsented.join(', ')}`);
  }

  const renameFroms = [];
  const renameTos = [];
  for (const r of renames) {
    if (!r) continue;
    const from = String(r.from || '');
    const to = String(r.to || '');
    if (!ENV_NAME_RE.test(from) || !ENV_NAME_RE.test(to)) {
      errors.push(`rename names must be valid environment names: "${from}" → "${to}"`);
      continue;
    }
    if (from === to) { errors.push(`rename "${from}" → "${to}" is not a rename`); continue; }
    if (!diskEnvs.includes(from)) errors.push(`rename source "${from}" is not an environment file this project has`);
    if (written.includes(from)) errors.push(`rename source "${from}" collides with a file this save also writes`);
    if (renameFroms.includes(from)) errors.push(`"${from}" is renamed more than once`);
    if (renameTos.includes(to)) errors.push(`rename target "${to}" collides with another rename target`);
    renameFroms.push(from);
    renameTos.push(to);
  }

  const deleteNames = [];
  for (const d of deletes) {
    if (!d) continue;
    const name = String(d.name || '');
    if (!ENV_NAME_RE.test(name)) { errors.push(`delete name must be a valid environment name: "${name}"`); continue; }
    if (!diskEnvs.includes(name)) errors.push(`delete "${name}" is not an environment file this project has`);
    // Execution order is writes → renames → deletes: a delete aimed at a file
    // this save creates would destroy the fresh write. Refused outright.
    if (written.includes(name) || renameTos.includes(name)) errors.push(`delete "${name}" collides with a file this save creates`);
    if (renameFroms.includes(name)) errors.push(`delete "${name}" collides with a rename of the same file`);
    if (deleteNames.includes(name)) errors.push(`"${name}" is deleted more than once`);
    deleteNames.push(name);
  }

  // ── Chained/swapped renames: a target that equals ANOTHER rename's source
  // cannot execute correctly with in-order renames — depending on order, the
  // first rename silently overwrites the second's still-on-disk source
  // (fs.renameSync replaces an existing destination), destroying its data
  // behind an ok response. Refused whole, whatever the order: rename in
  // separate saves instead.
  for (const to of renameTos) {
    if (renameFroms.includes(to)) {
      errors.push(`rename target "${to}" is another rename's source — chained or swapped renames cannot run in one save; save between renames`);
    }
  }

  // ── Save-time reconciliation (design #1, generalized): a structurally-
  // pristine leftover sample this save does not claim (write to, rename
  // from/to, or explicitly delete) is a scaffold artifact and is removed —
  // listed in the plan so the review step and the response can both name it.
  const reconcile = pristine.filter(n =>
    diskEnvs.includes(n) && !written.includes(n) &&
    !renameTos.includes(n) && !renameFroms.includes(n) && !deleteNames.includes(n)).sort();

  // ── Final-state arithmetic ───────────────────────────────────────────────
  const surviving = diskEnvs.filter(n =>
    !deleteNames.includes(n) && !renameFroms.includes(n) && !reconcile.includes(n));
  for (const to of renameTos) {
    // A target that collides with a file surviving this save would clobber an
    // environment the user never consented to touch — refused either way
    // (plain rename-onto or renamed-and-edited-onto).
    if (surviving.includes(to)) {
      errors.push(`rename target "${to}" collides with an existing environment file`);
    }
  }
  const finalEnvNames = [...new Set([...surviving, ...renameTos, ...written])].sort();

  if (finalEnvNames.length === 0) {
    errors.push('at least one environment must remain after this save');
  }

  const finalDefault = String((projectConfig && projectConfig.defaultEnvironment) || '');
  if (!finalDefault) {
    errors.push('projectConfig.defaultEnvironment is required');
  } else if (finalEnvNames.length && !finalEnvNames.includes(finalDefault)) {
    errors.push(`defaultEnvironment "${finalDefault}" would not name any environment file after this save`);
  }

  return { errors, reconcile, finalEnvNames };
}

/**
 * Build an environment file's users object from the wizard's user list,
 * merging each entry onto its on-disk base entry so hand-added properties the
 * wizard has no input for survive a save (invariant #11). Schema-driven
 * (design #4): the managed keys are the effective `userFields`; a secret
 * field's screen value is an env-var NAME stored as { envSecret }. `dropKeys`
 * are the ONE exception to unknown-prop preservation: keys the user
 * explicitly removed or renamed away this session (consented ops) are deleted
 * from the base before the merge. The managed fields mirror the screen
 * exactly: a value sets the key, an empty field unsets it.
 * ui.html's buildUsersObj mirrors this logic (browser copy — keep in sync).
 */
function buildEnvUsers(list, baseUsers, userFields = BUILTIN_USER_FIELDS, dropKeys = []) {
  const base = baseUsers || {};
  const users = {};
  for (const u of (list || [])) {
    if (!u || !u.handle) continue;
    const entry = Object.assign({}, base[u.handle]);
    for (const k of dropKeys) delete entry[k];
    for (const f of userFields) {
      const v = u[f.key];
      if (f.secret) {
        const n = String(v || '').trim();
        if (n) entry[f.key] = { envSecret: n }; else delete entry[f.key];
      } else if (v) {
        entry[f.key] = v;
      } else {
        delete entry[f.key];
      }
    }
    users[u.handle] = entry;
  }
  return users;
}

/**
 * Merge AI-extracted partial answers into the existing answers object.
 * Extracted values only fill keys that are currently empty; users MERGE by
 * handle — an import must never clobber users the user typed or that were
 * loaded from an existing config (saving afterwards would erase them on disk).
 * @param {object} answers   - current wizard answers
 * @param {object} extracted - AI-extracted partial data
 * @returns {object}         - merged answers
 */
function mergeExtracted(answers, extracted) {
  const merged = { ...answers };
  for (const [key, value] of Object.entries(flattenObject(extracted))) {
    if (key === 'users') continue;   // arrays are handled below, never as scalars
    if (value !== null && value !== undefined && value !== '' && !merged[key]) {
      merged[key] = value;
    }
  }
  if (Array.isArray(extracted.users) && extracted.users.length > 0) {
    merged.users = (Array.isArray(merged.users) && merged.users.length > 0)
      ? mergeUsers(merged.users, extracted.users)
      : extracted.users.map(u => ({ ...u }));
  }
  return merged;
}

/**
 * Merge imported users into an existing list, keyed by handle.
 * Existing entries win; an import only fills their empty fields. New handles
 * are appended. The existing list is not mutated.
 */
function mergeUsers(existing, imported) {
  const out = existing.map(u => ({ ...u }));
  for (const ext of (imported || [])) {
    if (!ext || !ext.handle) continue;
    const hit = out.find(u => u.handle === ext.handle);
    if (hit) {
      for (const [k, v] of Object.entries(ext)) {
        if (v && !hit[k]) hit[k] = v;
      }
    } else {
      out.push({ ...ext });
    }
  }
  return out;
}

/**
 * Flatten a nested object into dot-notation keys.
 * e.g. { azure: { org: "x" } } → { "azure.org": "x" }
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj || {})) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

module.exports = {
  DEFAULT_ENV_NAME,
  BUILTIN_USER_FIELDS, BUILTIN_DEFAULTS_FIELDS,
  validateFieldDescriptors, validateProjectFieldSchema,
  buildConfigs, validate, validateConfigs, validateEnvConfig, planSave, buildEnvUsers, isHttpUrl,
  extractFromText, extractUsers, mergeExtracted, mergeUsers, flattenObject,
};
