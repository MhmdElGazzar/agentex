'use strict';
// Jira Cloud REST v3 adapter — the second provider behind scripts/lib/tracker/.
//
// Transport: Node's built-in fetch, direct against the Jira platform REST API
// (v3) and the agile API (1.0) for board/sprint reads. There is NO CLI here and
// nothing in this lib can spawn a process (a test asserts it). Dialect: plain
// JSON (`dialect: 'json'`) — neutral {fields} pass straight through; the ONE
// conversion this dialect layer performs is wrapping plain strings handed to
// known rich-text fields (description, environment, comment bodies) in ADF via
// adf.js's toAdf — the exact analog of ADO's json-patch conversion.
//
// SECRETS (invariant 5): credentials resolve lazily, once, via the repo's
// project_config.readEnvVar — JIRA_EMAIL then JIRA_API_TOKEN (missing either is
// an exit-2 error naming BOTH). They enter memory once and reach ONLY the
// Authorization header (`Basic base64(email:token)`) — never a return value, an
// error, a log line, argv, or a dry-run descriptor (those print
// `authorization: <Basic ***, not printed>`). The email is credential material
// (half of the Basic pair) and is treated exactly like the token.
//
// CONFIG (invariants 7/10): site/project and the documented optional overrides
// come from the consumer's config/project.json `jira` block ONLY — no legacy
// .env fallback exists for non-secrets (no legacy JIRA_* scaffold history; the
// secrets-only convention forbids stuffing them into .env). Anything missing is
// an explicit error naming the keys — never a silent fallback.
//
// PINNED API FACTS (verified 2026-08, design §Constraints):
//   - the legacy `/rest/api/3/search` endpoint is REMOVED (410 Gone) — JQL
//     search goes through POST /rest/api/3/search/jql with an explicit fields
//     array and nextPageToken pagination (adapter-owned, hard cap 10 pages);
//   - the monolithic GET /issue/createmeta is deprecated — field metadata comes
//     from the per-issuetype routes
//     GET /issue/createmeta/{projectKey}/issuetypes[/{issueTypeId}].
//
// WRITES (invariant 4): every write method takes {execute}. execute:false sends
// NOTHING and returns the full request descriptor for the consolidated
// pre-approval screen. Nothing here retries or cleans up — ledger.js owns that
// discipline. deleteWorkItem is NOT offered: Jira Cloud's only issue delete is
// permanent (no Recycle Bin), and this plugin never performs permanent
// destroys (Q13 doctrine; capabilities.deleteWorkItem: false).
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', '..', 'project_config.js'));
const { TrackerError } = require('../errors.js');
const { toAdf } = require('../adf.js');

const CRED_ENV_NAMES = ['JIRA_EMAIL', 'JIRA_API_TOKEN'];
const DEFAULT_TIMEOUT_MS = 30_000;      // same bound as the ADO adapter
const REDACTED_AUTH = '<Basic ***, not printed>';
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10;            // documented hard cap; result carries truncated: true
const META_PAGE_SIZE = 100;
const META_MAX_PAGES = 10;
// Rich-text fields whose plain-string values the dialect layer wraps via toAdf.
const ADF_FIELDS = ['description', 'environment'];

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// CI guard (invariant 4 / ci-quality-gate): CI mode performs no tracker writes of
// any kind — the skill text says "don't offer"; this choke point guarantees
// "cannot happen" even under drift. Every write method calls it after its
// execute:false descriptor return, so dry-run plans and all reads are unaffected.
// Environment-class refusal: exitCode 2, never a product failure. Exact parity
// with the ADO adapter's guard.
function assertCiWritesAllowed(op) {
  if (process.env.AGENTEX_CI === '1') {
    const e = configError(`ci-mode: tracker writes are disabled in CI (AGENTEX_CI=1) — ${op} with execute:true refused; bug filing and every other tracker write stay interactive`);
    e.reason = 'ci-mode';
    throw e;
  }
}

// `jira.site` accepts both spellings, explicitly: a full URL is used as-is
// (trailing slashes stripped); a bare site name becomes
// https://<name>.atlassian.net — the documented mirror of ADO's org
// normalization. No other guessing.
function normalizeSite(site) {
  const trimmed = String(site).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}.atlassian.net`;
}

// JQL escaping is adapter-owned (design §5.4): inside a quoted JQL string,
// escape `\` then `"`; values are ALWAYS double-quoted (never bare), so
// reserved words and spaces are inert. One function, test-pinned.
function jqlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// PINNED: the current-sprint JQL. `sprint in openSprints()` may span several
// sprints on multi-board projects — listSprintStories reports that as a
// condition, never a silent pick. The story type is the caller's parameter,
// placed in the query text (never a post-read filter, never an adapter
// default). Escaping via jqlQuote. task-estimation's Jira strategy re-exports
// it (as currentSprintJql) for its pinned test.
function openSprintJql(projectKey, issueType) {
  return `project = ${jqlQuote(projectKey)} AND issuetype = ${jqlQuote(issueType)} AND sprint in openSprints() ORDER BY key`;
}

// Resolve the consumer's non-secret Jira settings (invariant 7). Missing
// site/project is an explicit exit-2 error naming the keys (invariant 10).
function resolveConfig(cwd) {
  const j = pc.loadProjectConfig(cwd).jira || {};
  const val = (k) => {
    const v = j[k];
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
  };
  const missing = [];
  if (!val('site')) missing.push('jira.site');
  if (!val('project')) missing.push('jira.project');
  if (missing.length) {
    throw configError(
      `Jira is not fully configured — missing: ${missing.join(', ')} (config/project.json). ` +
      'Fill the jira block (the /init-test wizard writes it).');
  }
  return {
    base: normalizeSite(val('site')),
    project: val('project'),
    board: val('board'),
    assignees: (val('assignee') || '').split(',').map((s) => s.trim()).filter(Boolean),
    storyType: val('storyType') || 'Story',
    subtaskType: val('subtaskType'),
    bugLinkType: val('bugLinkType'),
    storyPointsField: val('storyPointsField'),
    acceptanceCriteriaField: val('acceptanceCriteriaField'),
    apiVersion: '3',
  };
}

// Bounded body summary for dry-run descriptors — big string values truncated so
// a plan stays renderable; never contains auth material.
function summarizeValue(v) {
  if (typeof v === 'string' && v.length > 120) return `${v.slice(0, 120)}… (${v.length} chars)`;
  return v;
}
function summarizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = typeof v === 'object' && v !== null ? v : summarizeValue(v);
  return out;
}

// Jira error bodies carry errorMessages[] + errors{} — join both.
function serverMessageFrom(text) {
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (Array.isArray(parsed.errorMessages)) parts.push(...parsed.errorMessages);
    if (parsed.errors && typeof parsed.errors === 'object') {
      for (const [k, v] of Object.entries(parsed.errors)) parts.push(`${k}: ${v}`);
    }
    if (parts.length) return parts.join(' | ');
    return parsed.message || null;
  } catch { return null; }
}

// createmeta field entry -> the Phase-1 descriptor shape cache.js consumes
// unchanged (O4): { referenceName, name, allowedValues?: [String], alwaysRequired }.
function normalizeFieldMeta(f) {
  const allowed = (f.allowedValues || [])
    .map((v) => String(v && typeof v === 'object' ? (v.name ?? v.value ?? v.id) : v));
  return {
    referenceName: f.fieldId || f.key,
    name: f.name,
    alwaysRequired: Boolean(f.required),
    ...(allowed.length ? { allowedValues: allowed } : {}),
  };
}

function createAdapter({ cwd = process.cwd(), fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = resolveConfig(cwd);
  const doFetch = fetchImpl || globalThis.fetch;
  const projSeg = encodeURIComponent(cfg.project);

  let credState = null; // { header } — resolved lazily, once
  function auth() {
    if (!credState) {
      const email = pc.readEnvVar(cwd, 'JIRA_EMAIL');
      const token = pc.readEnvVar(cwd, 'JIRA_API_TOKEN');
      if (!email || !token) {
        throw configError(
          `Jira credentials are incomplete — looked for ${CRED_ENV_NAMES.join(' and ')} in the environment and in .env ` +
          `and found ${!email && !token ? 'neither' : email ? 'only JIRA_EMAIL' : 'only JIRA_API_TOKEN'}. ` +
          'Add both to the project\'s .env (the /init-test wizard writes them; the token comes from id.atlassian.com API tokens).');
      }
      credState = { header: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') };
    }
    return credState;
  }

  // Jira Cloud answers rejected Basic credentials on most routes by serving the
  // request ANONYMOUSLY, so a wrong email/token pair surfaces as "404 — does not
  // exist or you do not have permission". On a 404 the adapter asks /myself
  // once: a 401 there means the credentials are the real cause.
  let credsRejected; // undefined = not probed yet
  async function credentialsRejected() {
    if (credsRejected === undefined) {
      try {
        const res = await doFetch(api('myself'), {
          method: 'GET', headers: { Authorization: auth().header, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        credsRejected = res.status === 401;
      } catch {
        credsRejected = false; // probe unreachable: keep the original error
      }
    }
    return credsRejected;
  }

  async function request(op, method, requestUrl, { body, contentType, extraHeaders } = {}) {
    const { header } = auth();
    const headers = { Authorization: header, Accept: 'application/json', ...(extraHeaders || {}) };
    if (contentType) headers['Content-Type'] = contentType;
    let res;
    try {
      res = await doFetch(requestUrl, {
        method, headers, body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e && (e.name === 'TimeoutError' || e.name === 'AbortError')
        ? `request timed out after ${timeoutMs}ms`
        : (e && e.message) || String(e);
      throw new TrackerError({ op, url: requestUrl, serverMessage: msg });
    }
    const text = await res.text();
    if (!res.ok) {
      const credentialHint = { tried: ['JIRA_API_TOKEN'], resolved: 'JIRA_API_TOKEN', emailVar: 'JIRA_EMAIL' };
      if (res.status === 404 && await credentialsRejected()) {
        throw new TrackerError({
          op, status: 401, url: requestUrl, credentialHint,
          serverMessage: 'Jira rejected the credentials (GET /myself → 401), so it answered anonymously with a 404 — ' +
            'check that JIRA_EMAIL and JIRA_API_TOKEN in .env belong to the same Atlassian account and that the token is not revoked',
        });
      }
      throw new TrackerError({
        op, status: res.status, url: requestUrl,
        serverMessage: serverMessageFrom(text), body: text.slice(0, 500),
        credentialHint: res.status === 401 || res.status === 403 ? credentialHint : undefined,
      });
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // Dry-run descriptor: the full request, minus anything secret, minus the send.
  function descriptor(op, method, requestUrl, { body, contentType, extraHeaders } = {}) {
    const extra = {};
    for (const [k, v] of Object.entries(extraHeaders || {})) extra[k.toLowerCase()] = v;
    return {
      op, method, url: requestUrl,
      headers: { authorization: REDACTED_AUTH, ...(contentType ? { 'content-type': contentType } : {}), ...extra },
      body,
    };
  }

  const api = (route) => `${cfg.base}/rest/api/3/${route}`;
  const agile = (route) => `${cfg.base}/rest/agile/1.0/${route}`;
  const webUrl = (key) => `${cfg.base}/browse/${key}`;

  // The json dialect seam: neutral fields pass through; plain strings on known
  // rich-text fields are wrapped via toAdf (never a silent transformation — the
  // documented plain-text mapping, adf.js).
  function dialectFields(fields = {}) {
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = ADF_FIELDS.includes(k) && typeof v === 'string' ? toAdf(v) : v;
    }
    return out;
  }

  // relations fold: parent is the ONE relation Jira expresses inside a create/
  // update body (fields.parent — sub-task/epic mechanics); everything else is a
  // separate issueLink operation, planned as its own intent.
  function foldRelations(fields, relations, op) {
    for (const rel of relations || []) {
      if (rel.rel === 'parent') {
        fields.parent = { key: String(rel.targetId) };
      } else {
        throw configError(
          `${op}: links are separate operations on Jira — plan an addRelation intent for rel "${rel.rel}" ` +
          '(only rel "parent" folds into the issue body, as fields.parent).');
      }
    }
    return fields;
  }

  // ── createmeta (memoized per adapter instance) ────────────────────────────
  let issueTypesPromise = null;
  function loadIssueTypes() {
    if (!issueTypesPromise) {
      issueTypesPromise = (async () => {
        const res = await request('listIssueTypes', 'GET', api(`issue/createmeta/${projSeg}/issuetypes?maxResults=${META_PAGE_SIZE}`));
        const list = (res && (res.issueTypes || res.values)) || [];
        return list.map((t) => ({ id: String(t.id), name: t.name, subtask: Boolean(t.subtask) }));
      })();
      // A failed load must not poison the memo for the next call.
      issueTypesPromise.catch(() => { issueTypesPromise = null; });
    }
    return issueTypesPromise;
  }

  const unsupported = (op, flag) => async () => {
    throw new TrackerError({
      op, url: cfg.base,
      serverMessage: `not supported on this tracker (capabilities.${flag}: false) — Jira Cloud has no ${flag === 'testPlans' ? 'test-plan/suite' : 'test-run'} API`,
    });
  };

  return {
    name: 'jira',
    cwd,
    config: cfg,
    capabilities: {
      validateOnly: false,          // no server-side create dry-run — the createmeta cache pre-validates instead
      attachments: true,            // POST …/issue/{key}/attachments — post-create, needs issueId
      testPlans: false,
      testRuns: false,
      relations: { parent: true, testedBy: false, attachedFile: false },
      dialect: 'json',
      query: 'jql',
      deleteWorkItem: false,        // only permanent destroy exists; never offered (O7)
      transitions: true,            // NEW optional flag — undefined on ADO (falsy)
      comments: true,               // NEW optional flag — undefined on ADO
      sprints: true,                // agile board/sprint reads — undefined on ADO
    },

    webUrl,

    // ── READS (free, no gating) ───────────────────────────────────────────────
    async getWorkItem(id) {
      // expand always requested — renderedFields is the read path's ADF answer:
      // Jira returns HTML renderings of every rich-text field, the shape the
      // agents already parse on ADO.
      const u = api(`issue/${encodeURIComponent(id)}?${new URLSearchParams({ expand: 'renderedFields,names' })}`);
      return request('getWorkItem', 'GET', u);
    },

    // JQL search. The adapter owns pagination (nextPageToken loop, hard cap
    // SEARCH_MAX_PAGES with truncated:true) — consumers never see tokens.
    // `limit` stops early (a sample read needs one issue, not every page).
    async query(jql, { fields = ['summary', 'status', 'issuetype'], limit } = {}) {
      const u = api('search/jql');
      const issues = [];
      let nextPageToken;
      for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
        const pageSize = limit ? Math.min(SEARCH_PAGE_SIZE, limit - issues.length) : SEARCH_PAGE_SIZE;
        const body = { jql, fields, maxResults: pageSize, ...(nextPageToken ? { nextPageToken } : {}) };
        const res = await request('query', 'POST', u, { body: JSON.stringify(body), contentType: 'application/json' });
        issues.push(...((res && res.issues) || []));
        nextPageToken = res && res.nextPageToken;
        if (!nextPageToken) return { issues };
        if (limit && issues.length >= limit) return { issues: issues.slice(0, limit) };
      }
      return { issues, truncated: true };
    },

    // Sugar over query(); `~` is a text match, so EXACT summary equality is
    // filtered client-side before returning keys — the same fail-closed dup
    // semantics as ADO's WIQL exact match.
    async findByTitle(type, title) {
      const jql = `project = ${jqlQuote(cfg.project)} AND issuetype = ${jqlQuote(type)} AND summary ~ ${jqlQuote(title)}`;
      const res = await this.query(jql, { fields: ['summary'] });
      return res.issues
        .filter((i) => ((i.fields || {}).summary) === title)
        .map((i) => i.key)
        .filter(Boolean);
    },

    async listIssueTypes() {
      return loadIssueTypes();
    },

    // Field metadata for one issue type, via the per-issuetype createmeta
    // routes, normalized to the Phase-1 descriptor shape cache.js consumes
    // unchanged (O4). Unknown type name fails closed listing the real types.
    async listFields(typeName) {
      const types = await loadIssueTypes();
      const hit = types.find((t) => t.name === typeName) ||
        types.find((t) => t.name.toLowerCase() === String(typeName).toLowerCase()) ||
        types.find((t) => t.id === String(typeName));
      if (!hit) {
        throw new TrackerError({
          op: 'listFields', url: api(`issue/createmeta/${projSeg}/issuetypes`),
          serverMessage: `issue type "${typeName}" does not exist in project ${cfg.project} — real types: ${types.map((t) => t.name).join(', ')}`,
        });
      }
      const out = [];
      let startAt = 0;
      for (let page = 0; page < META_MAX_PAGES; page++) {
        const u = api(`issue/createmeta/${projSeg}/issuetypes/${hit.id}?startAt=${startAt}&maxResults=${META_PAGE_SIZE}`);
        const res = await request('listFields', 'GET', u);
        const batch = (res && (res.fields || res.values)) || [];
        out.push(...batch.map(normalizeFieldMeta));
        const total = res && typeof res.total === 'number' ? res.total : out.length;
        startAt += batch.length;
        if (!batch.length || startAt >= total) break;
      }
      return out;
    },

    // editmeta — the per-issue live-validation route for update-carrying flows.
    // Results vary by issue state and are NEVER cached (design §5.3).
    async listEditFields(id) {
      const res = await request('listEditFields', 'GET', api(`issue/${encodeURIComponent(id)}/editmeta`));
      // The map key IS the field id — authoritative even when a value omits `key`.
      return Object.entries((res && res.fields) || {}).map(([id, f]) => normalizeFieldMeta({ ...f, fieldId: f.fieldId || f.key || id }));
    },

    // All fields of the site (Story Points / Sprint discovery by display name).
    async listAllFields() {
      const res = await request('listAllFields', 'GET', api('field'));
      return Array.isArray(res) ? res : [];
    },

    // email/name → accountId (O5): resolved at validation time, one free read
    // per run; the result is carried into plans and shown on the screen.
    async findUser(query) {
      const res = await request('findUser', 'GET', api(`user/search?query=${encodeURIComponent(query)}`));
      return Array.isArray(res) ? res : [];
    },

    async listLinkTypes() {
      const res = await request('listLinkTypes', 'GET', api('issueLinkType'));
      return (res && res.issueLinkTypes) || [];
    },

    async listBoards(projectKey) {
      const res = await request('listBoards', 'GET', agile(`board?projectKeyOrId=${encodeURIComponent(projectKey || cfg.project)}`));
      return (res && res.values) || [];
    },

    async listSprints(boardId, { state } = {}) {
      const u = agile(`board/${encodeURIComponent(boardId)}/sprint${state ? `?state=${encodeURIComponent(state)}` : ''}`);
      const res = await request('listSprints', 'GET', u);
      return (res && res.values) || [];
    },

    // ── NEUTRAL READS (additive, flow-free) ───────────────────────────────────
    // Provider-neutral shapes for consumer flows: no CLI text, no flow wording,
    // no story-type rule (the caller passes the type). Each issues exactly the
    // requests a direct getWorkItem/query/listBoards/listSprints call would;
    // transport errors propagate unwrapped (the same TrackerError object).

    // NeutralStory { id, type, title, state, url, raw } — ONE request,
    // getWorkItem(ref) (renderedFields,names expanded). TOTAL on an empty body:
    // raw null, fields read as {}, id falls back to the ref.
    async getStory(ref) {
      const raw = await this.getWorkItem(ref);
      const f = (raw && raw.fields) || {};
      const id = (raw && raw.key) || ref;
      return {
        id,
        type: (f.issuetype || {}).name || null,
        title: f.summary || null,
        state: (f.status || {}).name || null,
        url: webUrl(id),
        raw,
      };
    },

    // NeutralChild[] { id, title ('' when absent), state (null when absent) } —
    // ALL sub-tasks, unfiltered, in API order, straight from the read's
    // fields.subtasks: ZERO requests. Rejects when the read carried no
    // subtasks array (the caller must fail closed). Null-safe per entry.
    async listChildren(story) {
      const f = (story.raw && story.raw.fields) || {};
      if (!Array.isArray(f.subtasks)) {
        throw new Error(`the read of ${story.id} carried no subtasks list`);
      }
      return f.subtasks.map((s) => {
        const sf = (s || {}).fields || {};
        return { id: (s || {}).key, title: sf.summary || '', state: (sf.status || {}).name || null };
      });
    },

    // SprintStories — the stories of the project's open sprint, as keys.
    // opts: storyType (REQUIRED, part of the query text), sprint (restrict to
    // the open sprint with this name or id), board (board id or name that
    // steers a multi-sprint read), sprintFieldId (the Sprint field the caller
    // already discovered — passed in so it is never re-discovered).
    // Sends ONE JQL query; only when no sprint is given AND the read spans >1
    // sprint does it consult boards: listBoards() then listSprints(id, active).
    //   { ok: true, sprint: {id, name} | null, refs: [key, …] } — refs may be empty
    //   { ok: false, condition: 'board-not-found', data: { board, boards: [{id, name}] } }
    //   { ok: false, condition: 'board-sprint-not-unique', data: { board, sprints: [{id, name}] } }
    //   { ok: false, condition: 'multiple-open-sprints', data: { sprints: [name, …] } } (distinct, first-seen)
    async listSprintStories({ storyType, sprint = null, board = null, sprintFieldId = null } = {}) {
      if (!storyType) throw new Error('listSprintStories needs opts.storyType (the issue type that counts as a story)');
      const res = await this.query(openSprintJql(cfg.project, storyType), { fields: ['summary', ...(sprintFieldId ? [sprintFieldId] : [])] });
      const sprintsOf = (issue) => {
        const v = sprintFieldId ? ((issue.fields || {})[sprintFieldId]) : null;
        return (Array.isArray(v) ? v : []).filter((s) => s && (s.state === undefined || s.state === 'active'));
      };
      let issues = res.issues || [];
      const seen = new Map(); // name -> the first sprint value carrying it
      for (const iss of issues) for (const s of sprintsOf(iss)) if (!seen.has(s.name)) seen.set(s.name, s);
      const pick = (s) => (s ? { id: s.id, name: s.name } : null);
      let from = seen.size === 1 ? pick([...seen.values()][0]) : null;
      if (sprint) {
        let hit = null;
        issues = issues.filter((iss) => sprintsOf(iss).some((s) => {
          const ok = String(s.name) === sprint || String(s.id) === sprint;
          if (ok && !hit) hit = s;
          return ok;
        }));
        from = pick(hit);
      } else if (seen.size > 1) {
        if (!board) return { ok: false, condition: 'multiple-open-sprints', data: { sprints: [...seen.keys()] } };
        const boards = await this.listBoards();
        const b = boards.find((x) => String(x.id) === board) || boards.find((x) => x.name === board);
        if (!b) return { ok: false, condition: 'board-not-found', data: { board, boards: boards.map((x) => ({ id: x.id, name: x.name })) } };
        const active = await this.listSprints(b.id, { state: 'active' });
        if (active.length !== 1) return { ok: false, condition: 'board-sprint-not-unique', data: { board, sprints: active.map((s) => ({ id: s.id, name: s.name })) } };
        issues = issues.filter((iss) => sprintsOf(iss).some((s) => String(s.id) === String(active[0].id) || s.name === active[0].name));
        from = pick(active[0]);
      }
      return { ok: true, sprint: from, refs: issues.map((i) => i.key) };
    },

    // ── WRITES (each takes {execute}; execute:false returns the descriptor) ──
    async createWorkItem(type, payload = {}, { validateOnly = false, execute = false } = {}) {
      if (validateOnly) {
        throw new TrackerError({
          op: 'createWorkItem', url: api('issue'),
          serverMessage: 'validateOnly is not supported on Jira (capabilities.validateOnly: false) — ' +
            'the createmeta field cache pre-validates instead; nothing was sent',
        });
      }
      const fields = foldRelations(dialectFields(payload.fields), payload.relations, 'createWorkItem');
      const body = {
        fields: {
          project: { key: cfg.project },
          issuetype: /^\d+$/.test(String(type)) ? { id: String(type) } : { name: String(type) },
          ...fields,
        },
      };
      const u = api('issue');
      if (!execute) return descriptor('createWorkItem', 'POST', u, { body: { fields: summarizeFields(body.fields) }, contentType: 'application/json' });
      assertCiWritesAllowed('createWorkItem');
      const res = await request('createWorkItem', 'POST', u, { body: JSON.stringify(body), contentType: 'application/json' });
      const key = (res && (res.key || res.id)) || null;
      return { id: key, url: key ? webUrl(key) : null };
    },

    async updateWorkItem(id, payload = {}, { execute = false } = {}) {
      const fields = foldRelations(dialectFields(payload.fields), payload.addRelations, 'updateWorkItem');
      const u = api(`issue/${encodeURIComponent(id)}`);
      if (!execute) return descriptor('updateWorkItem', 'PUT', u, { body: { fields: summarizeFields(fields) }, contentType: 'application/json' });
      assertCiWritesAllowed('updateWorkItem');
      await request('updateWorkItem', 'PUT', u, { body: JSON.stringify({ fields }), contentType: 'application/json' });
      return { id: String(id), url: webUrl(id) };
    },

    // relType is the provider-level Jira link-type NAME. Direction: the acting
    // item (id) is the OUTWARD side by default; attributes.direction: 'inward'
    // overrides — documented in references/tracker/jira-boards.md.
    async addRelation(id, relType, targetId, { execute = false, attributes } = {}) {
      if (relType === 'parent') {
        return this.updateWorkItem(id, { addRelations: [{ rel: 'parent', targetId }] }, { execute });
      }
      const inwardFirst = attributes && attributes.direction === 'inward';
      const body = {
        type: { name: relType },
        outwardIssue: { key: String(inwardFirst ? targetId : id) },
        inwardIssue: { key: String(inwardFirst ? id : targetId) },
      };
      const u = api('issueLink');
      if (!execute) return descriptor('addRelation', 'POST', u, { body, contentType: 'application/json' });
      assertCiWritesAllowed('addRelation');
      await request('addRelation', 'POST', u, { body: JSON.stringify(body), contentType: 'application/json' });
      return { id: String(id), relType, targetId: String(targetId) };
    },

    // Multipart with ZERO npm deps: built-in FormData + Blob (undici, the same
    // Node ≥18 floor built-in fetch already imposes); fetch composes the
    // boundary itself — the adapter never sets Content-Type manually.
    async uploadAttachment(filePath, { fileName, issueId, execute = false } = {}) {
      const name = fileName || path.basename(filePath);
      if (!issueId) {
        throw configError(
          'uploadAttachment needs opts.issueId — Jira attaches to an issue ' +
          '(POST /rest/api/3/issue/{issueId}/attachments); there is no unparented upload.');
      }
      const u = api(`issue/${encodeURIComponent(issueId)}/attachments`);
      if (!execute) {
        let size = null;
        try { size = fs.statSync(filePath).size; } catch { /* descriptor only */ }
        return descriptor('uploadAttachment', 'POST', u, {
          body: `<multipart form-data: file "${name}"${size !== null ? `, ${size} bytes` : ''}>`,
          extraHeaders: { 'X-Atlassian-Token': 'no-check' },
        });
      }
      assertCiWritesAllowed('uploadAttachment');
      const bytes = fs.readFileSync(filePath);
      const fd = new FormData();
      fd.append('file', new Blob([bytes]), name);
      const res = await request('uploadAttachment', 'POST', u, {
        body: fd, extraHeaders: { 'X-Atlassian-Token': 'no-check' },
      });
      const att = Array.isArray(res) ? res[0] : res;
      return { name, id: att && att.id, url: att && (att.content || att.self) };
    },

    // NEW op, flag `transitions`: resolve by id or case-insensitive name from
    // the REAL available transitions; no unambiguous match fails CLOSED listing
    // them — never guessed. The dry run performs the free read and returns the
    // descriptor with the resolved transition.
    async transition(id, toNameOrId, { execute = false } = {}) {
      // The execute path starts with the free transitions read, so the CI guard
      // sits BEFORE it — an execute:true call under CI refuses with zero
      // requests; the dry run (execute:false) still performs the read.
      if (execute) assertCiWritesAllowed('transition');
      const tUrl = api(`issue/${encodeURIComponent(id)}/transitions`);
      const res = await request('transition', 'GET', tUrl);
      const list = (res && res.transitions) || [];
      const wanted = String(toNameOrId);
      let matches = list.filter((t) => String(t.id) === wanted);
      if (!matches.length) matches = list.filter((t) => String(t.name).toLowerCase() === wanted.toLowerCase());
      if (matches.length !== 1) {
        throw new TrackerError({
          op: 'transition', url: tUrl,
          serverMessage: `${matches.length === 0 ? 'no' : 'more than one'} transition matches "${toNameOrId}" — ` +
            `available: ${list.map((t) => `${t.name} (id ${t.id}${t.to && t.to.name ? ` → ${t.to.name}` : ''})`).join(', ') || '(none)'}`,
        });
      }
      const t = matches[0];
      const resolved = { id: String(t.id), name: t.name, ...(t.to && t.to.name ? { to: t.to.name } : {}) };
      if (!execute) {
        return { ...descriptor('transition', 'POST', tUrl, { body: { transition: { id: resolved.id } }, contentType: 'application/json' }), transition: resolved };
      }
      await request('transition', 'POST', tUrl, { body: JSON.stringify({ transition: { id: resolved.id } }), contentType: 'application/json' });
      return { id: String(id), transition: resolved };
    },

    // NEW op, flag `comments`: plain string → toAdf; a prebuilt ADF doc passes through.
    async addComment(id, body, { execute = false } = {}) {
      const adf = typeof body === 'string' ? toAdf(body) : body;
      const u = api(`issue/${encodeURIComponent(id)}/comment`);
      if (!execute) return descriptor('addComment', 'POST', u, { body: { body: adf }, contentType: 'application/json' });
      assertCiWritesAllowed('addComment');
      const res = await request('addComment', 'POST', u, { body: JSON.stringify({ body: adf }), contentType: 'application/json' });
      return { id: res && res.id, issue: String(id) };
    },

    // NOT offered (O7 / Q13 doctrine): Jira Cloud's only issue delete is
    // permanent, and this plugin never performs permanent destroys.
    async deleteWorkItem() {
      throw new TrackerError({
        op: 'deleteWorkItem', url: cfg.base,
        serverMessage: 'not offered on Jira (capabilities.deleteWorkItem: false): the only delete Jira Cloud ' +
          'has is PERMANENT — no Recycle Bin — and this plugin never performs permanent destroys',
      });
    },

    // Test-plan/run surface: Jira has no equivalent APIs. Consumers branch on
    // the capability flags first — these are honest backstops, never reached
    // by shipped flows.
    listSuites: unsupported('listSuites', 'testPlans'),
    listSuiteCases: unsupported('listSuiteCases', 'testPlans'),
    getPoint: unsupported('getPoint', 'testPlans'),
    addCaseToSuite: unsupported('addCaseToSuite', 'testPlans'),
    listRunResults: unsupported('listRunResults', 'testRuns'),
    createRun: unsupported('createRun', 'testRuns'),
    updateRunResults: unsupported('updateRunResults', 'testRuns'),
    updateRun: unsupported('updateRun', 'testRuns'),
  };
}

module.exports = { createAdapter, resolveConfig, normalizeSite, jqlQuote, openSprintJql, TrackerError, CRED_ENV_NAMES };
