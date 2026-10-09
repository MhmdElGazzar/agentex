'use strict';
// Project-wide Bug cache for duplicate review — a local mirror of the project's recent
// Bugs, so a filing ranks its defect against Bugs under OTHER stories too, without
// reading every one of them on every filing.
//
// File: <project>/.agentex/cache/tracker-bugs-ado.json — gitignored with the rest of
// .agentex/cache/ (it is a copy of the board, rewritten on every sync; committing it
// would only spread stale copies). Azure stays the source of truth: every sync()
// re-reads, in one WIQL query + one batch read, the Bugs changed since the last sync,
// so a Bug someone filed a minute ago is in the candidate set. A sync that cannot
// complete throws — the caller fails the duplicate check closed and never ranks
// against a stale mirror.
//
// Scope: Bugs in the configured project (under azure.areaPath when set) changed in the
// last azure.bugCacheDays days (default 365; 0 turns the cache off). The delta query is
// day-precise (WIQL's default), so it re-reads from the day before the last sync — a
// superset, never a gap. A full rebuild runs when the file is missing, corrupt, or
// belongs to another org/project/scope, or when the last full build is older than
// FULL_REBUILD_DAYS (that is what drops Bugs deleted or moved out of scope).
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_DAYS = 365;
const FULL_REBUILD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIELDS = Object.freeze({
  id: 'System.Id',
  type: 'System.WorkItemType',
  title: 'System.Title',
  state: 'System.State',
  parent: 'System.Parent',
  changed: 'System.ChangedDate',
  reproSteps: 'Microsoft.VSTS.TCM.ReproSteps',
});

function cacheFile(cwd) {
  return path.join(cwd, '.agentex', 'cache', 'tracker-bugs-ado.json');
}

// azure.bugCacheDays: a non-negative integer; absent means DEFAULT_WINDOW_DAYS.
function windowDays(cwd) {
  const az = pc.loadProjectConfig(cwd).azure || {};
  if (az.bugCacheDays === undefined || az.bugCacheDays === null) return DEFAULT_WINDOW_DAYS;
  const n = az.bugCacheDays;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`config/project.json: azure.bugCacheDays must be a non-negative whole number of days (got ${JSON.stringify(n)}); 0 turns the project-wide Bug cache off`);
  }
  return n;
}

const wiqlEsc = (s) => String(s).replace(/'/g, "''");
const day = (date) => date.toISOString().slice(0, 10);

function scopeWiql(project, areaPath, sinceDay) {
  return 'SELECT [System.Id] FROM WorkItems' +
    ` WHERE [System.TeamProject] = '${wiqlEsc(project)}'` +
    " AND [System.WorkItemType] = 'Bug'" +
    ` AND [System.ChangedDate] >= '${sinceDay}'` +
    (areaPath ? ` AND [System.AreaPath] UNDER '${wiqlEsc(areaPath)}'` : '') +
    ' ORDER BY [System.Id]';
}

function scopeOf(adapter, days) {
  return {
    provider: adapter.name,
    org: adapter.config.base,
    project: adapter.config.project,
    areaPath: adapter.config.areaPath || null,
    windowDays: days,
  };
}

function sameScope(a, b) {
  return ['provider', 'org', 'project', 'areaPath', 'windowDays'].every((k) => a[k] === b[k]);
}

function readIfValid(cwd, scope, now) {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(cacheFile(cwd), 'utf8')); }
  catch { return null; }
  if (!disk || disk.schemaVersion !== SCHEMA_VERSION || !disk.scope || !sameScope(disk.scope, scope)) return null;
  if (!disk.bugs || typeof disk.bugs !== 'object' || Array.isArray(disk.bugs)) return null;
  const synced = Date.parse(disk.syncedAt);
  const built = Date.parse(disk.fullBuiltAt);
  if (!Number.isFinite(synced) || !Number.isFinite(built)) return null;
  if (now.getTime() - built > FULL_REBUILD_DAYS * DAY_MS) return null;
  return disk;
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function idsFrom(res) {
  const rows = Array.isArray(res) ? res : (res && res.workItems) || [];
  return rows.map((row) => Number(row && row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

// Bring the mirror up to date and return its Bugs. `toEntry(workItem)` turns a batch
// item into the stored entry (the caller owns HTML stripping); the stored entry also
// carries parentId and changedDate. Returns { enabled:false } when the window is 0.
async function sync(cwd, adapter, { now = new Date(), toEntry, refresh = false } = {}) {
  const days = windowDays(cwd);
  if (days === 0) return { enabled: false, bugs: [] };
  if (typeof adapter.getWorkItems !== 'function' || typeof adapter.query !== 'function') {
    throw new Error('this tracker adapter cannot batch-read Bugs for the project-wide cache');
  }
  const scope = scopeOf(adapter, days);
  const previous = refresh ? null : readIfValid(cwd, scope, now);
  const windowStart = new Date(now.getTime() - days * DAY_MS);
  const since = previous
    ? new Date(Math.max(Date.parse(previous.syncedAt) - DAY_MS, windowStart.getTime()))
    : windowStart;

  const ids = idsFrom(await adapter.query(scopeWiql(scope.project, scope.areaPath, day(since))));
  const bugs = previous ? { ...previous.bugs } : {};
  if (ids.length) {
    const batch = await adapter.getWorkItems(ids, { fields: Object.values(FIELDS) });
    const missing = (batch && batch.missing) || [];
    if (missing.length) {
      throw new Error(`the Bug batch read omitted ${missing.map((id) => `#${id}`).join(', ')} — refusing a partial mirror`);
    }
    for (const wi of (batch && batch.items) || []) {
      const f = (wi && wi.fields) || {};
      const id = Number(wi && wi.id);
      if (f[FIELDS.type] !== 'Bug') { delete bugs[id]; continue; }
      bugs[id] = {
        ...(toEntry ? toEntry(wi) : { id, title: f[FIELDS.title] || null, state: f[FIELDS.state] || null }),
        id,
        parentId: Number.isInteger(f[FIELDS.parent]) ? f[FIELDS.parent] : null,
        changedDate: f[FIELDS.changed] || null,
      };
    }
  }
  // Keep the mirror inside its window: a Bug untouched for longer than the window
  // leaves it (the next full rebuild would drop it anyway).
  for (const [id, bug] of Object.entries(bugs)) {
    const changed = Date.parse(bug.changedDate);
    if (Number.isFinite(changed) && changed < windowStart.getTime()) delete bugs[id];
  }

  const value = {
    schemaVersion: SCHEMA_VERSION,
    scope,
    fullBuiltAt: previous ? previous.fullBuiltAt : now.toISOString(),
    syncedAt: now.toISOString(),
    bugs,
  };
  writeAtomic(cacheFile(cwd), value);
  return {
    enabled: true,
    mode: previous ? 'delta' : 'full',
    changed: ids.length,
    bugs: Object.values(bugs).sort((a, b) => a.id - b.id),
    syncedAt: value.syncedAt,
  };
}

module.exports = { sync, cacheFile, windowDays, scopeWiql, FIELDS, DEFAULT_WINDOW_DAYS, FULL_REBUILD_DAYS };
