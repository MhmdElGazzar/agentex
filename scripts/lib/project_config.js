'use strict';
// AgenTeX project-config resolver — the ONE place that knows where project data lives.
//
// Three kinds of data, three homes (see docs/superpowers/specs/2026-08-06-project-config-files-design.md):
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

module.exports = {
  readEnvVar, loadProjectConfig, listEnvironments, loadEnvironment,
  resolveSecret, secretHint, resolveDbConnection, resolveApiTarget,
};
