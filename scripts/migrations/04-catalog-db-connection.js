'use strict';
// m04 catalog-db-connection — 0.6–0.10 catalogs held the DB connection as env-var
// NAMES in a "connection" block; its home is now the db block of the active
// environment file. This migration resolves those names to values (via the shared
// readEnvVar) and writes the environment db block; the catalog file itself is
// user-filled and is only FLAGGED, never rewritten — its legacy block keeps working
// through the documented fallback until the user removes it. (Design default for
// open question 3; Phase 2 may upgrade flag-to-rewrite.)
const fs = require('fs');
const path = require('path');
const { readEnvVar } = require('../lib/project_config.js');

function connectionCatalogs(projectRoot) {
  const dir = path.join(projectRoot, 'integration');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data && typeof data.connection === 'object' && data.connection !== null) {
        out.push({ file: `integration/${name}`, connection: data.connection });
      }
    } catch { /* unreadable catalog: not this migration's business */ }
  }
  return out;
}

function envHasDbBlock(ctx) {
  const envFile = path.join(ctx.projectRoot, 'environments', `${ctx.envName()}.json`);
  if (!fs.existsSync(envFile)) return false;
  try {
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    return env.db != null && typeof env.db === 'object';
  } catch { return false; }
}

module.exports = {
  id: 'catalog-db-connection',
  title: 'Carry legacy catalog "connection" env-var names into the environment db block',

  detect(ctx) {
    return connectionCatalogs(ctx.projectRoot).length > 0 && !envHasDbBlock(ctx);
  },

  apply(ctx) {
    const catalogs = connectionCatalogs(ctx.projectRoot);
    for (const c of catalogs) {
      ctx.report.flag(`${c.file}: legacy "connection" block left in place (user-filled catalogs are never rewritten) — the environment db block takes precedence; remove the block when convenient`);
    }

    // First catalog whose serverEnv resolves provides the connection.
    const pick = catalogs.find(c => c.connection.serverEnv && readEnvVar(ctx.projectRoot, c.connection.serverEnv));
    if (!pick) {
      const names = catalogs.map(c => c.connection.serverEnv || '(no serverEnv)').join(', ');
      ctx.report.flag(`no environment db block written — could not resolve a server value from ${names}; the legacy catalog fallback keeps working as documented`);
      return;
    }

    const conn = pick.connection;
    const val = name => (name ? readEnvVar(ctx.projectRoot, name) : null);
    const envName = ctx.envName();
    const envRel = `environments/${envName}.json`;
    const envFile = path.join(ctx.projectRoot, 'environments', `${envName}.json`);
    let createdNote = '';
    if (!fs.existsSync(envFile)) {
      ctx.saveJson(envFile, JSON.parse(JSON.stringify(ctx.templates.environment)));
      createdNote = `created ${envRel} from template; `;
    }
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    const port = val(conn.portEnv);
    env.db = {
      server: val(conn.serverEnv),
      port: port && /^\d+$/.test(port) ? Number(port) : 1433,
      name: val(conn.databaseEnv) || '',
      user: val(conn.userEnv) || '',
      // sqlcmd reads the password natively from SQLCMDPASSWORD — same secret home
      // the legacy fallback used; the value itself never moves or prints.
      password: { envSecret: 'SQLCMDPASSWORD' },
    };
    ctx.saveJson(envFile, env);
    ctx.report.migrated(this.id,
      `${createdNote}${pick.file} connection → ${envRel} db block (server, port, name, user; password stays { "envSecret": "SQLCMDPASSWORD" })`);
  },
};
