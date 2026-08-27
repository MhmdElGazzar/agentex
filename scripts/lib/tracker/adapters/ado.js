'use strict';
// Azure DevOps REST adapter — the provider side of scripts/lib/tracker/.
//
// Transport: Node's built-in fetch, direct against the ADO REST API. There is NO
// az CLI here and nothing in this lib can spawn a process (a test asserts it):
// HTTP bodies have no shell, so bug text of any size and shape travels without
// quoting tricks, temp-file args, or the Windows 8191-char command-line limit.
//
// SECRETS (invariant 5): the PAT resolves lazily via the repo's
// project_config.readEnvVar (process.env, then a KEY=value line in <cwd>/.env),
// in the order AZURE_PAT -> AZURE_DEVOPS_EXT_PAT -> AZURE_DEVOPS_PAT (the
// scaffolded name first; pattern credit: plugin PR #16's resolvePat, order
// inverted). It enters memory once and reaches ONLY the Authorization header —
// never a return value, an error, a log line, argv, or a dry-run descriptor
// (those print `authorization: <Basic ***, not printed>`, PR #16's wording).
//
// CONFIG (invariants 7/10): org/project/apiVersion come from the consumer's
// config/project.json `azure` block with legacy AZURE_* .env keys as fallback
// (the existing pick() pattern). Anything missing is an explicit error naming
// the keys looked for — never a silent fallback.
//
// WRITES (invariant 4): every write method takes {execute}. execute:false sends
// NOTHING and returns the full request descriptor (method, url, redacted
// headers, body summary) for the consolidated pre-approval screen. Nothing here
// retries or cleans up — that discipline lives in ledger.js.
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', '..', 'project_config.js'));

const PAT_ENV_NAMES = ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT'];
const DEFAULT_TIMEOUT_MS = 30_000; // same bound as the catalog runners
const REDACTED_AUTH = '<Basic ***, not printed>';

// What every adapter method throws on failure — never a raw fetch error, never
// anything containing the PAT. 401/403 add credentialHint (env-var NAMES only).
class TrackerError extends Error {
  constructor({ op, status, url, serverMessage, body, credentialHint }) {
    const head = status ? `HTTP ${status}` : 'request failed';
    super(`${op} failed: ${head}${serverMessage ? ` — ${serverMessage}` : ''} (${url})`);
    this.name = 'TrackerError';
    this.op = op;
    this.status = status ?? null;
    this.url = url;
    this.serverMessage = serverMessage || null;
    this.body = body || '';
    if (credentialHint) this.credentialHint = credentialHint;
  }
}

function configError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// azure block key first, legacy AZURE_* env second; empty/missing => null.
function pick(cwd, az, key, envName) {
  const j = az[key];
  if (j !== undefined && j !== null && String(j).trim() !== '') return String(j).trim();
  const v = pc.readEnvVar(cwd, envName);
  return v === null || v === '' ? null : v;
}

// `azure.org` accepts both spellings, explicitly: a full URL is used as-is
// (trailing slashes stripped); a bare org name becomes https://dev.azure.com/<org>.
// No other guessing.
function normalizeOrg(org) {
  const trimmed = String(org).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://dev.azure.com/${trimmed}`;
}

// Resolve the consumer's non-secret ADO settings (invariant 7). Missing
// org/project is an explicit exit-2 error naming what was looked for (invariant 10).
function resolveConfig(cwd) {
  const az = pc.loadProjectConfig(cwd).azure || {};
  const orgRaw = pick(cwd, az, 'org', 'AZURE_URL');
  const project = pick(cwd, az, 'project', 'AZURE_PROJECT');
  const missing = [];
  if (!orgRaw) missing.push('azure.org (config/project.json) / AZURE_URL (.env)');
  if (!project) missing.push('azure.project (config/project.json) / AZURE_PROJECT (.env)');
  if (missing.length) {
    throw configError(
      `Azure DevOps is not fully configured — missing: ${missing.join(', ')}. ` +
      'Fill the azure block in config/project.json (the /init-test wizard writes it).');
  }
  return {
    base: normalizeOrg(orgRaw),
    project,
    team: pick(cwd, az, 'team', 'AZURE_TEAM'),
    areaPath: pick(cwd, az, 'areaPath', 'AZURE_AREA_PATH'),
    iterationPath: pick(cwd, az, 'iterationPath', 'AZURE_ITERATION_PATH'),
    templateBugId: pick(cwd, az, 'bugTemplateId', 'AZURE_BUG_TEMPLATE_ID'),
    assignees: (pick(cwd, az, 'assignee', 'AZURE_ASSIGNEE') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    valueArea: pick(cwd, az, 'valueArea', 'AZURE_VALUE_AREA'),
    environment: pick(cwd, az, 'environment', 'AZURE_ENVIRONMENT'),
    bugCategory: pick(cwd, az, 'bugCategory', 'AZURE_BUG_CATEGORY'),
    testPlanId: pick(cwd, az, 'testPlanId', 'AZURE_TEST_PLAN_ID'),
    apiVersion: pick(cwd, az, 'apiVersion', 'AZURE_API_VERSION') || '7.1',
  };
}

// Bounded body summary for dry-run descriptors — big values truncated so a plan
// stays renderable; never contains auth material.
function summarizeValue(v) {
  if (typeof v === 'string' && v.length > 120) return `${v.slice(0, 120)}… (${v.length} chars)`;
  return v;
}
function summarizeOps(ops) {
  return ops.map((o) => ({ ...o, value: typeof o.value === 'object' && o.value !== null ? o.value : summarizeValue(o.value) }));
}

function createAdapter({ cwd = process.cwd(), fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = resolveConfig(cwd);
  const doFetch = fetchImpl || globalThis.fetch;
  const projSeg = encodeURIComponent(cfg.project);

  let patState = null; // { header, resolvedName } — resolved lazily, once
  function auth(op, url) {
    if (!patState) {
      let resolvedName = null; let pat = null;
      for (const name of PAT_ENV_NAMES) {
        const v = pc.readEnvVar(cwd, name);
        if (v) { resolvedName = name; pat = v; break; }
      }
      if (!pat) {
        throw configError(
          `No Azure DevOps PAT found — looked for ${PAT_ENV_NAMES.join(', ')} in the environment and in .env. ` +
          'Add AZURE_PAT to the project\'s .env (the /init-test wizard writes it).');
      }
      patState = {
        header: 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        resolvedName,
      };
    }
    return patState;
  }

  function url(route, params = {}, { project = true, apiVersion = cfg.apiVersion } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    q.set('api-version', apiVersion);
    // URLSearchParams encodes '$expand' fine, but keep the literal $ readable:
    const query = q.toString().replace(/%24/g, '$');
    return `${cfg.base}${project ? '/' + projSeg : ''}/_apis/${route}?${query}`;
  }

  async function request(op, method, requestUrl, { body, contentType } = {}) {
    const { header, resolvedName } = auth(op, requestUrl);
    const headers = { Authorization: header, Accept: 'application/json' };
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
      let serverMessage = null;
      try { serverMessage = JSON.parse(text).message || null; } catch { /* not json */ }
      const err = new TrackerError({
        op, status: res.status, url: requestUrl, serverMessage, body: text.slice(0, 500),
        credentialHint: res.status === 401 || res.status === 403
          ? { tried: [...PAT_ENV_NAMES], resolved: resolvedName }
          : undefined,
      });
      throw err;
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // Dry-run descriptor: the full request, minus anything secret, minus the send.
  function descriptor(op, method, requestUrl, { body, contentType } = {}) {
    return {
      op, method, url: requestUrl,
      headers: { authorization: REDACTED_AUTH, ...(contentType ? { 'content-type': contentType } : {}) },
      body,
    };
  }

  // Neutral {fields, relations|addRelations} -> ADO json-patch op array (the dialect seam).
  function toPatchOps({ fields = {}, relations, addRelations } = {}) {
    const ops = [];
    for (const [ref, value] of Object.entries(fields)) {
      ops.push({ op: 'add', path: `/fields/${ref}`, value });
    }
    for (const rel of relations || addRelations || []) {
      ops.push({
        op: 'add', path: '/relations/-',
        value: {
          rel: rel.rel,
          url: rel.url || `${cfg.base}/_apis/wit/workItems/${rel.targetId}`,
          ...(rel.attributes ? { attributes: rel.attributes } : {}),
        },
      });
    }
    return ops;
  }

  const webUrl = (id) => `${cfg.base}/${projSeg}/_workitems/edit/${id}`;

  return {
    name: 'ado',
    cwd,
    config: cfg,
    capabilities: {
      validateOnly: true,               // server-side dry-run of a create
      attachments: true,                // binary upload API exists
      testPlans: true,
      testRuns: true,
      relations: { parent: true, testedBy: true, attachedFile: true },
      dialect: 'json-patch',            // work-item write body dialect ('json' for Jira)
      query: 'wiql',                    // 'jql' for Jira
      deleteWorkItem: 'partial',        // ADO: most types yes, Test Case no
    },

    // ── READS (free, no gating) ────────────────────────────────────────────────
    async getWorkItem(id, { expand } = {}) {
      const u = url(`wit/workitems/${id}`, expand ? { $expand: expand === true ? 'all' : expand } : {});
      return request('getWorkItem', 'GET', u);
    },

    async query(text) {
      return request('query', 'POST', url('wit/wiql'), {
        body: JSON.stringify({ query: text }), contentType: 'application/json',
      });
    },

    // Sugar over query(); the adapter owns WIQL quoting/escaping.
    async findByTitle(type, title) {
      const esc = (s) => String(s).replace(/'/g, "''");
      const wiql =
        `SELECT [System.Id] FROM workitems WHERE [System.WorkItemType]='${esc(type)}'` +
        ` AND [System.TeamProject]='${esc(cfg.project)}' AND [System.Title]='${esc(title)}'`;
      const res = await this.query(wiql);
      const rows = Array.isArray(res) ? res : (res && res.workItems) || [];
      return rows.map((w) => w.id).filter((id) => id !== undefined && id !== null);
    },

    async listFields(workItemType) {
      const u = url(`wit/workitemtypes/${encodeURIComponent(workItemType)}/fields`, { $expand: 'allowedValues' });
      const res = await request('listFields', 'GET', u);
      return (res && res.value) || [];
    },

    async listSuites(planId) {
      const res = await request('listSuites', 'GET', url(`testplan/Plans/${planId}/suites`));
      return (res && res.value) || [];
    },

    async listSuiteCases(planId, suiteId) {
      const res = await request('listSuiteCases', 'GET', url(`testplan/Plans/${planId}/Suites/${suiteId}/TestCase`));
      return (res && res.value) || [];
    },

    // Per-suite point lookup on purpose — the global ?testCaseId shortcut 404s on many orgs.
    async getPoint(planId, suiteId, testCaseId) {
      const u = url(`testplan/Plans/${planId}/Suites/${suiteId}/TestPoint`, { testCaseId });
      const res = await request('getPoint', 'GET', u);
      return ((res && res.value) || [])[0] || null;
    },

    async listRunResults(runId) {
      const res = await request('listRunResults', 'GET', url(`test/Runs/${runId}/results`));
      return (res && res.value) || [];
    },

    // ── WRITES (each takes {execute}; execute:false returns the descriptor) ──
    async createWorkItem(type, payload, { validateOnly = false, execute = false } = {}) {
      const u = url(`wit/workitems/$${encodeURIComponent(type)}`, validateOnly ? { validateOnly: 'true' } : {});
      const ops = toPatchOps(payload);
      if (!execute) return descriptor('createWorkItem', 'POST', u, { body: summarizeOps(ops), contentType: 'application/json-patch+json' });
      const res = await request('createWorkItem', 'POST', u, {
        body: JSON.stringify(ops), contentType: 'application/json-patch+json',
      });
      const id = res && res.id;
      return { id, url: (res && res._links && res._links.html && res._links.html.href) || (id ? webUrl(id) : null), validateOnly };
    },

    async updateWorkItem(id, payload, { execute = false } = {}) {
      const u = url(`wit/workitems/${id}`);
      const ops = toPatchOps(payload);
      if (!execute) return descriptor('updateWorkItem', 'PATCH', u, { body: summarizeOps(ops), contentType: 'application/json-patch+json' });
      const res = await request('updateWorkItem', 'PATCH', u, {
        body: JSON.stringify(ops), contentType: 'application/json-patch+json',
      });
      return { id: (res && res.id) ?? id, rev: res && res.rev, url: webUrl(id) };
    },

    async addRelation(id, relType, targetId, { execute = false, attributes } = {}) {
      return this.updateWorkItem(id, { addRelations: [{ rel: relType, targetId, ...(attributes ? { attributes } : {}) }] }, { execute });
    },

    async uploadAttachment(filePath, { fileName, execute = false } = {}) {
      const name = fileName || path.basename(filePath);
      const u = url('wit/attachments', { fileName: name });
      if (!execute) {
        let size = null;
        try { size = fs.statSync(filePath).size; } catch { /* descriptor only */ }
        return descriptor('uploadAttachment', 'POST', u, {
          body: `<raw bytes of ${name}${size !== null ? `, ${size} bytes` : ''}>`,
          contentType: 'application/octet-stream',
        });
      }
      const bytes = fs.readFileSync(filePath);
      const res = await request('uploadAttachment', 'POST', u, { body: bytes, contentType: 'application/octet-stream' });
      return { name, id: res && res.id, url: res && res.url };
    },

    // The exact route `az devops invoke --area testplan --resource "suite entries"`
    // resolves: PATCH .../testplan/suiteentry/{suiteId}, body [{id}]. The endpoint
    // is preview-only, so the api-version carries the -preview.2 suffix.
    async addCaseToSuite(planId, suiteId, caseId, { execute = false } = {}) {
      const u = url(`testplan/suiteentry/${suiteId}`, {}, { apiVersion: `${cfg.apiVersion}-preview.2` });
      const body = [{ id: Number(caseId) }];
      if (!execute) return descriptor('addCaseToSuite', 'PATCH', u, { body, contentType: 'application/json' });
      await request('addCaseToSuite', 'PATCH', u, { body: JSON.stringify(body), contentType: 'application/json' });
      return { id: Number(caseId), suiteId, planId };
    },

    async createRun(body, { execute = false } = {}) {
      const u = url('test/runs');
      if (!execute) return descriptor('createRun', 'POST', u, { body, contentType: 'application/json' });
      const res = await request('createRun', 'POST', u, { body: JSON.stringify(body), contentType: 'application/json' });
      return { id: res && res.id, url: res && res.url };
    },

    async updateRunResults(runId, results, { execute = false } = {}) {
      const u = url(`test/Runs/${runId}/results`);
      if (!execute) return descriptor('updateRunResults', 'PATCH', u, { body: results, contentType: 'application/json' });
      await request('updateRunResults', 'PATCH', u, { body: JSON.stringify(results), contentType: 'application/json' });
      return { id: runId };
    },

    async updateRun(runId, body, { execute = false } = {}) {
      const u = url(`test/runs/${runId}`);
      if (!execute) return descriptor('updateRun', 'PATCH', u, { body, contentType: 'application/json' });
      const res = await request('updateRun', 'PATCH', u, { body: JSON.stringify(body), contentType: 'application/json' });
      return { id: (res && res.id) ?? runId, state: res && res.state };
    },

    // Standard work-item delete → the Recycle Bin (recoverable). Permanent
    // destroy is STRUCTURALLY impossible here: no destroy option exists in the
    // signature, none is ever emitted, and the id is validated to a positive
    // integer before the URL is composed — nothing can smuggle a query string
    // through it. Backs the capability flag deleteWorkItem: 'partial' (ADO has
    // no standard delete for test artifacts such as Test Cases).
    async deleteWorkItem(id, { execute = false } = {}) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) {
        throw configError(`deleteWorkItem needs a positive integer work-item id (got ${JSON.stringify(id)})`);
      }
      const u = url(`wit/workitems/${n}`);
      if (!execute) return descriptor('deleteWorkItem', 'DELETE', u);
      const res = await request('deleteWorkItem', 'DELETE', u);
      return { id: (res && res.id) ?? n };
    },
  };
}

module.exports = { createAdapter, resolveConfig, normalizeOrg, TrackerError, PAT_ENV_NAMES };
