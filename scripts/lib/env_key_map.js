'use strict';
// Canonical legacy .env variable names → dot-notation config keys ("answer keys").
//
// The ONE mapping shared by the setup wizard's text import (scripts/wizard/engine.js)
// and the migration engine's env-split (scripts/migrations/03-env-split.js) — one map,
// no drift. Dot-notation targets resolve into the two config files:
//   name, azure.*, kb.*            → config/project.json
//   portalUrl, defaults.*, db.*, api.* → environments/<env>.json
//
// Secret variables (AZURE_PAT, SQLCMDPASSWORD, API_TOKEN, KB_ASK_API_KEY, …) are
// deliberately NOT listed: anything absent from this map is never carried into a JSON
// file, never removed from .env, and never printed.
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

module.exports = { ENV_KEY_MAP };
