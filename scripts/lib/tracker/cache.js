'use strict';
// Field/picklist metadata cache — built once per consumer project from the
// tracker on first use, then reused across filings.
//
// File: <project>/.agentex/cache/tracker-fields-<provider>.json — one file per
// provider (Phase 3 adds tracker-fields-jira.json additively, no rewrite).
// Gitignored by default via the scaffold's GITIGNORE_ENTRIES; the documented
// one-line opt-in to commit is appending `!.agentex/cache/` to .gitignore.
//
// Building is READS ONLY (adapter.listFields), never a board write, so it runs
// freely pre-gate. The cache rebuilds itself when the file is missing/corrupt,
// its schemaVersion is not ours, or its org/project no longer match the
// adapter's config; `refresh: true` (the scripts' --refresh-fields flag) forces
// a rebuild on demand. A requested work-item type missing from a valid cache is
// fetched and merged without discarding the rest.
//
// Validation (validateValues) checks user-, spec-, and config-supplied values
// against each field's allowedValues — the PROJECT'S real values, replacing the
// old hardcoded severity/priority tables — and flags fields that don't exist on
// the target type instead of emitting them blind. When the server rejects a
// value despite the cache, consumers call liveFieldMap() for the real current
// options (no error-prose parsing, no cache write, no auto-retry) and surface
// them with cacheStale: true; the refresh stays the user's call.
// List-picklist semantics credit: plugin PR #16's workItemTypeFields (harvested).
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function cacheFile(cwd, provider) {
  return path.join(cwd, '.agentex', 'cache', `tracker-fields-${provider}.json`);
}

// ADO field descriptors -> { referenceName: { allowedValues?, required } }.
function toFieldMap(fieldList) {
  const map = {};
  for (const f of fieldList || []) {
    if (!f || !f.referenceName) continue;
    map[f.referenceName] = {
      ...(Array.isArray(f.allowedValues) && f.allowedValues.length ? { allowedValues: f.allowedValues } : {}),
      required: Boolean(f.alwaysRequired),
    };
  }
  return map;
}

function readIfValid(file, adapter) {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { cache: null, reason: fs.existsSync(file) ? 'corrupt' : 'missing' }; }
  if (disk.schemaVersion !== SCHEMA_VERSION) return { cache: null, reason: 'schemaVersion-mismatch' };
  if (disk.provider !== adapter.name) return { cache: null, reason: 'provider-mismatch' };
  if (disk.org !== adapter.config.base || disk.project !== adapter.config.project) {
    return { cache: null, reason: 'org/project-mismatch' };
  }
  if (!disk.types || typeof disk.types !== 'object') return { cache: null, reason: 'corrupt' };
  return { cache: disk, reason: null };
}

// Load the cache, building (or completing) it when needed.
// Returns { cache, rebuilt, reason, file } — rebuilt=true means the tracker was asked.
async function ensure(cwd, adapter, { types = ['Bug'], refresh = false } = {}) {
  const file = cacheFile(cwd, adapter.name);
  let cache = null; let reason = null;
  if (!refresh) ({ cache, reason } = readIfValid(file, adapter));
  else reason = 'refresh-requested';

  let rebuilt = false;
  if (!cache) {
    cache = {
      schemaVersion: SCHEMA_VERSION,
      provider: adapter.name,
      org: adapter.config.base,
      project: adapter.config.project,
      apiVersion: adapter.config.apiVersion,
      builtAt: new Date().toISOString(),
      types: {},
    };
    for (const type of types) {
      cache.types[type] = { fields: toFieldMap(await adapter.listFields(type)) };
    }
    rebuilt = true;
  } else {
    // Valid cache, but a consumer may need a type it hasn't seen yet — fetch
    // just that type and merge (still reads only).
    for (const type of types) {
      if (!cache.types[type]) {
        cache.types[type] = { fields: toFieldMap(await adapter.listFields(type)) };
        cache.builtAt = new Date().toISOString();
        rebuilt = true;
        reason = reason || 'type-added';
      }
    }
  }
  if (rebuilt) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  }
  return { cache, rebuilt, reason, file };
}

// Check supplied values against the cached type metadata.
// entries: [{field, value}] -> [{field, value, ok, reason?, allowedValues?}]
//   - 'field-not-on-type' : the project's type has no such field (don't emit blind)
//   - 'invalid-value'     : the field has allowedValues and this isn't one of them
// Values compare as trimmed strings so numeric picklists ("1".."4") match numbers.
function validateValues(cache, type, entries) {
  const fields = (cache.types[type] && cache.types[type].fields) || {};
  return entries.map(({ field, value }) => {
    const meta = fields[field];
    if (!meta) return { field, value, ok: false, reason: 'field-not-on-type' };
    if (meta.allowedValues) {
      const wanted = String(value).trim();
      if (!meta.allowedValues.some((v) => String(v).trim() === wanted)) {
        return { field, value, ok: false, reason: 'invalid-value', allowedValues: meta.allowedValues };
      }
    }
    return { field, value, ok: true };
  });
}

// Live re-read of a type's field map, bypassing the file entirely — the
// stale-cache path. Never writes; comparing it to the cache is the caller's job.
async function liveFieldMap(adapter, type) {
  return toFieldMap(await adapter.listFields(type));
}

module.exports = { SCHEMA_VERSION, cacheFile, toFieldMap, ensure, validateValues, liveFieldMap };
