'use strict';
// m03 env-split — the 0.2–0.10 keys-only .env convention becomes the three-home
// split: secrets stay in .env, project settings move to config/project.json,
// environment data moves to environments/<env>.json.
//
// Carry rules (binding, from the design):
//   - a .env value is carried only where the JSON field is UNSET — missing, empty,
//     or byte-equal to the shipped template sample; a filled JSON field wins
//     ([ok] kept existing) and the .env key is still considered carried (its value
//     lives on in JSON by precedence);
//   - loss-proofing: both JSON files are written BEFORE .env is rewritten, so an
//     interruption between the two steps converges on re-run (detect still sees the
//     legacy keys, the JSON fields are now set, the rewrite completes);
//   - the .env rewrite drops ONLY known, successfully-carried non-secret keys —
//     secret keys and every unrecognized key survive byte-identical.
const fs = require('fs');
const path = require('path');
const { ENV_KEY_MAP } = require('../lib/env_key_map.js');

// answer key (ENV_KEY_MAP target) → [home file, path inside that JSON]
const TARGETS = {
  name: ['project', ['name']],
  'azure.org': ['project', ['azure', 'org']],
  'azure.project': ['project', ['azure', 'project']],
  'azure.team': ['project', ['azure', 'team']],
  'azure.assignee': ['project', ['azure', 'assignee']],
  'kb.baseUrl': ['project', ['kb', 'baseUrl']],
  'kb.project': ['project', ['kb', 'project']],
  portalUrl: ['env', ['portalUrl']],
  'defaults.otp': ['env', ['defaults', 'otp']],
  'defaults.captcha': ['env', ['defaults', 'captcha']],
  'db.server': ['env', ['db', 'server']],
  'db.port': ['env', ['db', 'port']],
  'db.name': ['env', ['db', 'name']],
  'db.user': ['env', ['db', 'user']],
  'api.baseUrl': ['env', ['api', 'baseUrl']],
};

const stripQuotes = s => String(s).trim().replace(/^["']|["']$/g, '');

// [{ key, value }] for every KEY=value line (first occurrence wins), values unquoted.
function parseEnvEntries(envPath) {
  if (!fs.existsSync(envPath)) return [];
  const seen = new Set();
  const entries = [];
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ key: m[1], value: stripQuotes(m[2]) });
  }
  return entries;
}

// Known legacy non-secret keys that actually hold a value.
function legacyEntries(ctx) {
  return parseEnvEntries(path.join(ctx.projectRoot, '.env'))
    .filter(e => ENV_KEY_MAP[e.key] && e.value !== '');
}

function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}
function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
function isUnset(cur, tplVal) {
  return cur === undefined || cur === null || cur === '' ||
    (tplVal !== undefined && String(cur) === String(tplVal));
}
// db.port is a number everywhere else (template, wizard) — coerce when numeric.
function coerce(answerKey, value) {
  if (answerKey === 'db.port' && /^\d+$/.test(value)) return Number(value);
  return value;
}
const clone = o => JSON.parse(JSON.stringify(o));

// Ensure the block a target lives in exists, cloned from the shipped template
// subtree so a later comparison still treats untouched sample values as unset.
function ensureBlock(json, template, keys) {
  if (keys.length < 2) return;
  const head = keys[0];
  if (json[head] == null || typeof json[head] !== 'object') {
    const tpl = template[head];
    json[head] = tpl != null && typeof tpl === 'object' ? clone(tpl) : {};
  }
}

module.exports = {
  id: 'env-split',
  title: 'Split legacy keys-only .env into config/project.json + environments/<env>.json',

  detect(ctx) { return legacyEntries(ctx).length > 0; },

  apply(ctx) {
    const entries = legacyEntries(ctx);

    // 1. Ensure the JSON homes exist (created from the shipped templates).
    const projectFile = path.join(ctx.projectRoot, 'config', 'project.json');
    const createdFiles = [];
    if (!fs.existsSync(projectFile)) {
      ctx.saveJson(projectFile, clone(ctx.templates.project));
      createdFiles.push('config/project.json');
    }
    const envName = ctx.envName();
    const envRel = `environments/${envName}.json`;
    const envFile = path.join(ctx.projectRoot, 'environments', `${envName}.json`);
    if (!fs.existsSync(envFile)) {
      ctx.saveJson(envFile, clone(ctx.templates.environment));
      createdFiles.push(envRel);
    }

    const files = {
      project: { json: JSON.parse(fs.readFileSync(projectFile, 'utf8')), file: projectFile, rel: 'config/project.json', template: ctx.templates.project },
      env: { json: JSON.parse(fs.readFileSync(envFile, 'utf8')), file: envFile, rel: envRel, template: ctx.templates.environment },
    };

    // 2. Carry values into their new homes; JSON wins where already filled.
    const carried = { project: [], env: [] };
    const removable = new Set();
    for (const { key, value } of entries) {
      const [home, keys] = TARGETS[ENV_KEY_MAP[key]];
      const { json, rel, template } = files[home];
      ensureBlock(json, template, keys);
      const cur = getPath(json, keys);
      const wanted = coerce(ENV_KEY_MAP[key], value);
      const dotted = keys.join('.');
      if (isUnset(cur, getPath(template, keys))) {
        setPath(json, keys, wanted);
        if (!carried[home].includes(dotted)) carried[home].push(dotted);
        removable.add(key);
      } else if (String(cur) === String(wanted)) {
        ctx.report.ok(`kept existing ${dotted} in ${rel} — .env ${key} already carried`);
        removable.add(key);
      } else {
        ctx.report.ok(`kept existing ${dotted} in ${rel} — JSON wins over .env ${key}`);
        removable.add(key);
      }
    }

    // 3. Write BOTH JSON homes before touching .env (loss-proof ordering).
    ctx.saveJson(projectFile, files.project.json);
    ctx.saveJson(envFile, files.env.json);

    // 4. Rewrite .env: drop only the carried known keys; every other line —
    //    secrets, unrecognized keys, comments, blanks — stays byte-identical.
    const envPath = path.join(ctx.projectRoot, '.env');
    const removed = [];
    if (fs.existsSync(envPath) && removable.size) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      const kept = lines.filter(line => {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && removable.has(m[1])) { if (!removed.includes(m[1])) removed.push(m[1]); return false; }
        return true;
      });
      if (kept.length !== lines.length) fs.writeFileSync(envPath, kept.join('\n'), 'utf8');
    }

    // 5. Report — key names only, never values.
    const parts = [];
    if (createdFiles.length) parts.push(`created ${createdFiles.join(', ')} from template`);
    if (carried.env.length) parts.push(`.env → ${envRel} (${carried.env.join(', ')})`);
    if (carried.project.length) parts.push(`.env → config/project.json (${carried.project.join(', ')})`);
    parts.push(removed.length
      ? `removed ${removed.length} legacy key(s) from .env (${removed.join(', ')})`
      : 'no .env keys removed');
    ctx.report.migrated(this.id, parts.join('; '));
  },
};
