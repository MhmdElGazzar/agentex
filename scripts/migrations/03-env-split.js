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
//     interruption between the two steps converges on the next run (after the user
//     commits the partial state — the clean-tree guard is absolute): detect still
//     sees the legacy keys, the JSON fields are now set, the rewrite completes;
//   - the .env rewrite drops ONLY known, successfully-carried non-secret keys —
//     secret keys and every unrecognized key survive byte-identical;
//   - aliases that disagree are never resolved by guessing: when two legacy names
//     for the same field hold different values and the JSON field is unset, the
//     group is left untouched (nothing written, nothing removed from .env) and
//     raised as a [manual] item — the stamp is withheld until the user picks.
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
    //
    // Grouped by target first, because several legacy names alias to one field:
    // QA_TARGET_URL / QA_URL / PORTAL_URL / APP_URL / TARGET_URL / UAT_URL are all
    // portalUrl, DB_NAME and DB_DATABASE are both db.name, and so on. Taken one
    // entry at a time, two aliases holding DIFFERENT values raced: whichever line
    // came first in the file was carried, the second was reported as "JSON wins
    // over .env <KEY>" — about a JSON value that had just been written from the
    // .env in this same run, not one the project already had — and its .env line
    // was then deleted. That silently discarded a value the tester had set, on a
    // rule (file order) they had no way to see. Such a group is now left entirely
    // alone and raised as a [manual] item, which also withholds the stamp until
    // the user picks a winner.
    const carried = { project: [], env: [] };
    const removable = new Set();
    const groups = new Map(); // answer key → its .env entries, in file order
    for (const e of entries) {
      const target = ENV_KEY_MAP[e.key];
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(e);
    }
    for (const [answerKey, group] of groups) {
      const [home, keys] = TARGETS[answerKey];
      const { json, rel, template } = files[home];
      ensureBlock(json, template, keys);
      const cur = getPath(json, keys);
      const dotted = keys.join('.');
      const unset = isUnset(cur, getPath(template, keys));
      const names = group.map(e => e.key);
      // Distinct after the same normalization the carry would apply.
      const distinct = new Set(group.map(e => String(coerce(answerKey, e.value))));
      if (unset && distinct.size > 1) {
        ctx.report.manual(
          `${names.join(' and ')} in .env are different names for ${dotted} but hold ` +
          `${distinct.size} different values, and ${rel} has none — only you can say which is ` +
          `current. Set ${dotted} in ${rel} yourself, or delete the .env line(s) you do not ` +
          `want, then re-run /update-agentex. Nothing was written for ${dotted} and none of ` +
          `those .env lines were removed.`
        );
        continue;
      }
      const wanted = coerce(answerKey, group[0].value);
      if (unset) {
        setPath(json, keys, wanted);
        if (!carried[home].includes(dotted)) carried[home].push(dotted);
      } else if (distinct.size === 1 && String(cur) === String(wanted)) {
        ctx.report.ok(`kept existing ${dotted} in ${rel} — .env ${names.join(', ')} already carried`);
      } else {
        ctx.report.ok(`kept existing ${dotted} in ${rel} — JSON wins over .env ${names.join(', ')}`);
      }
      for (const key of names) removable.add(key);
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
