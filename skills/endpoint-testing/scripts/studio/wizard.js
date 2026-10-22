'use strict';
// AgenTeX suite studio — the "New suite from Swagger" wizard, mounted on server.js.
//
// Steps 1, 2, 4 and 5 run on the server alone; step 3 (test data) needs the agent, which
// attaches through the channel (channel.js → /api/agent/*). Nothing is written in the project
// before the one approval in step 5: the spec fetch in step 1 is the only network request the
// server makes, and every value, consent and the captured token are held in memory until then.
//
// Approval writes, in order: the catalog and the suite (flag "wx" — never over an existing
// file), the captured token (test/.auth/api-tokens/, 0600), the collected-data store
// (.agentex/cache/api-data/), and one "<PREFIX>_BASE_URL=" line in .env when that variable is
// unset (A6; an existing value is never changed). A store path that is not gitignored is
// refused and named on the page (A17); the catalog and suite are still written.
//
// Q21 (in the server, not only in the prompt): the agent's one proposal per collect run is
// accepted only when environments/<env>.json has "nonProduction": true (boolean); anything
// else is refused naming the field and the file. A "created" report outside the consented list
// is refused and flagged on the page.
const fs = require('fs');
const path = require('path');
const U = require('./http_util.js');
const D = require('./data_store.js');
const M = require(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'swagger_model.js'));
const pc = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const MAX_PROPOSAL_ITEMS = 50; // (Q8)
const WAIT_MS = 90 * 1000;          // one channel.js wait, by default (Q8)
const MAX_WAIT_MS = 120 * 1000;
const ATTACH_GRACE_MS = 10 * 1000;  // attached while a wait is pending or ended < 10 s ago (Q8)
const SECRET_KEY_RE = /passw|secret|token|authoriz|cookie/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;
const HEADER_TOKEN_RE = /^\s*(bearer|basic|token|apikey|api-key)\s+\S{8,}/i;

function freshWizard() {
  return { model: null, source: null, ops: [], slug: null, env: null, files: null, apiOrigin: null, baseUrlLiteral: null,
    selection: [], needs: [], values: {}, missing: {}, user: null, run: null, runSeq: 0, consents: [], token: null };
}

function coerceTyped(value, type) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if ((type === 'integer' && /^-?\d+$/.test(s)) || (type === 'number' && s !== '' && Number.isFinite(Number(s)))) return Number(s);
  if (type === 'boolean' && (s === 'true' || s === 'false')) return s === 'true';
  if (type === 'json') { try { return JSON.parse(s); } catch { return value; } }
  return value;
}
function suggestBaseUrl(literal, observed) {
  const absolute = typeof literal === 'string' && /^https?:\/\//i.test(literal) && !literal.includes('REPLACE_ME');
  if (!observed) return absolute ? literal : '';
  let p = '';
  try { p = absolute ? new URL(literal).pathname : (typeof literal === 'string' && literal.startsWith('/') ? literal : ''); } catch { p = ''; }
  p = p === '/' ? '' : p.replace(/\/$/, '');
  return observed.replace(/\/$/, '') + p;
}

function mount(studio) {
  const { state, route, root } = studio;
  let wz = state.wizard = freshWizard();

  // ---- the channel: the agent opts in with bounded long-polls (channel.js wait) ----
  const ch = { queue: [], waiters: [], lastWaitEnd: 0 };
  studio.agentAttached = () => ch.waiters.length > 0 || Date.now() - ch.lastWaitEnd < ATTACH_GRACE_MS;
  function deliver(w, ev) {
    if (w.done) return false;
    w.done = true;
    clearTimeout(w.timer);
    ch.waiters = ch.waiters.filter(x => x !== w);
    ch.lastWaitEnd = Date.now();
    U.respondJSON(w.res, 200, ev);
    return true;
  }
  studio.notifyAgent = (ev) => {
    while (ch.waiters.length) { if (deliver(ch.waiters[0], ev)) return; }
    ch.queue.push(ev);
  };
  if (studio.onClose) studio.onClose(reason => { for (const w of ch.waiters.slice()) deliver(w, { event: 'closed', reason }); });
  route('GET', '/api/agent/next', 'control', (req, url, m, res) => {
    const asked = parseInt(url.searchParams.get('timeout'), 10);
    const timeout = Math.min(Math.max(Number.isFinite(asked) ? asked : WAIT_MS, 10), MAX_WAIT_MS);
    ch.lastWaitEnd = Date.now();
    if (ch.queue.length) return { body: ch.queue.shift() };
    const w = { res, done: false };
    w.timer = setTimeout(() => deliver(w, { event: 'idle' }), timeout);
    res.on('close', () => { if (!w.done) { w.done = true; clearTimeout(w.timer); ch.waiters = ch.waiters.filter(x => x !== w); ch.lastWaitEnd = Date.now(); } });
    ch.waiters.push(w);
    return undefined; // answered by deliver()
  });

  const credentialShaped = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) return false;
    if (JWT_RE.test(s) || HEADER_TOKEN_RE.test(s)) return true;
    if (wz.token && wz.token.value && s.includes(wz.token.value)) return true;
    if (v && typeof v === 'object') {
      let hit = false;
      (function walk(o) { for (const [k, x] of Object.entries(o)) { if (SECRET_KEY_RE.test(k) && typeof x === 'string' && x) hit = true; else if (x && typeof x === 'object') walk(x); } })(v);
      return hit;
    }
    return false;
  };
  studio.credentialShaped = credentialShaped;
  const need = p => wz.needs.find(n => n.param === p);
  const generate = () => M.generate(wz.model, wz.selection, wz.values, { name: wz.slug, capturedToken: wz.token ? { scheme: wz.token.scheme, headerName: wz.token.headerName } : undefined });
  const existsNow = () => ({ catalog: fs.existsSync(path.join(root, wz.files.catalog)), suite: fs.existsSync(path.join(root, wz.files.suite)) });
  const tokenView = () => (wz.token ? { present: true, user: wz.token.user || null, capturedAt: wz.token.capturedAt, scheme: wz.token.scheme } : { present: false });
  const runView = r => r && {
    runId: r.runId, status: r.status, phase: r.phase, gate: r.gate, reason: r.reason, found: r.found, total: r.total,
    proposal: r.proposal && { id: r.proposal.id, items: r.proposal.items, decided: r.proposal.decided, decision: r.proposal.decision },
    refused: r.refused, violations: r.violations, created: r.created,
  };
  studio.wizard = () => wz;

  // ---- step 1: spec + suite name + environment (no silent default) ----
  route('POST', '/api/wizard/spec', 'page', async (req) => {
    const b = await U.readJSON(req);
    const source = String(b.source || '').trim();
    const suiteName = String(b.suiteName || '').trim();
    const env = String(b.env || '');
    if (!source || !suiteName) return { status: 400, body: { ok: false, error: 'missing', message: 'a spec source and a suite name are required' } };
    const names = studio.envList().environments.map(e => e.name);
    if (!names.includes(env)) return { status: 400, body: { ok: false, error: 'env', message: `pick one of the project's environments (${names.join(', ') || 'none defined'})` } };
    const src = /^https?:\/\//i.test(source) ? source : path.resolve(root, source);
    let model;
    try { model = M.parseSpec(await M.loadSpec(src), source); }
    catch (e) { return { status: 400, body: { ok: false, error: 'spec', message: e.message } }; }
    const ops = M.listOperations(model);
    if (!ops.length) return { status: 400, body: { ok: false, error: 'spec', message: 'no operations found in "paths" — nothing to import' } };
    const slug = M.slug(suiteName);
    wz = state.wizard = freshWizard();
    const lit = M.baseUrlOf(model);
    let apiOrigin = null;
    try { apiOrigin = /^https?:\/\//i.test(lit) && !lit.includes('REPLACE_ME') ? new URL(lit).origin : null; } catch { apiOrigin = null; }
    Object.assign(wz, { model, source, ops, slug, env, apiOrigin, baseUrlLiteral: lit,
      files: { catalog: `integration/api_test_suites/${slug}/${slug}_api.json`, suite: `integration/api_test_suites/${slug}/${slug}_suite.json` } });
    state.log(`wizard: read ${ops.length} operations from ${source}`);
    return { body: { ok: true, slug, files: wz.files, exists: existsNow(), ops } };
  });

  // ---- step 2: pick operations ----
  route('POST', '/api/wizard/select', 'page', async (req) => {
    if (!wz.model) return { status: 400, body: { ok: false, error: 'no-spec' } };
    const b = await U.readJSON(req);
    const ids = new Set(wz.ops.map(o => o.id));
    const selection = (Array.isArray(b.selection) ? b.selection : []).filter(id => ids.has(id));
    if (!selection.length) return { status: 400, body: { ok: false, error: 'pick-one' } };
    const byParam = new Map();
    for (const o of wz.ops.filter(x => selection.includes(x.id))) {
      for (const n of o.needs) {
        if (!byParam.has(n.param)) byParam.set(n.param, { param: n.param, in: n.in, type: n.type, operations: [] });
        byParam.get(n.param).operations.push(o.id);
      }
    }
    wz.selection = selection;
    wz.needs = [...byParam.values()];
    for (const p of Object.keys(wz.values)) if (!byParam.has(p)) delete wz.values[p];
    return { body: { ok: true, needs: wz.needs } };
  });

  // ---- step 3, the parts that need no agent: a typed value (Manual) or a placeholder ----
  route('POST', '/api/wizard/value', 'page', async (req) => {
    const b = await U.readJSON(req);
    const n = need(b.param);
    if (!n) return { status: 400, body: { ok: false, error: 'unknown-param' } };
    if (b.source === 'placeholder') { wz.values[n.param] = { value: '', source: 'placeholder' }; return { body: { ok: true } }; }
    if (b.source !== 'manual' || b.value === undefined || String(b.value).trim() === '') return { status: 400, body: { ok: false, error: 'bad-value' } };
    if (credentialShaped(b.value)) return { status: 400, body: { ok: false, error: 'credential-shaped' } };
    wz.values[n.param] = { value: coerceTyped(b.value, n.type), source: 'manual' };
    delete wz.missing[n.param];
    return { body: { ok: true } };
  });

  route('GET', '/api/wizard/state', 'page', () => ({ body: {
    ok: true, attached: studio.agentAttached(), slug: wz.slug, env: wz.env, user: wz.user, files: wz.files, needs: wz.needs,
    values: wz.values, missing: wz.missing, run: runView(wz.run), token: tokenView(),
    tokenNeeded: wz.ops.some(o => wz.selection.includes(o.id) && o.auth === 'token'),
    tokenVar: wz.slug ? `${M.envPrefixFor(wz.slug)}_TOKEN` : null,
  } }));

  // ---- step 4: preview (nothing written) ----
  route('GET', '/api/wizard/preview', 'page', () => {
    if (!wz.model || !wz.selection.length) return { status: 400, body: { ok: false, error: 'no-selection' } };
    const gen = generate();
    const v = gen.summary.baseUrlVar;
    return { body: { ok: true, summary: gen.summary, files: wz.files, exists: existsNow(), token: tokenView(),
      baseUrl: { var: v, isSet: !!pc.readEnvVar(root, v), suggested: suggestBaseUrl(gen.summary.baseUrlLiteral, wz.token && wz.token.apiOrigin) } } };
  });

  // ---- step 5: one approval writes everything ----
  route('POST', '/api/wizard/approve', 'page', async (req) => {
    if (!wz.model || !wz.selection.length) return { status: 400, body: { ok: false, error: 'no-selection' } };
    const b = await U.readJSON(req);
    const exists = existsNow();
    if (exists.catalog || exists.suite) return { status: 409, body: { ok: false, error: 'exists', file: exists.catalog ? wz.files.catalog : wz.files.suite } };
    const gen = generate();
    const baseVar = gen.summary.baseUrlVar;
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
    if (baseUrl && (!/^https?:\/\/[^\s]+$/i.test(baseUrl))) return { status: 400, body: { ok: false, error: 'bad-base-url' } };

    // the committed pair — never over an existing file
    fs.mkdirSync(path.dirname(path.join(root, wz.files.catalog)), { recursive: true });
    try {
      fs.writeFileSync(path.join(root, wz.files.catalog), JSON.stringify(gen.catalog, null, 2) + '\n', { flag: 'wx' });
    } catch (e) { if (e.code === 'EEXIST') return { status: 409, body: { ok: false, error: 'exists', file: wz.files.catalog } }; throw e; }
    try {
      fs.writeFileSync(path.join(root, wz.files.suite), JSON.stringify(gen.suite, null, 2) + '\n', { flag: 'wx' });
    } catch (e) {
      fs.unlinkSync(path.join(root, wz.files.catalog)); // ours, written a moment ago
      if (e.code === 'EEXIST') return { status: 409, body: { ok: false, error: 'exists', file: wz.files.suite } };
      throw e;
    }
    state.log(`wizard: wrote ${wz.files.catalog} and ${wz.files.suite}`);

    const notIgnored = [];
    let tokenRef = null;
    if (wz.token && wz.token.value) {
      const tk = D.writeToken(root, { store: wz.slug, environment: wz.env, user: wz.token.user, scheme: wz.token.scheme, headerName: wz.token.headerName, token: wz.token.value, capturedAt: wz.token.capturedAt });
      if (tk.ok) tokenRef = tk.ref; else notIgnored.push(tk.path);
      wz.token.value = null; // the file is now the only holder
    }
    const usedPlaceholders = p => gen.suite.cases.filter(c => (c.sources || {})[p] === 'placeholder' && !(c.omit || []).includes(p)).length;
    const store = {
      suite: wz.files.suite, environment: wz.env, collectedAt: new Date().toISOString(),
      values: Object.entries(wz.values).filter(([, v]) => v.source === 'ui' || v.source === 'project')
        .map(([param, v], i) => ({ id: `v${i + 1}`, param, value: v.value, source: v.source, ...(v.user ? { user: v.user } : {}), ...(v.provenance ? { provenance: v.provenance } : {}) })),
      missing: wz.needs.filter(n => !wz.values[n.param] || wz.values[n.param].source === 'placeholder')
        .map(n => ({ param: n.param, cases: usedPlaceholders(n.param), hint: (wz.missing[n.param] || {}).hint || '' })),
      consents: wz.consents,
      ...(tokenRef ? { token: { ref: tokenRef, user: wz.token.user || null, source: 'ui', capturedAt: wz.token.capturedAt } } : {}),
    };
    const st = D.writeStore(root, wz.slug, store);
    if (!st.ok) notIgnored.push(st.path);

    let envLineAdded = false;
    if (baseUrl && !pc.readEnvVar(root, baseVar)) {
      const envFile = path.join(root, '.env');
      let cur = '';
      try { cur = fs.readFileSync(envFile, 'utf8'); } catch { cur = ''; }
      fs.writeFileSync(envFile, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${baseVar}=${baseUrl}\n`);
      envLineAdded = true;
    }
    const filter = gen.suite.cases.some(M.needsReview) ? 'needs-review' : 'all';
    const created = (wz.consents || []).flatMap(c => (c.created || []).map(i => c.items[i] && c.items[i].what)).filter(Boolean);
    studio.notifyAgent({ event: 'closed', reason: 'approved', catalogPath: wz.files.catalog, suitePath: wz.files.suite,
      bySource: gen.summary.bySource, cases: gen.summary.total, created, tokenRef });
    let runId = null;
    if (b.run === true) {
      const r = studio.startRun({ suite: wz.files.suite, env: wz.env });
      runId = r.body && r.body.id ? r.body.id : null;
    }
    state.mode = 'editor';
    return { body: { ok: true, catalogPath: wz.files.catalog, suitePath: wz.files.suite, filter, runId, notIgnored, envLineAdded, tokenRef } };
  });

  // ---- collect: without an attached agent, the page says to ask in chat (A13) ----
  route('POST', '/api/wizard/collect', 'page', async (req) => startCollect(await U.readJSON(req), 'collect'));
  route('POST', '/api/wizard/collect-again', 'page', async (req) => startCollect(await U.readJSON(req), 'collect-again'));
  function startCollect(b, kind) {
    if (!wz.model || !wz.selection.length) return { status: 400, body: { ok: false, error: 'no-selection' } };
    if (!studio.agentAttached()) return { body: { ok: false, error: 'no-agent' } };
    if (wz.run && wz.run.status === 'collecting') return { status: 409, body: { ok: false, error: 'busy' } };
    const env = studio.envList().environments.find(e => e.name === wz.env) || { users: [] };
    const user = b.user === null || b.user === undefined || b.user === '' ? null : String(b.user);
    if (user && !env.users.includes(user)) return { status: 400, body: { ok: false, error: 'unknown-user' } };
    wz.user = user;
    const runId = `c${++wz.runSeq}`;
    wz.run = { runId, status: 'collecting', phase: null, gate: null, proposal: null, refused: null, violations: [], created: [], reason: null };
    const needs = kind === 'collect-again' && b.all !== true
      ? wz.needs.filter(n => !wz.values[n.param] || !['ui', 'project'].includes(wz.values[n.param].source))
      : wz.needs;
    studio.notifyAgent({ event: kind, runId, suite: wz.slug, env: wz.env, user, apiOrigin: wz.apiOrigin, needs });
    return { body: { ok: true, runId } };
  }

  // ---- page → agent: cancel, gate cleared, the one Q21 consent ----
  const current = () => wz.run;
  route('POST', '/api/wizard/cancel', 'page', () => {
    const r = current();
    if (!r || r.status !== 'collecting') return { status: 400, body: { ok: false, error: 'not-collecting' } };
    r.status = 'cancelled';
    studio.notifyAgent({ event: 'cancel', runId: r.runId });
    return { body: { ok: true } };
  });
  route('POST', '/api/wizard/gate-cleared', 'page', () => {
    const r = current();
    if (!r || !r.gate) return { status: 400, body: { ok: false, error: 'no-gate' } };
    r.gate = null;
    studio.notifyAgent({ event: 'gate-cleared', runId: r.runId });
    return { body: { ok: true } };
  });
  route('POST', '/api/wizard/consent', 'page', async (req) => {
    const b = await U.readJSON(req);
    const r = current();
    if (!r || !r.proposal || r.proposal.id !== b.proposalId || r.proposal.decided) return { status: 400, body: { ok: false, error: 'no-open-proposal' } };
    if (b.decision !== 'yes' && b.decision !== 'no') return { status: 400, body: { ok: false, error: 'bad-decision' } };
    r.proposal.decided = true;
    r.proposal.decision = b.decision;
    r.consent = { at: new Date().toISOString(), environment: wz.env, decision: b.decision, items: r.proposal.items, created: [] };
    wz.consents.push(r.consent);
    // the exact list as shown — the agent creates these and nothing else
    studio.notifyAgent({ event: 'consent', runId: r.runId, proposalId: r.proposal.id, decision: b.decision, items: r.proposal.items });
    return { body: { ok: true } };
  });

  // ---- agent → page: progress, values, the proposal (Q21 guard), created items ----
  const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
  const agentEvents = {
    phase(r, b) {
      if (!['project', 'login', 'walk', 'create', 'done'].includes(b.name)) return { ok: false, error: 'bad-phase' };
      r.phase = { name: b.name, text: str(b.text) };
      return { ok: true };
    },
    value(r, b) {
      const n = need(b.param);
      if (!n) return { ok: false, error: 'unknown-param' };
      if (b.source !== 'project' && b.source !== 'ui') return { ok: false, error: 'bad-source' };
      if (b.value === undefined || b.value === null || b.value === '') return { ok: false, error: 'bad-value' };
      if (credentialShaped(b.value)) return { ok: false, error: 'credential-shaped' };
      const prov = b.provenance && typeof b.provenance === 'object' ? Object.fromEntries(Object.entries(b.provenance).filter(([k, v]) => ['screen', 'call', 'file', 'path', 'query'].includes(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 300)])) : undefined;
      if (prov && credentialShaped(Object.values(prov).join(' '))) return { ok: false, error: 'credential-shaped' };
      wz.values[n.param] = { value: b.value, source: b.source, ...(b.user ? { user: str(b.user, 100) } : {}), ...(prov ? { provenance: prov } : {}) };
      delete wz.missing[n.param];
      return { ok: true };
    },
    missing(r, b) {
      const n = need(b.param);
      if (!n) return { ok: false, error: 'unknown-param' };
      wz.missing[n.param] = { hint: str(b.hint) };
      return { ok: true };
    },
    gate(r, b) {
      if (!['captcha', 'otp', 'other'].includes(b.kind)) return { ok: false, error: 'bad-gate' };
      r.gate = { kind: b.kind, text: str(b.text) };
      return { ok: true };
    },
    proposal(r, b) {
      if (r.proposal || r.refused) return { ok: false, error: 'one-proposal-per-run' };
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length || items.length > MAX_PROPOSAL_ITEMS || !items.every(i => i && typeof i.what === 'string' && i.what.trim() && typeof i.screen === 'string' && i.screen.trim())) {
        return { ok: false, error: 'bad-items', message: `items must be 1-${MAX_PROPOSAL_ITEMS} entries of {what, screen}` };
      }
      const list = items.map(i => ({ what: str(i.what, 200), screen: str(i.screen, 200) }));
      // Q21: only an environment explicitly marked non-production (boolean true) may get data created.
      const file = `environments/${wz.env}.json`;
      let envJson = null;
      try { envJson = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch { envJson = null; }
      if (!envJson || envJson.nonProduction !== true) {
        r.refused = { env: wz.env, field: 'nonProduction', file, items: list };
        state.log(`wizard: refused a data-creation proposal — ${file} is not marked "nonProduction": true`);
        return { ok: false, error: 'refused', field: 'nonProduction', file,
          message: `creating data is off for "${wz.env}": this environment is not marked non-production — the tester can add "nonProduction": true to ${file}; never edit it yourself. Collecting existing values still works.` };
      }
      r.proposal = { id: `p-${r.runId}`, items: list, decided: false };
      return { ok: true, proposalId: r.proposal.id };
    },
    created(r, b) {
      const p = r.proposal;
      const idx = Number(b.index);
      const ok = p && p.id === b.proposalId && p.decision === 'yes' && Number.isInteger(idx) && idx >= 0 && idx < p.items.length && !r.created.some(c => c.index === idx);
      if (!ok) {
        const what = str(b.what, 200) || (p && Number.isInteger(idx) && p.items[idx] ? p.items[idx].what : `#${b.index}`);
        r.violations.push({ what, at: new Date().toISOString() });
        state.log(`wizard: VIOLATION — the agent reported creating "${what}", which is not on the consented list`);
        return { ok: false, error: 'not-consented' };
      }
      r.created.push({ index: idx, what: p.items[idx].what });
      if (r.consent) r.consent.created.push(idx);
      return { ok: true };
    },
    ended(r, b) {
      r.status = 'ended'; r.gate = null;
      r.found = Number.isFinite(Number(b.found)) ? Number(b.found) : undefined;
      r.total = Number.isFinite(Number(b.total)) ? Number(b.total) : undefined;
      return { ok: true };
    },
    failed(r, b) {
      r.status = 'failed'; r.gate = null; r.reason = str(b.reason) || 'unknown';
      return { ok: true };
    },
  };
  route('POST', '/api/agent/event', 'control', async (req) => {
    // {event: <kind>, payload: {...}} — the payload may carry its own "kind" (a gate's kind).
    const body = await U.readJSON(req);
    const b = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const handler = Object.prototype.hasOwnProperty.call(agentEvents, body.event) ? agentEvents[body.event] : null;
    if (!handler) return { status: 400, body: { ok: false, error: 'unknown-kind' } };
    const r = current();
    if (!r || b.runId !== r.runId) return { status: 409, body: { ok: false, error: 'stale-run', runId: r ? r.runId : null } };
    const out = handler(r, b);
    return { status: out.ok || out.error === 'refused' || out.error === 'not-consented' ? 200 : 400, body: out };
  });
  // The bridge hands the captured token over loopback; it is held in memory until approval and
  // never appears in any response.
  route('POST', '/api/agent/token', 'control', async (req) => {
    const b = await U.readJSON(req);
    if (typeof b.token !== 'string' || !b.token || b.token.length > 16384) return { status: 400, body: { ok: false, error: 'bad-token' } };
    const scheme = b.scheme === 'apiKey' ? 'apiKey' : 'bearer';
    let apiOrigin = null;
    try { apiOrigin = typeof b.apiOrigin === 'string' && /^https?:\/\//i.test(b.apiOrigin) ? new URL(b.apiOrigin).origin : null; } catch { apiOrigin = null; }
    wz.token = { value: b.token, scheme, headerName: typeof b.headerName === 'string' ? b.headerName.slice(0, 100) : (scheme === 'bearer' ? 'Authorization' : 'X-API-Key'),
      user: typeof b.user === 'string' && b.user ? b.user.slice(0, 100) : wz.user, capturedAt: new Date().toISOString(), apiOrigin };
    state.log('wizard: a session token was handed over (value not shown)');
    return { body: { ok: true } };
  });
}

module.exports = { mount, freshWizard, suggestBaseUrl, coerceTyped };
