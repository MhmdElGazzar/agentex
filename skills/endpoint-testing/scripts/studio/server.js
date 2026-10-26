#!/usr/bin/env node
'use strict';
// AgenTeX suite studio — one loopback server for two pages:
//   /editor  the API suite editor (suites under integration/api_test_suites/, Save, Run)
//   /wizard  "New suite from Swagger" (steps 1, 2, 4, 5 on the server; step 3 through the agent)
//
// Usage: node server.js [projectRoot] [--mode editor|wizard] [--suite <path>] [--spec <source>]
//          [--port=7380] [--no-open] [--lang=ar|en]
// Prints ONE JSON line on stdout: {"ok":true,"url":...,"port":...,"mode":...} (or ok:false with
// "error": "port-in-use" | "already-running" | ...), plus "[studio] running at <url>" on stderr.
//
// Rules (design: swagger-suite-wizard):
//   - binds 127.0.0.1 only; every /api/* call needs the page token (x-studio-token) or the
//     agent's control token (x-studio-control); no CORS header; the page loads nothing external;
//   - the page never drives the agent: the agent opts in through channel.js (a bounded
//     long-poll); without an attached agent, step 3 says to ask in chat;
//   - nothing is written in the project before the wizard's one approval; a run always matches
//     the file on disk; Save is a hash-checked merge (suite_store.js);
//   - runs go only through run_suite.js → run_api.js, with the same evidence as /test-endpoints;
//   - no response ever carries a token value or a password.
// Session file (outside the project, so the wizard writes nothing before approval):
//   <os.tmpdir()>/agentex-studio/<sha1(projectRoot)[0..12]>.json, mode 0600,
//   {port, controlToken, pid, projectRoot, startedAt}; removed on /api/done, SIGINT and idle.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const U = require('./http_util.js');
const S = require('./suite_store.js');
const D = require('./data_store.js');
const VIEW = require('./studio_view.js');
const W = require('../write_result.js');
const pc = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const DEFAULT_PORT = 7380;                 // (Q8)
const IDLE_MS = 120 * 60 * 1000;           // shut down after 120 min without a request (Q8)
const RUN_SUITE = path.join(__dirname, '..', 'run_suite.js');
const HTML = path.join(__dirname, 'studio.html');
const STRINGS = path.join(__dirname, 'strings.json');

function sessionFile(root) {
  const id = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'agentex-studio', `${id}.json`);
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Local time, YYYY-MM-DD_HH-MM-SS: the same name init_run.js gives /test-endpoints run folders.
const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function envList(root) {
  let def = null;
  try { def = pc.loadProjectConfig(root).defaultEnvironment || null; } catch { def = null; }
  const environments = pc.listEnvironments(root).map(name => {
    let e = {};
    try { e = JSON.parse(fs.readFileSync(path.join(root, 'environments', `${name}.json`), 'utf8')) || {}; } catch { e = {}; }
    const users = e.users && typeof e.users === 'object' ? e.users : {};
    // N1: "disabled": "<reason>" on users.<name> (true is accepted, with no reason) marks a user
    // the wizard must never sign in as. `users` stays the plain list of names.
    const disabledOf = u => (u && typeof u.disabled === 'string' && u.disabled.trim() ? u.disabled.trim() : u && u.disabled === true ? '' : null);
    return {
      name,
      portalUrl: typeof e.portalUrl === 'string' ? e.portalUrl : null,
      users: Object.keys(users),
      userInfo: Object.keys(users).map(n => ({ name: n, disabled: disabledOf(users[n]) })),
      nonProduction: e.nonProduction === true,
    };
  });
  return { defaultEnvironment: def, environments };
}

// Catalog requests by entry ("<catalog>.<request>"), read-only: the editor shows method and path
// and knows which params sit in the path (those cannot be left out). Catalogs are never written.
function catalogIndex(root) {
  const out = {};
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(full); }
      else if (e.isFile() && e.name.endsWith('_api.json')) {
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (j && typeof j.name === 'string' && !out[j.name]) out[j.name] = { file: path.relative(root, full).split(path.sep).join('/'), def: j };
        } catch { /* an unreadable catalog is reported BLOCKED by the runner */ }
      }
    }
  };
  walk(path.join(root, 'integration'));
  return out;
}
function endpointsFor(root, cases) {
  const idx = catalogIndex(root);
  const out = {};
  for (const c of cases || []) {
    if (!c || typeof c.entry !== 'string' || out[c.entry]) continue;
    const dot = c.entry.indexOf('.');
    const cat = idx[c.entry.slice(0, dot)];
    const r = cat && (cat.def.requests || []).find(q => q.name === c.entry.slice(dot + 1));
    out[c.entry] = r
      ? { found: true, method: r.method || 'GET', path: r.path || '', params: r.params || [], pathParams: (r.params || []).filter(p => String(r.path || '').includes(`{${p}}`)), catalog: cat.file }
      : { found: false, method: '', path: c.entry, params: [], pathParams: [] };
  }
  return out;
}

// The body of a single-quoted JS string literal in the page script: JSON.stringify escapes " \ and control
// characters, not ' (would end the literal), < (</script>) or U+2028/9 (older line terminators).
const jsStringBody = v => JSON.stringify(String(v || '')).slice(1, -1)
  .replace(/'/g, '\\u0027').replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// Store slug for a suite path: the file name without "_suite.json".
const suiteSlug = rel => path.basename(rel).replace(/_suite\.json$/, '');

function collectedFor(root, rel) {
  let store = null;
  try { store = D.readStore(root, suiteSlug(rel)); } catch { store = null; }
  let token = null;
  if (store && store.token && typeof store.token.ref === 'string') {
    const m = /^(.+)-([^-]+)$/.exec(store.token.ref);
    try { token = m ? D.readTokenMeta(root, m[1], m[2]) : null; } catch { token = null; }
    token = token ? { ...token, source: store.token.source || 'ui' } : { ref: store.token.ref, user: store.token.user || null, source: store.token.source || 'ui', capturedAt: store.token.capturedAt || null, missing: true };
  }
  return {
    values: store && Array.isArray(store.values) ? store.values : [],
    missing: store && Array.isArray(store.missing) ? store.missing : [],
    consents: store && Array.isArray(store.consents) ? store.consents : [],
    token,
    environment: store ? store.environment || null : null,
  };
}

async function createStudio(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const state = {
    root,
    mode: opts.mode === 'wizard' ? 'wizard' : 'editor',
    lang: ['ar', 'en'].includes(opts.lang) ? opts.lang : 'ar',
    pageToken: U.newToken(),
    controlToken: U.newToken(),
    lastRequestAt: Date.now(),
    runs: {},
    activeRun: null,
    runSeq: 0,
    initialSuite: opts.suite || null,
    prefillSpec: opts.spec || '',
    log: opts.log || (m => process.stderr.write(`[studio] ${m}\n`)),
  };
  const routes = []; // {method, path|test, role, handler}
  const route = (method, p, role, handler) => routes.push({ method, p, role, handler });
  const studio = { state, route, root, envList: () => envList(root), startRun, sessionFile: sessionFile(root) };

  // ---- runs (editor; also "Approve and run now") ----
  function startRun({ suite, caseN, env, origin }) {
    if (state.activeRun) return { status: 409, body: { ok: false, error: 'busy' } };
    let loaded;
    try { loaded = S.load(root, suite); } catch (e) { return { status: 400, body: { ok: false, error: 'bad-suite', message: e.message } }; }
    const cases = Array.isArray(loaded.json.cases) ? loaded.json.cases : [];
    if (caseN !== undefined && (caseN < 1 || caseN > cases.length)) return { status: 400, body: { ok: false, error: 'bad-case' } };
    const targets = caseN !== undefined ? [cases[caseN - 1]] : cases;
    const skipped = targets.filter(c => c && c.skip).length;
    const review = targets.filter(S.needsReview).length;
    if (!targets.some(c => c && !c.skip && !S.needsReview(c))) {
      return { status: 200, body: { ok: false, nothing: true, skipped, review } };
    }
    let base = `executions/execu_${stamp()}`;
    for (let n = 2; fs.existsSync(path.join(root, base)); n++) base = `executions/execu_${stamp()}-${n}`;
    const runDir = `${base}/api-tests`;
    fs.mkdirSync(path.join(root, runDir), { recursive: true });
    const id = `run-${++state.runSeq}`;
    const args = [RUN_SUITE, '--catalog', './integration', '--suites', `./${S.SUITES_DIR}`, '--suite', loaded.path,
      ...(caseN !== undefined ? ['--case', String(caseN)] : []), ...(env ? ['--env', env] : []), '--run-dir', runDir];
    const run = { id, status: 'running', suite: loaded.path, case: caseN, env: env || null, runDir, startedAt: new Date().toISOString(), result: null };
    state.runs[id] = run;
    state.activeRun = id;
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.resume(); // the evidence is in run-dir; nothing is relayed
    child.on('close', () => {
      try {
        const resFile = path.join(root, runDir, 'suite-result.json');
        run.result = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        W.writeResult(resFile, path.join(root, runDir, 'result.md'), root, { origin });
      } catch (e) { run.result = { result: 'BLOCKED', reason: `the run left no result: ${e.message}`, cases: [] }; }
      run.status = 'done';
      state.activeRun = null;
    });
    child.on('error', e => { run.status = 'done'; run.result = { result: 'BLOCKED', reason: e.message, cases: [] }; state.activeRun = null; });
    return { status: 200, body: { ok: true, id, runDir } };
  }

  // ---- page + shared routes ----
  route('GET', '/api/strings', 'page', () => ({ body: JSON.parse(fs.readFileSync(STRINGS, 'utf8')) }));
  route('GET', '/api/envs', 'page', () => ({ body: envList(root) }));
  route('GET', '/api/suites', 'page', () => ({ body: { suites: S.listSuites(root), ...envList(root) } }));
  route('GET', '/api/suite', 'page', (req, url) => {
    const rel = url.searchParams.get('path');
    let loaded;
    try { loaded = S.load(root, rel); } catch (e) { return { status: 400, body: { ok: false, error: 'bad-suite', message: e.message } }; }
    return { body: { ok: true, path: loaded.path, json: loaded.json, etag: loaded.etag, canonical: loaded.canonical,
      endpoints: endpointsFor(root, loaded.json.cases), last: S.lastResults(root, loaded.path), collected: collectedFor(root, loaded.path) } };
  });
  // An evidence log of a past run, for the drawer (run_api.js already redacted every credential).
  route('GET', '/api/log', 'page', (req, url) => {
    const rel = url.searchParams.get('path') || '';
    const base = path.join(root, 'executions');
    const full = path.resolve(root, rel);
    if (!full.startsWith(base + path.sep) || !full.endsWith('.log')) return { status: 400, body: { ok: false, error: 'not an evidence log' } };
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { return { status: 404, body: { ok: false, error: 'no-such-log' } }; }
    return { body: { ok: true, path: rel, text: text.slice(0, 64 * 1024) } };
  });
  route('GET', '/api/collected', 'page', (req, url) => {
    const rel = url.searchParams.get('suite');
    try { S.resolveSuite(root, rel); } catch (e) { return { status: 400, body: { ok: false, error: 'bad-suite', message: e.message } }; }
    return { body: { ok: true, ...collectedFor(root, rel) } };
  });
  route('POST', '/api/suite/save', 'page', async (req) => {
    const b = await U.readJSON(req);
    let r;
    try { r = S.save(root, b.path, b.etag, Array.isArray(b.edits) ? b.edits : [], { acceptFormat: b.acceptFormat === true }); }
    catch (e) { return { status: 400, body: { ok: false, error: 'bad-suite', message: e.message } }; }
    if (r.status === 'ok') { state.log(`saved ${b.path}`); return { body: { ok: true, etag: r.etag } }; }
    if (r.status === 'conflict') return { status: 409, body: { ok: false, error: 'conflict' } };
    if (r.status === 'needs-format-consent') return { status: 409, body: { ok: false, error: 'needs-format-consent' } };
    return { status: 400, body: { ok: false, error: 'invalid', message: r.error } };
  });
  route('POST', '/api/run', 'page', async (req) => {
    const b = await U.readJSON(req);
    // A3: a run always matches the file on disk.
    if (b.dirty) return { status: 409, body: { ok: false, error: 'unsaved' } };
    let loaded;
    try { loaded = S.load(root, b.suite); } catch (e) { return { status: 400, body: { ok: false, error: 'bad-suite', message: e.message } }; }
    if (b.etag !== loaded.etag) return { status: 409, body: { ok: false, error: 'stale' } };
    const caseN = b.case !== undefined && b.case !== null ? Number(b.case) : undefined;
    const r = startRun({ suite: loaded.path, caseN, env: typeof b.env === 'string' && b.env ? b.env : undefined });
    return { status: r.status, body: r.body };
  });
  route('GET', /^\/api\/run\/([\w-]+)$/, 'page', (req, url, m) => {
    const run = state.runs[m[1]];
    if (!run) return { status: 404, body: { ok: false, error: 'no-such-run' } };
    return { body: { ok: true, ...run } };
  });
  route('GET', '/api/done', 'page', () => {
    setTimeout(() => shutdown('done'), 200);
    return { body: { ok: true } };
  });

  const closeHooks = [];
  studio.onClose = h => closeHooks.push(h);
  if (typeof opts.mount === 'function') opts.mount(studio);

  // ---- server ----
  const server = http.createServer(async (req, res) => {
    // N12: every route, the HTML pages included, answers only the loopback names on our port.
    if (!U.hostAllowed(req, server.address().port)) return U.forbid(res);
    state.lastRequestAt = Date.now();
    let url;
    try { url = new URL(req.url, `http://${U.HOST}`); } catch { return U.respondJSON(res, 400, { error: 'bad url' }); }
    const method = req.method.toUpperCase();
    if (method === 'GET' && (url.pathname === '/editor' || url.pathname === '/wizard' || url.pathname === '/')) {
      const view = url.pathname === '/' ? state.mode : url.pathname.slice(1);
      const asked = url.searchParams.get('lang');
      const lang = ['ar', 'en'].includes(asked) ? asked : state.lang;
      const html = fs.readFileSync(HTML, 'utf8')
        .replace('__STUDIO_TOKEN__', state.pageToken)
        .replace('__STUDIO_NEEDS_REVIEW__', () => S.needsReview.toString())
        .replace('__STUDIO_VIEW_HELPERS__', () => VIEW.source())
        .replace('__STUDIO_LANG__', lang)
        .replace('__STUDIO_VIEW__', view)
        .replace(/__STUDIO_(SUITE|SPEC)__/g, (_, k) => jsStringBody(k === 'SUITE' ? state.initialSuite : state.prefillSpec)) // one pass: a value never gets re-scanned
        .replace('<html lang="ar" dir="rtl">', `<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`);
      return U.respond(res, 200, 'text/html; charset=utf-8', html);
    }
    if (method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (!url.pathname.startsWith('/api/')) return U.respond(res, 404, 'text/plain; charset=utf-8', 'Not found');
    if (!U.originAllowed(req)) return U.forbid(res);
    const role = U.roleOf(req, { page: state.pageToken, control: state.controlToken });
    if (!role) return U.forbid(res);
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = typeof r.p === 'string' ? (r.p === url.pathname ? [] : null) : r.p.exec(url.pathname);
      if (!m) continue;
      if (r.role !== role) return U.forbid(res);
      try {
        const out = await r.handler(req, url, m, res);
        if (out === undefined) return; // the handler answered (long-poll)
        return U.respondJSON(res, out.status || 200, out.body);
      } catch (e) {
        return U.respondJSON(res, e instanceof SyntaxError ? 400 : 500, { ok: false, error: e instanceof SyntaxError ? 'bad-json' : 'server-error', message: e.message });
      }
    }
    return U.respondJSON(res, 404, { ok: false, error: 'not found' });
  });

  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, U.HOST, () => { server.removeListener('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  const url = `http://${U.HOST}:${actualPort}/${state.mode}${opts.lang ? `?lang=${state.lang}` : ''}`;
  fs.mkdirSync(path.dirname(studio.sessionFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(studio.sessionFile, JSON.stringify({ port: actualPort, controlToken: state.controlToken, pid: process.pid, projectRoot: root, startedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(studio.sessionFile, 0o600);

  const idleMs = opts.idleMs || IDLE_MS;
  const idleTimer = setInterval(() => { if (Date.now() - state.lastRequestAt > idleMs) shutdown('shutdown'); }, Math.min(idleMs, 60000));
  idleTimer.unref();

  let closed = false;
  function shutdown(reason) {
    if (closed) return;
    closed = true;
    for (const h of closeHooks) { try { h(reason); } catch { /* best effort */ } }
    clearInterval(idleTimer);
    try {
      const cur = JSON.parse(fs.readFileSync(studio.sessionFile, 'utf8'));
      if (cur.pid === process.pid && cur.port === actualPort) fs.unlinkSync(studio.sessionFile);
    } catch { /* already gone */ }
    server.close();
    // let the answers just written (closed events to waiting agents) flush first
    const t = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 300);
    t.unref();
    if (opts.onShutdown) opts.onShutdown(reason);
  }
  studio.shutdown = shutdown;
  return { server, port: actualPort, url, state, studio, close: () => shutdown('shutdown') };
}

async function main(argv) {
  const args = argv.slice(2);
  const val = (name) => {
    const eq = args.find(a => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--mode', '--suite', '--spec', '--port', '--lang'].includes(args[i - 1])));
  const root = path.resolve(positional[0] || process.cwd());
  const mode = val('--mode') === 'wizard' ? 'wizard' : 'editor';
  const spec = val('--spec');
  const portRaw = val('--port');
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : DEFAULT_PORT;
  const lang = ['ar', 'en'].includes(val('--lang')) ? val('--lang') : '';
  const emit = o => process.stdout.write(JSON.stringify(o) + '\n');

  const sf = sessionFile(root);
  try {
    const cur = JSON.parse(fs.readFileSync(sf, 'utf8'));
    if (cur && pidAlive(cur.pid) && cur.pid !== process.pid) {
      emit({ ok: false, error: 'already-running', url: `http://${U.HOST}:${cur.port}/${mode}${spec ? `?spec=${encodeURIComponent(spec)}` : ''}`, message: `[studio] already running for this project at http://${U.HOST}:${cur.port}/ — use that page, or close it first` });
      process.exitCode = 1;
      return;
    }
  } catch { /* no session, or a stale one we overwrite */ }

  const wizardMount = require('./wizard.js').mount;
  let st;
  try {
    st = await createStudio({ root, mode, suite: val('--suite'), spec: val('--spec'), port, lang, mount: wizardMount, onShutdown: () => setTimeout(() => process.exit(0), 300) });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const msg = U.portInUseMessage(port);
      process.stderr.write(msg + '\n');
      emit({ ok: false, error: 'port-in-use', message: msg });
    } else emit({ ok: false, error: 'server-error', message: e.message });
    process.exitCode = 1;
    return;
  }
  emit({ ok: true, url: st.url, port: st.port, mode });
  process.stderr.write(`[studio] running at ${st.url}\n`);
  if (!args.includes('--no-open')) U.openBrowser(st.url);
  process.on('SIGINT', () => st.studio.shutdown('shutdown'));
  process.on('SIGTERM', () => st.studio.shutdown('shutdown'));
}

if (require.main === module) main(process.argv);

module.exports = { stamp, createStudio, sessionFile, envList, catalogIndex, endpointsFor, DEFAULT_PORT, IDLE_MS };
