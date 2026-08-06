// AgenTeX Wizard Engine
// Shared logic: maps wizard answers → config/project.json + environments/<env>.json
// Used by: server.js (local plugin) and future web app (same logic, different save action)

'use strict';

/**
 * Given a flat answers object (keyed by field.key), build the two output config objects.
 * @param {object} answers  - e.g. { "name": "my-app", "azure.org": "myorg", "db.server": "..." }
 * @param {object[]} steps  - from schema.json
 * @returns {{ projectConfig: object, envConfig: object, envName: string }}
 */
function buildConfigs(answers, steps) {
  const envName = answers['defaultEnvironment'] || 'qa';

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
  };

  // ── environment config skeleton ──────────────────────────────────────────
  const envConfig = {
    portalUrl: answers['portalUrl'] || 'https://example.com',
    defaults: {
      otp: answers['defaults.otp'] || '0000',
      password: answers['defaults.password'] || 'Test@1234',
    },
    users: buildUsers(answers),
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
 *   users[0].handle, users[0].phone, users[0].role, users[0].email, users[0].notes
 *   users[1].handle, ...
 */
function buildUsers(answers) {
  const users = {};
  const rawUsers = answers['users'];

  if (Array.isArray(rawUsers) && rawUsers.length > 0) {
    for (const u of rawUsers) {
      if (!u.handle) continue;
      const entry = {};
      if (u.phone)  entry.phone  = u.phone;
      if (u.email)  entry.email  = u.email;
      if (u.role)   entry.role   = u.role;
      if (u.notes)  entry.notes  = u.notes;
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

// Canonical .env variable names → wizard answer keys.
const ENV_KEY_MAP = {
  QA_TARGET_URL: 'portalUrl', QA_URL: 'portalUrl', PORTAL_URL: 'portalUrl',
  APP_URL: 'portalUrl', TARGET_URL: 'portalUrl', UAT_URL: 'portalUrl',
  PROJECT_NAME: 'name',
  AZURE_URL: 'azure.org', AZURE_ORG: 'azure.org', AZURE_DEVOPS_ORG: 'azure.org',
  AZURE_PROJECT: 'azure.project', AZURE_TEAM: 'azure.team', AZURE_ASSIGNEE: 'azure.assignee',
  DB_SERVER: 'db.server', DB_HOST: 'db.server', DB_PORT: 'db.port',
  DB_NAME: 'db.name', DB_DATABASE: 'db.name', DB_USER: 'db.user', DB_USERNAME: 'db.user',
  API_BASE_URL: 'api.baseUrl', API_URL: 'api.baseUrl',
  KB_ASK_BASE_URL: 'kb.baseUrl', KB_PROJECT: 'kb.project',
  OTP: 'defaults.otp', DEFAULT_OTP: 'defaults.otp', CAPTCHA: 'defaults.captcha',
};

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
  [/^(?:البيئة(?:\s*الافتراضية)?|environment|default\s*environment|env)$/i, 'defaultEnvironment'],
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
  if (!ENV_NAME_RE.test(String(envName || ''))) {
    errors.push('envName must be lowercase letters/digits/-/_ (max 31 chars)');
  }
  if (!envConfig || typeof envConfig !== 'object') errors.push('envConfig is required');
  else {
    if (!isHttpUrl(envConfig.portalUrl)) errors.push('portalUrl must be a valid http(s) URL');
    if (envConfig.api && !isHttpUrl(envConfig.api.baseUrl)) errors.push('api.baseUrl must be a valid http(s) URL');
  }
  return errors;
}

/**
 * Merge AI-extracted partial answers into the existing answers object.
 * Extracted values only fill keys that are currently empty.
 * @param {object} answers   - current wizard answers
 * @param {object} extracted - AI-extracted partial data
 * @returns {object}         - merged answers
 */
function mergeExtracted(answers, extracted) {
  const merged = { ...answers };
  for (const [key, value] of Object.entries(flattenObject(extracted))) {
    if (value !== null && value !== undefined && value !== '' && !merged[key]) {
      merged[key] = value;
    }
  }
  // Merge users array specially
  if (Array.isArray(extracted.users) && (!merged.users || merged.users.length === 0)) {
    merged.users = extracted.users;
  }
  return merged;
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
  buildConfigs, validate, validateConfigs, isHttpUrl,
  extractFromText, extractUsers, mergeExtracted, flattenObject,
};
