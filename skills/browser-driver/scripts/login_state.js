#!/usr/bin/env node
'use strict';
// AgenTeX saved login for a test run: loads a saved login into the run's own playwright-cli
// session, and saves one after a proven UI login. The login file moves through the driver's
// own `state-load` / `state-save`; this script NEVER reads it, prints it, or passes a value
// from it on a command line. Output is paths and result words only.
//
// Usage (from the consumer project root, like every playwright-cli command of the run):
//   node login_state.js load --session <s> --user <U> [--env <name>] [--url <url> --present <selector>]
//        [--timeout-ms <n>]
//   node login_state.js save --session <s> --user <U> --present <selector> [--env <name>]
//        [--timeout-ms <n>]
//
//   --session  the run's own session name (never "default").
//   --user     a key of `users` in environments/<env>.json.
//   --env      the environment (default: config/project.json defaultEnvironment).
//   --present  the landmark: a selector true ONLY when signed in (an account menu). save records
//              it; load reads it back from the sidecar. Never verify by URL.
//   --url      load only: the page to open and the landmark to check, when no sidecar exists.
//
// The file is test/.auth/<env>-<user>-state.json (statePathFor); its sidecar is
// test/.auth/<env>-<user>-state.meta.json: { schemaVersion, url (origin + path only), landmark,
// savedAt }.
//
// load:  usage, unknown user -> no environment / no file / no landmark (no browser call) ->
//        state-load -> goto -> poll the landmark (15 s). The file is never written or deleted.
// save:  usage, unknown user -> CI or no environment SKIPPED -> test/.auth/ must be gitignored
//        -> landmark must hold on the current page -> state-save to a temp file -> 0600 ->
//        atomic rename -> sidecar.
//
// ONE JSON line, exit 0 / 1 / 2:
//   load  {"result":"RESUME_PASS",...}                                         exit 0
//         {"result":"RESUME_FAIL","reason":no-environment|no-state|no-landmark|cli-unsupported|
//                                          state-unreadable|landmark-failed}   exit 1
//         {"result":"BLOCKED","reason":usage|unknown-user|session-not-open|driver-error,
//                             "infrastructure"?:true}                          exit 2
//   save  {"result":"SAVED",...}                                                exit 0
//         {"result":"SKIPPED","reason":ci-mode|no-environment}                  exit 0
//         {"result":"NOT_AUTHENTICATED"}                                        exit 1
//         {"result":"BLOCKED","reason":usage|unknown-user|not-ignored|cli-unsupported|
//                             session-not-open|driver-error,"infrastructure"?:true}  exit 2
//
// AGENTEX_PWCLI_CMD is the fixture-only test seam fill_secret.js already has (cliCommand()).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
// fill_secret.js redirects process.stdout.write on load (its own redaction); this script's
// one result line must still reach stdout, so the originals are restored right after.
const savedWrites = [process.stdout.write, process.stderr.write];
const { cliCommand } = require('./fill_secret.js');
[process.stdout.write, process.stderr.write] = savedWrites;
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const AUTH_REL = 'test/.auth';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const LOAD_LANDMARK_MS = 15_000;
const SAVE_LANDMARK_MS = 5_000;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const INFRA_RE = /is not open|not running|no such session|ECONNREFUSED|ECONNRESET|has been closed|browser has disconnected|Target closed/i;
const UNSUPPORTED_RE = /unknown (sub)?command|unrecognized (sub)?command|unknown option|not a (known|valid) command|invalid command|did you mean/i;

// ---- the one name ---------------------------------------------------------------------------
const handle = (h) => (HANDLE_RE.test(String(h)) ? String(h) : `u-${crypto.createHash('sha256').update(String(h)).digest('hex').slice(0, 8)}`);
function statePathFor(env, user) { return `${AUTH_REL}/${handle(env)}-${handle(user)}-state.json`; }
const sidecarPathFor = (env, user) => statePathFor(env, user).replace(/\.json$/, '.meta.json');

// ---- output ---------------------------------------------------------------------------------
function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = code;
}
class Done extends Error { constructor(obj, code) { super(obj.result); this.obj = obj; this.code = code; } }
const blocked = (reason, detail, extra = {}) => new Done({ result: 'BLOCKED', reason, detail, ...extra }, 2);
const usage = (msg) => blocked('usage', `${msg} — usage: login_state.js load --session <s> --user <U> [--env <name>] [--url <url> --present <selector>] | save --session <s> --user <U> --present <selector> [--env <name>]`);

// ---- args -----------------------------------------------------------------------------------
function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (verb !== 'load' && verb !== 'save') throw usage('the first argument must be load or save');
  const a = { verb, timeoutMs: DEFAULT_TIMEOUT_MS };
  const value = (i, flag) => {
    if (i >= rest.length || String(rest[i]).startsWith('--')) throw usage(`${flag} needs a value`);
    return String(rest[i]);
  };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (f === '--session') a.session = value(++i, f);
    else if (f === '--user') a.user = value(++i, f);
    else if (f === '--env') a.env = value(++i, f);
    else if (f === '--present') a.present = value(++i, f);
    else if (f === '--url' && verb === 'load') a.url = value(++i, f);
    else if (f === '--timeout-ms') a.timeoutMs = Number(value(++i, f));
    else throw usage(`unknown argument ${JSON.stringify(f).slice(0, 60)}`);
  }
  if (!a.session) throw usage('--session is required');
  if (a.session === 'default' || !SESSION_RE.test(a.session)) throw usage('--session must be the run\'s own session name (letters, digits, . _ -; never "default")');
  if (!a.user || !a.user.trim() || a.user.length > 200) throw usage('--user is required (a key of users in the environment)');
  if (a.env !== undefined && !HANDLE_RE.test(a.env)) throw usage('--env must be an environment name (letters, digits, . _ -)');
  if (a.verb === 'save' && !a.present) throw usage('--present <landmark selector> is required to save');
  if (a.present !== undefined && !a.present.trim()) throw usage('--present must not be empty');
  if (a.url !== undefined && !/^https?:\/\//i.test(a.url)) throw usage('--url must be an http(s) URL');
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0 || a.timeoutMs > MAX_TIMEOUT_MS) throw usage(`--timeout-ms must be a positive number up to ${MAX_TIMEOUT_MS}`);
  return a;
}

// The environment, or null when the project has none (legacy project, or the name is unknown).
function environmentOf(cwd, a) {
  try { return pc.loadEnvironment(cwd, a.env || null); } catch { return null; }
}
function checkUser(environment, user) {
  const users = environment && environment.users && typeof environment.users === 'object' ? environment.users : {};
  if (!Object.prototype.hasOwnProperty.call(users, user)) {
    throw blocked('unknown-user', `user "${user}" is not under users in environments/${environment.name}.json`);
  }
}

// ---- the driver -----------------------------------------------------------------------------
// One CLI call, output never relayed. Returns { status, out }; throws BLOCKED on a hang or when
// the CLI cannot start.
function cli(session, cliArgs, timeoutMs) {
  const { cmd, args, shell } = cliCommand([`-s=${session}`, ...cliArgs]);
  const r = spawnSync(cmd, args, {
    cwd: process.cwd(), env: process.env, shell, encoding: 'utf8', timeout: timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') throw blocked('driver-error', `playwright-cli did not answer within ${timeoutMs}ms — the session may be hung`, { infrastructure: true });
    throw blocked('driver-error', `could not start playwright-cli (${r.error.code || 'spawn error'}) — is @playwright/cli installed in this project?`, { infrastructure: true });
  }
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}`, stdout: r.stdout || '' };
}
const sessionGone = (session, status) => blocked('session-not-open', `session ${session} is not open (playwright-cli exit ${status}) — the browser session is gone`, { infrastructure: true });

// Runs the landmark check in the page: { held, url }.
function landmark(session, selector, waitMs, timeoutMs) {
  const code = `async (page) => {
  let held = false;
  try { await page.locator(${JSON.stringify(selector)}).first().waitFor({ state: 'visible', timeout: ${waitMs} }); held = true; } catch (e) {}
  let url = ''; try { url = page.url(); } catch (e) {}
  return { held, url };
}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ls-'));
  try {
    const file = path.join(dir, 'landmark.js');
    fs.writeFileSync(file, code, { mode: 0o600, flag: 'wx' });
    const r = cli(session, ['run-code', '--raw', `--filename=${file}`], timeoutMs);
    if (r.status !== 0) {
      if (INFRA_RE.test(r.out)) throw sessionGone(session, r.status);
      throw blocked('driver-error', `playwright-cli exited ${r.status} during the landmark check`);
    }
    if (/^### Error/m.test(r.stdout)) {
      if (INFRA_RE.test(r.out)) throw sessionGone(session, r.status);
      throw blocked('driver-error', 'the landmark check raised an error inside the page');
    }
    const t = r.stdout.trim();
    for (const c of [t, ...t.split('\n').reverse()]) {
      if (!c) continue;
      try { const j = JSON.parse(c); if (j && typeof j.held === 'boolean') return { held: j.held, url: String(j.url || '') }; } catch { /* next */ }
    }
    throw blocked('driver-error', 'the landmark check answered without a readable result');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// origin + path only: an OAuth ?code= or a fragment must not land on disk.
function bareUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    return p.origin + p.pathname;
  } catch { return null; }
}

function readSidecar(cwd, env, user) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cwd, sidecarPathFor(env, user)), 'utf8'));
    const url = bareUrl(m && m.url);
    const present = m && m.landmark && typeof m.landmark.present === 'string' ? m.landmark.present : null;
    return url && present ? { url, present } : null;
  } catch { return null; }
}

// ---- load -----------------------------------------------------------------------------------
function load(a, cwd, environment) {
  const fail = (reason, detail) => new Done({ result: 'RESUME_FAIL', reason, detail }, 1);
  if (!environment) throw fail('no-environment', 'this project has no such environment (legacy project or unknown --env): no saved login');
  checkUser(environment, a.user);
  const rel = statePathFor(environment.name, a.user);
  const file = path.join(cwd, rel);
  if (!fs.existsSync(file)) throw fail('no-state', `${rel} does not exist yet — log in through the UI`);
  const side = readSidecar(cwd, environment.name, a.user);
  const url = side ? side.url : (a.url ? bareUrl(a.url) : null);
  const present = side ? side.present : (a.present || null);
  if (!url || !present) throw fail('no-landmark', `no sidecar next to ${rel} and no --url + --present given — a saved login is not trusted without a landmark`);

  const loaded = cli(a.session, ['state-load', path.resolve(file)], a.timeoutMs);
  if (loaded.status !== 0) {
    if (INFRA_RE.test(loaded.out)) throw sessionGone(a.session, loaded.status);
    if (UNSUPPORTED_RE.test(loaded.out)) throw fail('cli-unsupported', 'this @playwright/cli has no state-load (needs 0.0.63 or newer) — log in through the UI');
    throw fail('state-unreadable', `playwright-cli could not load ${rel} — log in through the UI`);
  }
  const went = cli(a.session, ['goto', url], a.timeoutMs);
  if (went.status !== 0) {
    if (INFRA_RE.test(went.out)) throw sessionGone(a.session, went.status);
    throw blocked('driver-error', `playwright-cli could not open ${url} (exit ${went.status})`);
  }
  const lm = landmark(a.session, present, LOAD_LANDMARK_MS, Math.max(a.timeoutMs, LOAD_LANDMARK_MS + 10_000));
  if (!lm.held) {
    // A dead login must not leak into the UI login that follows.
    cli(a.session, ['cookie-clear'], a.timeoutMs);
    cli(a.session, ['localstorage-clear'], a.timeoutMs);
    throw fail('landmark-failed', 'the landmark did not appear after loading the saved login — it is expired or invalid; cookies and localStorage were cleared, log in through the UI');
  }
  throw new Done({ result: 'RESUME_PASS', env: environment.name, user: a.user, path: rel }, 0);
}

// ---- save -----------------------------------------------------------------------------------
function isIgnored(cwd, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore', windowsHide: true });
  if (r.error) return true;         // git not installed
  if (r.status === 0) return true;  // ignored
  if (r.status === 1) return false; // would be committed: refuse
  return true;                      // 128: not a repository, nothing to commit
}

function save(a, cwd, environment) {
  if (!environment) throw new Done({ result: 'SKIPPED', reason: 'no-environment', detail: 'this project has no such environment: nothing is saved' }, 0);
  checkUser(environment, a.user);
  if (process.env.AGENTEX_CI === '1') throw new Done({ result: 'SKIPPED', reason: 'ci-mode', detail: 'CI never saves a login' }, 0);
  const rel = statePathFor(environment.name, a.user);
  const metaRel = sidecarPathFor(environment.name, a.user);
  const authDir = path.join(cwd, AUTH_REL);
  if (!isIgnored(cwd, `${AUTH_REL}/${path.basename(rel)}`)) {
    throw blocked('not-ignored', `${AUTH_REL}/ is not in .gitignore, so no login was saved — run /update-agentex to fix .gitignore`);
  }
  const lm = landmark(a.session, a.present, SAVE_LANDMARK_MS, Math.max(a.timeoutMs, SAVE_LANDMARK_MS + 10_000));
  const url = bareUrl(lm.url);
  if (!lm.held || !url) throw new Done({ result: 'NOT_AUTHENTICATED', detail: 'the landmark does not hold on the current page, so no login was saved' }, 1);

  fs.mkdirSync(authDir, { recursive: true });
  const stamp = `${process.pid}.${Date.now()}`;
  const tmpFile = path.join(authDir, `.${path.basename(rel)}.${stamp}.tmp`);
  const tmpMeta = path.join(authDir, `.${path.basename(metaRel)}.${stamp}.tmp`);
  const cleanup = () => { for (const f of [tmpFile, tmpMeta]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } };
  try {
    fs.writeFileSync(tmpFile, '', { mode: 0o600, flag: 'wx' }); // exists at 0600 before the driver writes into it
    const r = cli(a.session, ['state-save', path.resolve(tmpFile)], a.timeoutMs);
    if (r.status !== 0) {
      if (INFRA_RE.test(r.out)) throw sessionGone(a.session, r.status);
      if (UNSUPPORTED_RE.test(r.out)) throw blocked('cli-unsupported', 'this @playwright/cli has no state-save (needs 0.0.63 or newer): no login was saved');
      throw blocked('driver-error', `playwright-cli could not save the login (exit ${r.status})`);
    }
    if (fs.statSync(tmpFile).size === 0) throw blocked('driver-error', 'playwright-cli saved an empty file: no login was saved');
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, path.join(cwd, rel));
    fs.writeFileSync(tmpMeta, JSON.stringify({ schemaVersion: 1, url, landmark: { present: a.present }, savedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpMeta, path.join(cwd, metaRel));
  } finally { cleanup(); }
  throw new Done({ result: 'SAVED', env: environment.name, user: a.user, path: rel, sidecar: metaRel }, 0);
}

// ---- main -----------------------------------------------------------------------------------
function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    const environment = environmentOf(cwd, a);
    if (a.verb === 'load') load(a, cwd, environment); else save(a, cwd, environment);
  } catch (e) {
    if (e instanceof Done) emit(e.obj, e.code);
    else emit({ result: 'BLOCKED', reason: 'driver-error', detail: `login_state crashed: ${e && e.message}` }, 2);
  }
}

if (require.main === module) main();

module.exports = { statePathFor, sidecarPathFor, parseArgs, bareUrl };
