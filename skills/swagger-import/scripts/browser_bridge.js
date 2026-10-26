#!/usr/bin/env node
'use strict';
// AgenTeX suite wizard — the browser bridge. Composes `playwright-cli run-code` for the things
// the agent must never do with its own hands: read a session token off the app's own requests
// and hand it over. The agent drives everything else in the browser itself (login form,
// navigation, landmarks) with playwright-cli. A password declared { "envSecret": NAME } — the
// standard form — is typed by browser-driver's fill_secret.js, the plugin's one way to type a
// secret; the bridge only names that call. It types a legacy plain-string password itself.
//
//   capture --session <s> --api-origin <o> (--goto <url> | --click <locator>) [--wait-ms 2500]
//           (--to-studio | --store <suite> --env <e> --user <u>) [--header-name <h>]
//       Records the requests the APP makes to <o> around one navigation or click, and their
//       responses. The browser posts them to a single-use loopback sink this script opens; the
//       script then prints the calls REDACTED (headers dropped; secret-named keys, JWT-shaped
//       strings and the token value replaced by "[redacted]"). A token seen on those requests
//       (Authorization: Bearer …, or the apiKey header) goes to the open studio (--to-studio,
//       held in memory until the wizard's approval) or straight to
//       test/.auth/api-tokens/<suite>-<env>.json (--store, mode 0600). Its value is never
//       printed. The bridge sends no request of its own to the application.
//   fill-secret --session <s> --locator <loc> --env <e> --user <u> [--submit <locator>]
//       Looks up the user's password field (users.<u>.password, else defaults.password, in
//       environments/<e>.json).
//       - { "envSecret": NAME }: refused before the browser is touched (exit 2,
//         "error":"use-fill-secret"); the result names NAME and the exact fill_secret.js call
//         (--target <loc>, --submit-target <submit> or --submit), which reads the value itself:
//         "command" for a POSIX shell, "commandPowerShell" for PowerShell, both run from the
//         project root ("cwd").
//       - A plain string (legacy; the secret scan warns on it): --submit is required (without
//         it: exit 2, "error":"submit-required", nothing typed). Resolved in this process and
//         served ONCE from an ephemeral 127.0.0.1 listener on a random path; the run-code reads
//         it from there, fills the field and clicks --submit. After the submit, a
//         password field still on screen and non-empty is cleared ("passwordFieldCleared": true)
//         so no later snapshot can print it. The password never appears in a command line, an
//         output or a log.
//   token-status --store <suite> --env <e>      owner and times only, never the value
//   renew --env <e> --user <u> --url <app page> --api-origin <o> (--present <sel> | --absent <sel>)
//         (--to-studio | --store <suite>) [--wait-ms 8000] [--landmark-ms 15000] [--header-name <h>]
//       Resumes the user's saved login HEADLESS, in a browser of its own (the playwright package
//       of the project, through optimize-login's session.js helpers), proves the landmark, takes
//       the token from the app's own API request (answered with anything but 401/403) and hands
//       it over like capture does (--to-studio | --store). The saved-login file is READ ONLY: it
//       is loaded as storageState and never written (no storageState({path}) call, no
//       resumeSession). File: the exact login_state.js statePathFor(env, user) when it exists,
//       else the newest test/.auth/*-state.json whose name (split on - _ .) carries both the
//       environment and the user key. A miss exits 0 with renewed:false and a reason, so the
//       ladder goes on; exit 2: usage, unknown-user, user-disabled, not-ignored, no-studio.
//       Output: never a token, cookie or storage value.
//
// Common: [--project <root>] (default: the current directory).
// The playwright-cli used: $AGENTEX_PLAYWRIGHT_CLI (a path; .js files run with node) → the
// project's node_modules/@playwright/cli (this folder or a parent) → `playwright-cli` on PATH.
// Prints ONE JSON line. Exit 0 ok · 1 the browser step failed · 2 usage / refused.
// WP0 spike (design): run-code has no global fetch, so the loopback calls use page.request;
// page.on listeners do not outlive one run-code call; the CLI echoes the code it ran.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const D = require(path.join(__dirname, '..', '..', 'endpoint-testing', 'scripts', 'studio', 'data_store.js'));
const channel = require(path.join(__dirname, '..', '..', 'endpoint-testing', 'scripts', 'studio', 'channel.js'));
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const MAX_CALLS = 50;            // captured calls per capture (Q8)
const MAX_BODY = 64 * 1024;      // bytes kept per request/response body (Q8)
const DEFAULT_WAIT_MS = 2500;    // (Q8)
const CLI_TIMEOUT_MS = 90 * 1000;
const SUBMIT_SETTLE_MS = 2000;   // after --submit, before checking for a still-filled password field
const SECRET_KEY_RE = /token|secret|passw|authori|cookie|session|otp/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const ALWAYS_SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

const emit = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };

// ---- playwright-cli resolution ----
function findCli(root) {
  const env = process.env.AGENTEX_PLAYWRIGHT_CLI;
  if (env) return /\.[cm]?js$/.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] };
  for (let d = path.resolve(root); ; d = path.dirname(d)) {
    const dir = path.join(d, 'node_modules', '@playwright', 'cli');
    try {
      const bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
      const rel = typeof bin === 'string' ? bin : bin && bin['playwright-cli'];
      if (rel && fs.existsSync(path.join(dir, rel))) return { cmd: process.execPath, pre: [path.join(dir, rel)] };
    } catch { /* not here */ }
    if (path.dirname(d) === d) break;
  }
  return { cmd: process.platform === 'win32' ? 'playwright-cli.cmd' : 'playwright-cli', pre: [] };
}
function runCli(root, session, code) {
  const cli = findCli(root);
  return new Promise(resolve => {
    let out = '';
    let child;
    try {
      child = spawn(cli.cmd, [...cli.pre, `-s=${session}`, 'run-code', code], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve({ status: null, output: e.message }); return; }
    const t = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
    child.stdout.on('data', d => { if (out.length < 200000) out += d; });
    child.stderr.on('data', d => { if (out.length < 200000) out += d; });
    child.on('error', e => { clearTimeout(t); resolve({ status: null, output: e.message }); });
    child.on('close', status => { clearTimeout(t); resolve({ status, output: out }); });
  });
}

// ---- single-use loopback endpoints ----
function listenOnce(handler) {
  return new Promise((resolve, reject) => {
    const secretPath = `/${crypto.randomBytes(16).toString('hex')}`;
    let used = false;
    const srv = http.createServer((req, res) => {
      if (used || req.url !== secretPath) { res.writeHead(404); res.end(); return; }
      used = true;
      handler(req, res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}${secretPath}`, srv,
      used: () => used, close: () => { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); },
    }));
  });
}
// Serves `secret` to the first GET on a random path, then 404 for everything.
function serveOnce(secret) {
  return listenOnce((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(secret);
  });
}
// Accepts one POSTed JSON body (the captured calls).
async function sinkOnce(maxBytes) {
  let resolveBody;
  const body = new Promise(r => (resolveBody = r));
  const h = await listenOnce((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= maxBytes) chunks.push(c); });
    req.on('end', () => { res.writeHead(204); res.end(); resolveBody(Buffer.concat(chunks).toString('utf8')); });
  });
  return { ...h, body };
}

// ---- redaction ----
function redactString(s, secrets) {
  let out = String(s);
  for (const v of [...secrets].filter(x => x && x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join('[redacted]');
  return out.replace(JWT_RE, '[redacted]');
}
function redactJson(v, secrets) {
  if (Array.isArray(v)) return v.map(x => redactJson(x, secrets));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactJson(x, secrets);
    return o;
  }
  return typeof v === 'string' ? redactString(v, secrets) : v;
}
// application/x-www-form-urlencoded: `k=v&k2=v2`, no whitespace. Secret-named keys (same rule
// as JSON keys, after decoding: "user%5Bpassword%5D" is user[password]) get "[redacted]".
const FORM_RE = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]*(?:=[^&\s]*)?)*$/;
function redactForm(text, secrets) {
  const out = text.split('&').map(pair => {
    const at = pair.indexOf('=');
    if (at === -1) return pair;
    let key = pair.slice(0, at);
    try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    return SECRET_KEY_RE.test(key) ? `${pair.slice(0, at)}=[redacted]` : pair;
  }).join('&');
  return redactString(out, secrets);
}
function redactBody(text, secrets) {
  if (typeof text !== 'string' || !text) return text || undefined;
  try { return redactJson(JSON.parse(text), secrets); } catch { /* not JSON */ }
  return FORM_RE.test(text) ? redactForm(text, secrets) : redactString(text, secrets);
}
function redactUrl(u, secrets) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (SECRET_KEY_RE.test(k)) url.searchParams.set(k, '[redacted]');
    return redactString(url.toString(), secrets);
  } catch { return redactString(u, secrets); }
}
// The calls as the agent may see them: no headers at all, bodies and URLs redacted.
function redactCalls(calls, { secrets = [], headerNames = [] } = {}) {
  const all = new Set(secrets);
  const secretHeaders = new Set([...ALWAYS_SECRET_HEADERS, ...headerNames.map(h => h.toLowerCase())]);
  for (const c of calls) for (const [k, v] of Object.entries(c.headers || {})) {
    if (!secretHeaders.has(k.toLowerCase())) continue;
    all.add(String(v));
    const m = /^\s*\S+\s+(.+)$/.exec(String(v)); // "Bearer <x>" / "Basic <x>"
    if (m) all.add(m[1]);
  }
  return calls.map(c => ({
    method: c.method, url: redactUrl(c.url || '', all), status: c.status,
    ...(c.body ? { requestBody: redactBody(c.body, all) } : {}),
    ...(c.response ? { responseBody: redactBody(c.response, all) } : {}),
  }));
}
// The newest token on the app's own API calls: Bearer, else the apiKey header.
function findToken(calls, headerName) {
  const apiHeader = (headerName || 'x-api-key').toLowerCase();
  for (const c of [...calls].reverse()) {
    const h = Object.fromEntries(Object.entries(c.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h.authorization || '');
    if (m) return { scheme: 'bearer', headerName: 'Authorization', token: m[1] };
    if (h[apiHeader]) return { scheme: 'apiKey', headerName: headerName || 'X-API-Key', token: h[apiHeader] };
  }
  return null;
}

// ---- composed run-code (one line; never carries a secret) ----
function captureCode({ apiOrigin, sinkUrl, goto, click, waitMs }) {
  const action = goto ? `await page.goto(${JSON.stringify(goto)}, { waitUntil: 'load' });` : `await page.locator(${JSON.stringify(click)}).first().click();`;
  return `async (page) => { const origin = ${JSON.stringify(apiOrigin)}; const sink = ${JSON.stringify(sinkUrl)}; const calls = []; const pend = []; `
    + `const onReq = (q) => { if (!q.url().startsWith(origin) || calls.length >= ${MAX_CALLS}) return; const c = { method: q.method(), url: q.url(), body: (q.postData() || '').slice(0, ${MAX_BODY}) }; calls.push(c); pend.push(q.allHeaders().then((h) => { c.headers = h; }, () => {})); }; `
    + `const onRes = (r) => { const c = calls.find((x) => x.url === r.url() && x.status === undefined); if (!c) return; c.status = r.status(); pend.push(r.text().then((t) => { c.response = t.slice(0, ${MAX_BODY}); }, () => {})); }; `
    + `page.on('request', onReq); page.on('response', onRes); try { ${action} await page.waitForTimeout(${waitMs}); await Promise.all(pend); } finally { page.off('request', onReq); page.off('response', onRes); } `
    + `await page.request.post(sink, { data: JSON.stringify(calls) }); return 'captured ' + calls.length; }`;
}
// After --submit, a password field still on screen and non-empty (wrong password, a same-page
// captcha/OTP step) is cleared in the browser, so the agent's next snapshot cannot print it.
// The value is only compared inside the page; it never leaves it. A re-rendered form that
// shows the password in a non-password input is cleared too (value equals the password).
function fillCode({ handleUrl, locator, submit }) {
  const loc = JSON.stringify(locator);
  const clear = `await page.waitForLoadState('load').catch(() => {}); await page.waitForTimeout(${SUBMIT_SETTLE_MS}); `
    + `const fields = [page.locator(${loc}).first()]; const all = page.locator('input[type=password]'); const n = await all.count().catch(() => 0); for (let i = 0; i < n; i++) fields.push(all.nth(i)); `
    + `let cleared = false, left = false; for (const f of fields) { if (!(await f.count().catch(() => 0))) continue; if (!(await f.inputValue().catch(() => ''))) continue; await f.fill('').catch(() => {}); if (await f.inputValue().catch(() => '')) left = true; else cleared = true; } `
    + `const any = page.locator('input, textarea'); const m = await any.count().catch(() => 0); for (let i = 0; i < m; i++) { const f = any.nth(i); try { if ((await f.inputValue()) === pw) { await f.fill(''); cleared = true; } } catch (e) {} } `
    + `return left ? 'filled-left' : cleared ? 'filled-cleared' : 'filled'; }`;
  return `async (page) => { const r = await page.request.get(${JSON.stringify(handleUrl)}); if (!r.ok()) return 'handle-refused'; `
    + `const pw = await r.text(); await page.locator(${loc}).first().fill(pw); `
    + (submit ? `await page.locator(${JSON.stringify(submit)}).first().click(); ${clear}` : `return 'filled'; }`);
}

// The user's password: { envVar } for an { "envSecret": NAME } field (never resolved here —
// fill_secret.js reads it), { value } for a plain string, else { error }.
function userPassword(root, envName, user) {
  const file = path.join(root, 'environments', `${envName}.json`);
  let env;
  try { env = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: `environments/${envName}.json not found or not valid JSON` }; }
  const u = env.users && env.users[user];
  if (!u) return { error: `user "${user}" is not in environments/${envName}.json` };
  const field = u.password !== undefined ? u.password : (env.defaults || {}).password;
  if (field && typeof field === 'object' && typeof field.envSecret === 'string' && field.envSecret.trim()) return { envVar: field.envSecret.trim() };
  const value = pc.resolveSecret(root, field);
  if (!value) return { error: `no password for user "${user}": set users.${user}.password or defaults.password in environments/${envName}.json (an { "envSecret": NAME } field reads .env)` };
  return { value };
}

// browser-driver's fill_secret.js call for an { envSecret } password, as one shell line in two
// quotings: POSIX sh (bash, zsh) and PowerShell. It carries the variable NAME and locators only,
// never a value. fill_secret.js reads .env and the environment from its working directory, so
// the call runs from the project root. (Windows PowerShell 5.1 drops a double quote inside an
// argument passed to a native program; PowerShell 7.3+ passes it through.)
const FILL_SECRET = path.join(__dirname, '..', '..', 'browser-driver', 'scripts', 'fill_secret.js');
const shq = s => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const psq = s => (/^[A-Za-z0-9_.\/\\:=%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "''")}'`);
const fillSecretArgv = ({ session, locator, envVar, env, submit }) =>
  ['node', FILL_SECRET, '--session', session, '--target', locator, '--env-var', envVar, '--env', env,
    ...(submit ? ['--submit-target', submit] : ['--submit'])];
const fillSecretCommand = o => fillSecretArgv(o).map(shq).join(' ');
const fillSecretCommandPowerShell = o => fillSecretArgv(o).map(psq).join(' ');

// ---- renew: headless resume of the user's saved login; the state file is read only ----
const tokensOf = s => String(s).toLowerCase().split(/[-_.]/).filter(Boolean);
function findRun(hay, needle) { // every start index where needle's tokens occur contiguously in hay's
  const at = [];
  if (!needle.length) return at;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, k) => hay[i + k] === t)) at.push(i);
  return at;
}
function carriesBoth(name, env, user) {
  const hay = tokensOf(name); const e = tokensOf(env); const u = tokensOf(user);
  return findRun(hay, e).some(i => findRun(hay, u).some(j => j + u.length <= i || i + e.length <= j));
}
// The user's own saved login: the exact login_state.js name first, else the name rule (newest wins).
function pickStateFile(root, env, user) {
  const { statePathFor } = require(path.join(__dirname, '..', '..', 'browser-driver', 'scripts', 'login_state.js'));
  const exact = statePathFor(env, user);
  try { if (fs.statSync(path.join(root, exact)).isFile()) return exact; } catch { /* fall back */ }
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'test', '.auth')); } catch { return null; }
  let best = null;
  for (const n of names) {
    if (!/-state\.json$/i.test(n) || !carriesBoth(n.replace(/-state\.json$/i, ''), env, user)) continue;
    let st; try { st = fs.statSync(path.join(root, 'test', '.auth', n)); } catch { continue; }
    if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { rel: `test/.auth/${n}`, m: st.mtimeMs };
  }
  return best && best.rel;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function renew(root, args) {
  const opt = k => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const all = k => args.reduce((a, x, i) => (x === k && args[i + 1] !== undefined ? [...a, args[i + 1]] : a), []);
  const env = opt('--env'), user = opt('--user'), url = opt('--url'), apiOrigin = opt('--api-origin'), store = opt('--store'), headerName = opt('--header-name');
  const toStudio = args.includes('--to-studio');
  const present = all('--present')[0], absent = all('--absent')[0];
  const num = (k, d) => { const n = parseInt(opt(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  const waitMs = num('--wait-ms', 8000), landmarkMs = num('--landmark-ms', 15000);
  if (!env || !user || !url || !/^https?:\/\//i.test(url) || !apiOrigin || !/^https?:\/\//i.test(apiOrigin) || (!present && !absent) || toStudio === !!store) {
    return emit({ ok: false, error: 'usage', message: 'renew --env <e> --user <u> --url <app page> --api-origin <o> (--present <sel> | --absent <sel>) (--to-studio | --store <suite>) [--wait-ms n]' }, 2);
  }
  let envJson;
  try { envJson = JSON.parse(fs.readFileSync(path.join(root, 'environments', `${env}.json`), 'utf8')); } catch { envJson = null; }
  const u = envJson && envJson.users && Object.prototype.hasOwnProperty.call(envJson.users, user) ? envJson.users[user] : undefined;
  if (u === undefined) return emit({ ok: false, error: 'unknown-user', user, message: `user "${user}" is not in environments/${env}.json` }, 2);
  if (u && u.disabled) return emit({ ok: false, error: 'user-disabled', user, reason: typeof u.disabled === 'string' ? u.disabled : '', message: `user "${user}" is marked disabled in environments/${env}.json; pick another user` }, 2);
  let sess = null;
  if (toStudio) {
    sess = channel.readSession(root);
    if (!sess) return emit({ ok: false, error: 'no-studio', message: 'no studio is running for this project — use --store outside the wizard' }, 2);
  } else {
    let rel;
    try { rel = D.tokenRel(store, env); } catch (e) { return emit({ ok: false, error: 'usage', message: e.message }, 2); }
    if (!D.isIgnored(root, rel)) return emit({ ok: false, error: 'not-ignored', path: rel, message: `${rel} is not in .gitignore, so no token was stored — run /update-agentex to fix .gitignore` }, 2);
  }
  const miss = (reason, extra = {}) => emit({ ok: true, renewed: false, reason, stateFile: extra.stateFile || null, ageDays: extra.ageDays === undefined ? null : extra.ageDays, token: { seen: !!extra.seen, delivered: null }, ...(extra.detail ? { detail: extra.detail } : {}) }, 0);

  const rel = pickStateFile(root, env, user);
  if (!rel) return miss('no-state-file');
  const abs = path.join(root, rel);
  let ageDays = null;
  try { ageDays = +((Date.now() - fs.statSync(abs).mtimeMs) / 86400000).toFixed(1); } catch { /* keep null */ }
  const info = { stateFile: rel, ageDays };

  const S = require(path.join(__dirname, '..', '..', 'optimize-login', 'scripts', 'session.js'));
  let pw;
  try { pw = S.loadPlaywright(root); } catch { return miss('playwright-missing', info); }
  let browser;
  try { browser = await pw.chromium.launch(S.launchOptions({})); } catch (e) { return miss('browser-failed', { ...info, detail: redactString(String((e && e.message) || e).split('\n')[0].slice(0, 200), []) }); }
  const calls = []; const pend = []; let landmarkOk = false; let found = null;
  try {
    const context = await browser.newContext({ storageState: abs, viewport: { width: 1500, height: 1000 } });
    const track = new Map();
    context.on('request', q => {
      if (!String(q.url()).startsWith(apiOrigin) || calls.length >= MAX_CALLS) return;
      const c = { url: q.url() }; calls.push(c); track.set(q, c);
      pend.push(Promise.resolve(q.allHeaders()).then(h => { c.headers = h; }, () => {}));
    });
    context.on('response', r => { const c = track.get(r.request()); if (c) c.status = r.status(); });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    landmarkOk = await S.isAuthenticated(page, { present, absent }, landmarkMs);
    if (landmarkOk) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        await Promise.all(pend);
        found = findToken(calls.filter(c => c.status !== undefined && c.status !== 401 && c.status !== 403), headerName);
        if (found || Date.now() >= deadline) break;
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      }
    }
  } catch (e) {
    await browser.close().catch(() => {});
    return miss('browser-failed', { ...info, detail: redactString(String((e && e.message) || e).split('\n')[0].slice(0, 200), []) });
  }
  await browser.close().catch(() => {});
  if (!landmarkOk) return miss('landmark-failed', info);
  if (!found) {
    await Promise.all(pend);
    return miss('no-token', { ...info, seen: !!findToken(calls, headerName) });
  }
  const token = { seen: true, scheme: found.scheme, delivered: null };
  if (toStudio) {
    try {
      const res = await channel.call(sess, 'POST', '/api/agent/token', { token: found.token, scheme: found.scheme, headerName: found.headerName, user, apiOrigin }, 10000);
      token.delivered = res.json && res.json.ok ? 'studio' : null;
      if (!token.delivered) token.error = (res.json && res.json.error) || 'refused';
    } catch { token.error = 'no-studio'; }
  } else {
    const w = D.writeToken(root, { store, environment: env, user, scheme: found.scheme, headerName: found.headerName, token: found.token });
    if (w.ok) { token.delivered = 'store'; token.ref = w.ref; } else { token.error = w.error; }
  }
  const renewed = token.delivered !== null;
  return emit({ ok: true, renewed, ...(renewed ? {} : { reason: 'delivery-failed' }), ...info, token }, 0);
}

async function main(argv) {
  const args = argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const has = k => args.includes(k);
  const root = path.resolve(opt('--project') || process.cwd());
  const cmd = args[0];

  if (cmd === 'token-status') {
    const store = opt('--store'), env = opt('--env');
    if (!store || !env) return emit({ ok: false, error: 'usage', message: 'token-status --store <suite> --env <e>' }, 2);
    let meta;
    try { meta = D.readTokenMeta(root, store, env); } catch (e) { return emit({ ok: false, error: 'usage', message: e.message }, 2); }
    if (!meta) return emit({ ok: true, present: false, ref: `${store}-${env}` }, 0);
    return emit({ ok: true, present: true, ...meta, expired: !!(meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) }, 0);
  }

  if (cmd === 'fill-secret') {
    const session = opt('--session'), locator = opt('--locator'), env = opt('--env'), user = opt('--user'), submit = opt('--submit');
    if (!session || !locator || !env || !user) return emit({ ok: false, error: 'usage', message: 'fill-secret --session <s> --locator <loc> --env <e> --user <u> [--submit <locator>]' }, 2);
    const pw = userPassword(root, env, user);
    if (pw.error) return emit({ ok: false, error: 'no-password', message: pw.error }, 2);
    if (pw.envVar) {
      const call = { session, locator, envVar: pw.envVar, env, submit };
      return emit({ ok: false, error: 'use-fill-secret', user, envVar: pw.envVar, cwd: root,
        command: fillSecretCommand(call), commandPowerShell: fillSecretCommandPowerShell(call),
        message: `the password of "${user}" is { "envSecret": "${pw.envVar}" }: type it with browser-driver's fill_secret.js. Run it from the project root (${root}), exactly as given: "command" in a POSIX shell (bash, zsh), "commandPowerShell" in PowerShell. It reads the value itself and submits in the same call; nothing was typed` }, 2);
    }
    if (!submit) {
      return emit({ ok: false, error: 'submit-required', user,
        message: `a plain-string password is typed only together with its submit: add --submit <submit button> (the locator of the form's sign-in button) so the field is submitted, and cleared if it stays filled, in the same call; nothing was typed` }, 2);
    }
    const handle = await serveOnce(pw.value);
    const r = await runCli(root, session, fillCode({ handleUrl: handle.url, locator, submit }));
    const used = handle.used();
    handle.close();
    const m = /"filled(-cleared|-left)?"/.exec(r.output);
    if (!used || !m) {
      return emit({ ok: false, error: 'not-filled', message: `the password field was not filled (playwright-cli exit ${r.status})`, detail: redactString(r.output.slice(-400), [pw.value]) }, 1);
    }
    if (m[1] === '-cleared') {
      return emit({ ok: true, filled: true, submitted: true, user, passwordFieldCleared: true,
        message: 'a password field was still filled after submit (wrong password, or a captcha/OTP on the same page) and has been cleared; to try again, re-fill it with fill-secret' }, 0);
    }
    if (m[1] === '-left') {
      return emit({ ok: true, filled: true, submitted: true, user, passwordFieldCleared: false, passwordFieldStillFilled: true,
        message: 'a password field is still filled after submit and could not be cleared: take no snapshot of this page; close the session and post failed' }, 0);
    }
    return emit({ ok: true, filled: true, submitted: true, user, passwordFieldCleared: false }, 0);
  }

  if (cmd === 'renew') return renew(root, args);

  if (cmd === 'capture') {
    const session = opt('--session'), apiOrigin = opt('--api-origin'), goto = opt('--goto'), click = opt('--click');
    const waitRaw = parseInt(opt('--wait-ms'), 10);
    const waitMs = Number.isFinite(waitRaw) && waitRaw >= 0 ? waitRaw : DEFAULT_WAIT_MS;
    const toStudio = has('--to-studio');
    const store = opt('--store'), env = opt('--env'), user = opt('--user'), headerName = opt('--header-name');
    if (!session || !apiOrigin || !/^https?:\/\//i.test(apiOrigin) || (!goto) === (!click) || toStudio === !!store || (store && (!env || !user))) {
      return emit({ ok: false, error: 'usage', message: 'capture --session <s> --api-origin <o> (--goto <url> | --click <locator>) [--wait-ms n] (--to-studio | --store <suite> --env <e> --user <u>)' }, 2);
    }
    let sess = null;
    if (toStudio) {
      sess = channel.readSession(root);
      if (!sess) return emit({ ok: false, error: 'no-studio', message: 'no studio is running for this project — use --store outside the wizard' }, 2);
    } else {
      let rel;
      try { rel = D.tokenRel(store, env); } catch (e) { return emit({ ok: false, error: 'usage', message: e.message }, 2); }
      if (!D.isIgnored(root, rel)) return emit({ ok: false, error: 'not-ignored', path: rel, message: `${rel} is not in .gitignore, so the token was not captured — run /update-agentex to fix .gitignore` }, 2);
    }
    const sink = await sinkOnce(MAX_CALLS * MAX_BODY * 2 + 65536);
    const r = await runCli(root, session, captureCode({ apiOrigin, sinkUrl: sink.url, goto, click, waitMs }));
    const received = sink.used() ? await Promise.race([sink.body, new Promise(res => setTimeout(() => res(null), 2000))]) : null;
    sink.close();
    if (received === null) return emit({ ok: false, error: 'browser-failed', message: `the capture did not complete (playwright-cli exit ${r.status})`, detail: redactString(r.output.slice(-400), []) }, 1);
    let calls;
    try { calls = JSON.parse(received); if (!Array.isArray(calls)) throw new Error('not a list'); } catch (e) { return emit({ ok: false, error: 'browser-failed', message: `unreadable capture: ${e.message}` }, 1); }
    const found = findToken(calls, headerName);
    const redacted = redactCalls(calls, { secrets: found ? [found.token] : [], headerNames: headerName ? [headerName] : [] });
    const token = { seen: !!found };
    if (found) {
      token.scheme = found.scheme;
      if (toStudio) {
        try {
          const res = await channel.call(sess, 'POST', '/api/agent/token', { token: found.token, scheme: found.scheme, headerName: found.headerName, user: user || undefined, apiOrigin }, 10000);
          token.delivered = res.json && res.json.ok ? 'studio' : null;
          if (!token.delivered) token.error = (res.json && res.json.error) || 'refused';
        } catch (e) { token.delivered = null; token.error = 'no-studio'; }
      } else {
        const w = D.writeToken(root, { store, environment: env, user, scheme: found.scheme, headerName: found.headerName, token: found.token });
        if (w.ok) { token.delivered = 'store'; token.ref = w.ref; } else { token.delivered = null; token.error = w.error; token.path = w.path; }
      }
    }
    return emit({ ok: true, apiOrigin, callCount: calls.length, truncated: calls.length >= MAX_CALLS, calls: redacted, token }, 0);
  }

  return emit({ ok: false, error: 'usage', message: 'usage: browser_bridge.js capture … | fill-secret … | token-status … | renew …' }, 2);
}

if (require.main === module) main(process.argv);
module.exports = { pickStateFile, carriesBoth, serveOnce, sinkOnce, redactCalls, redactString, findToken, captureCode, fillCode, findCli, userPassword, fillSecretCommand, fillSecretCommandPowerShell, psq };
