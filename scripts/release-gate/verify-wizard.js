'use strict';
// Release-gate wizard-placement verifier (design: release-e2e-gate).
//
// After the wizard's /api/done: asserts every wizard answer landed in its
// DOCUMENTED home — project answers in config/project.json, per-environment
// answers in environments/<envName>.json, every envKey secret ONLY in .env
// (and absent from both JSON files). The mapping is read from the wizard's own
// schema (scripts/wizard/schema.json — read-only here), so this verifier can
// never drift from what the wizard claims to do.
//
// Usage: node verify-wizard.js <throwaway-dir> --answers <answers.json> [--schema <schema.json>]
//   answers.json: the flat answers the persona typed, keyed by field key
//   (plus an optional `users` array for the dynamic-list step).
// Output: one JSON line {ok, checked, findings}. Findings NEVER contain a
// secret value — they name the answer key and env-var name only (invariant 5).
// Exit codes: 0 clean · 1 findings · 2 usage/config error.
const fs = require('node:fs');
const path = require('node:path');

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function envHasLine(envText, name, value) {
  const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(.+)$', 'm');
  const m = envText.match(re);
  return !!m && m[1].trim().replace(/^["']|["']$/g, '') === String(value);
}

function verifyWizard({ dir, answersFile, schemaPath } = {}) {
  if (!dir) throw usageError('a throwaway project dir is required');
  const schema = readJson(schemaPath || path.resolve(__dirname, '..', 'wizard', 'schema.json'));
  if (!schema) throw usageError('wizard schema not found/parsable');
  const answers = readJson(answersFile);
  if (!answers) throw usageError(`answers file not found/parsable: ${answersFile}`);

  const findings = [];
  let checked = 0;
  const envName = answers.envName || 'qc';

  const projectFile = path.join(dir, 'config', 'project.json');
  const envFile = path.join(dir, 'environments', `${envName}.json`);
  const project = readJson(projectFile);
  const environment = readJson(envFile);
  let envText = '';
  try { envText = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { /* checked below */ }

  if (!project) findings.push('config/project.json is missing or unparsable');
  if (!environment) findings.push(`environments/${envName}.json is missing or unparsable`);

  // Raw text of every JSON config file — the surface a secret must NOT be on.
  const jsonSurfaces = [];
  if (fs.existsSync(projectFile)) jsonSurfaces.push(['config/project.json', fs.readFileSync(projectFile, 'utf8')]);
  const envDir = path.join(dir, 'environments');
  if (fs.existsSync(envDir)) {
    for (const f of fs.readdirSync(envDir).filter((f) => f.endsWith('.json'))) {
      jsonSurfaces.push([`environments/${f}`, fs.readFileSync(path.join(envDir, f), 'utf8')]);
    }
  }

  // Index the schema: field key → {field, step}; envKeyFrom links: the *EnvVar
  // field key → the secret field whose env-var NAME it carries.
  const fieldIndex = new Map();
  const envVarNameLinks = new Map();
  for (const step of schema.steps || []) {
    for (const field of step.fields || []) {
      fieldIndex.set(field.key, { field, step });
      if (field.secret && field.envKeyFrom) envVarNameLinks.set(field.envKeyFrom, { field, step });
    }
  }

  const targetOf = (step) => (step.target === 'config/project.json'
    ? { obj: project, label: 'config/project.json' }
    : { obj: environment, label: `environments/${envName}.json` });

  for (const [key, value] of Object.entries(answers)) {
    if (key === 'users') continue;
    if (value === undefined || value === null || value === '') continue;

    if (key === 'envName') {
      checked++;
      if (!fs.existsSync(envFile)) findings.push(`envName: environments/${envName}.json was not written`);
      continue;
    }

    const secretTarget = envVarNameLinks.get(key);
    if (secretTarget) {
      // An env-var NAME field: it must land as { envSecret: NAME } beside its secret.
      checked++;
      const { obj, label } = targetOf(secretTarget.step);
      const stored = obj && getPath(obj, secretTarget.field.key);
      if (!stored || stored.envSecret !== String(value)) {
        findings.push(`${key}: expected ${label} → ${secretTarget.field.key} to be { "envSecret": "${value}" }`);
      }
      continue;
    }

    const hit = fieldIndex.get(key);
    if (hit && hit.field.secret) {
      // A secret VALUE: only ever in .env, under its documented env-var name.
      checked++;
      const envVarName = (hit.field.envKeyFrom ? answers[hit.field.envKeyFrom] : null) || hit.field.envKey;
      if (!envHasLine(envText, envVarName, value)) {
        findings.push(`${key}: secret not found in .env under ${envVarName} (value not shown)`);
      }
      for (const [label, text] of jsonSurfaces) {
        if (text.includes(String(value))) {
          findings.push(`${key}: secret value leaked into ${label} (must live only in .env; value not shown)`);
        }
      }
      continue;
    }

    if (hit) {
      checked++;
      const { obj, label } = targetOf(hit.step);
      const stored = obj && getPath(obj, key);
      if (stored === undefined) findings.push(`${key}: not found in ${label}`);
      else if (String(stored) !== String(value)) findings.push(`${key}: ${label} holds ${JSON.stringify(stored)}, expected ${JSON.stringify(value)}`);
      continue;
    }

    // Not a schema field — the defaults section is descriptor-driven (defaults.*).
    if (key.startsWith('defaults.')) {
      checked++;
      const isEnvVarName = key.endsWith('EnvVar');
      const targetKey = isEnvVarName ? key.slice(0, -'EnvVar'.length) : key;
      const stored = environment && getPath(environment, targetKey);
      if (isEnvVarName ? !(stored && stored.envSecret === String(value)) : String(stored) !== String(value)) {
        findings.push(`${key}: not placed at environments/${envName}.json → ${targetKey}`);
      }
      continue;
    }

    findings.push(`${key}: unknown answer key — not in the wizard schema and not a defaults.* key`);
  }

  // Dynamic-list step: every declared test user must exist with its values.
  for (const u of Array.isArray(answers.users) ? answers.users : []) {
    if (!u || !u.handle) continue;
    checked++;
    const entry = environment && getPath(environment, `users.${u.handle}`);
    if (!entry) { findings.push(`users: "${u.handle}" missing from environments/${envName}.json users`); continue; }
    for (const [k, v] of Object.entries(u)) {
      if (k === 'handle' || v === undefined || v === null || v === '') continue;
      if (String(entry[k] && entry[k].envSecret ? entry[k].envSecret : entry[k]) !== String(v)) {
        findings.push(`users: "${u.handle}".${k} differs from the answer`);
      }
    }
  }

  return { ok: findings.length === 0, checked, findings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const dir = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null;
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw usageError(`bad flag pair near ${argv[i]}`);
      flags[argv[i].slice(2)] = argv[i + 1];
    }
    const result = verifyWizard({ dir, answersFile: flags.answers, schemaPath: flags.schema });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = { verifyWizard };
