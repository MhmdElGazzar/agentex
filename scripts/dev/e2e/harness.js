'use strict';
// Harness for the permanent local e2e browser tests (*.e2e.test.js). Maintainer tooling: never
// shipped by any host. Contract (design: local-e2e-browser-tests, appendix A):
//
//   find()              { nodeModules, playwright, cli, chromium } or { missing, where }
//   requireDeps()       find(), or skipOrFail(reason)
//   skipOrFail(reason)  `SKIP: <reason>` + exit 77; under AGENTEX_E2E_REQUIRE=1 `FAIL: e2e required: ...` + exit 1
//   project({files})    a temp root with its own TMPDIR, a node_modules symlink, .gitignore (test/.auth/)
//   startFixture() / startChild() / freePort() / cliSession() / libBrowser()
//   run(cases, opts)    sequential cases, a watchdog, one cleanup list released in `finally` + on exit
//   scanOutputs()       no sentinel in any captured output or file
//
// Where Playwright comes from (read only, never installed, never written):
//   1. AGENTEX_E2E_NODE_MODULES, when set it is the ONLY place looked at;
//   2. node_modules of the repo root and its parents;
//   3. the newest ~/.npm/_npx/*/node_modules holding both `playwright` and `@playwright/cli`.
// The chosen folder is symlinked into the throwaway project, so the plugin's own finders
// (session.js loadPlaywright, browser_bridge.js findCli, `npx playwright-cli`) resolve from there.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SESSION_JS = path.join(REPO_ROOT, 'skills', 'optimize-login', 'scripts', 'session.js');
const HOST = '127.0.0.1';
const FIX = 'Fix: npx playwright install chromium (after npm i -D playwright @playwright/cli), or set AGENTEX_E2E_NODE_MODULES to a node_modules folder that holds playwright and @playwright/cli';
// Variables that would route a test through a seam or another browser: never inherited by the children.
const SCRUBBED_ENV = ['AGENTEX_CI', 'AGENTEX_PWCLI_CMD', 'AGENTEX_PLAYWRIGHT_CLI', 'PLAYWRIGHT_CHANNEL', 'HEADED'];

// ---- the finder -------------------------------------------------------------------------------
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const hasPlaywright = (nm) => fs.existsSync(path.join(nm, 'playwright', 'package.json'));
function cliBin(nm) {
  const dir = path.join(nm, '@playwright', 'cli');
  try {
    const bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
    const rel = typeof bin === 'string' ? bin : bin && bin['playwright-cli'];
    return rel && fs.existsSync(path.join(dir, rel)) ? path.join(dir, rel) : null;
  } catch { return null; }
}
const hasBoth = (nm) => hasPlaywright(nm) && !!cliBin(nm);

function exeExists(modulePath) {
  try {
    const exe = require(modulePath).chromium.executablePath();
    return !!exe && fs.existsSync(exe);
  } catch { return false; }
}

function candidates({ env, repoRoot, home }) {
  const explicit = env.AGENTEX_E2E_NODE_MODULES;
  if (explicit) return { list: [path.resolve(explicit)], label: `AGENTEX_E2E_NODE_MODULES=${path.resolve(explicit)}` };
  const list = [];
  for (let d = path.resolve(repoRoot); ; d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    if (isDir(nm)) list.push(nm);
    if (path.dirname(d) === d) break;
  }
  const cache = path.join(home, '.npm', '_npx');
  let entries = [];
  try { entries = fs.readdirSync(cache); } catch { /* no cache */ }
  const npx = entries.map((e) => path.join(cache, e, 'node_modules')).filter(isDir)
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.p);
  list.push(...npx);
  return { list, label: `${path.resolve(repoRoot)} and its parents, then ${cache}` };
}

function find({ env = process.env, repoRoot = REPO_ROOT, home = os.homedir() } = {}) {
  const { list, label } = candidates({ env, repoRoot, home });
  const nodeModules = list.find(hasBoth);
  if (!nodeModules) {
    const pwOnly = list.find(hasPlaywright);
    if (pwOnly) return { missing: '@playwright/cli', where: pwOnly };
    return { missing: 'playwright', where: label };
  }
  const playwright = path.join(nodeModules, 'playwright');
  if (!exeExists(playwright)) return { missing: 'chromium', where: `playwright in ${nodeModules}` };
  const cli = cliBin(nodeModules);
  let coreOk = true;
  try { coreOk = exeExists(require.resolve('playwright-core', { paths: [path.dirname(cli), nodeModules] })); } catch { coreOk = true; /* its own copy: cannot be asked */ }
  if (!coreOk) return { missing: 'chromium', where: `@playwright/cli in ${nodeModules}` };
  return { nodeModules, playwright, cli, chromium: require(playwright).chromium.executablePath() };
}

function skipOrFail(reason) {
  const oneLine = String(reason).replace(/\s*\n\s*/g, ' ');
  if (process.env.AGENTEX_E2E_REQUIRE === '1') {
    process.stdout.write(`FAIL: e2e required: ${oneLine}\n`);
    process.exit(1);
  }
  process.stdout.write(`SKIP: ${oneLine}\n`);
  process.exit(77);
}

let found = null;
function requireDeps(opts) {
  const f = find(opts);
  if (f.missing) {
    const what = f.missing === 'chromium' ? `a Chromium executable is missing (${f.where})`
      : f.missing === '@playwright/cli' ? `@playwright/cli not found next to playwright (${f.where})`
        : `playwright not found (looked in ${f.where})`;
    skipOrFail(`${what}. ${FIX}`);
  }
  found = f;
  return f;
}

// ---- the cleanup list ---------------------------------------------------------------------------
const cleanups = [];
const register = (name, fn) => { cleanups.push({ name, fn, done: false }); };
async function releaseAll() {
  for (const c of cleanups.slice().reverse()) {
    if (c.done) continue;
    c.done = true;
    try { await c.fn(false); } catch { /* best effort: the rest must still run */ }
  }
}
function releaseSync() {
  for (const c of cleanups.slice().reverse()) {
    if (c.done) continue;
    c.done = true;
    try { c.fn(true); } catch { /* best effort */ }
  }
}
process.on('exit', releaseSync);

// Values that must never reach a FAIL line (a test registers its sentinels here).
const masked = new Set();
const mask = (text) => { let s = String(text); for (const v of masked) if (v) s = s.split(v).join('***'); return s; };

// ---- the project ----------------------------------------------------------------------------------
let temp = null;
function tempRoot() {
  if (temp) return temp;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-e2e-')));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  // This file's own TMPDIR: in-process mkdtemp and every child (the studio session file lands there) use it.
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = tmp;
  register('temp root', () => { fs.rmSync(root, { recursive: true, force: true }); });
  // playwright-cli talks to its session daemon over a unix socket, and a socket path is limited to ~100
  // bytes: the long per-user tmpdir of macOS overflows it. Playwright's own PWTEST_SOCKETS_DIR points
  // the sockets at a short folder of this file's own (a named pipe on Windows: not needed there).
  let sockets = null;
  if (process.platform !== 'win32') {
    const base = isDir('/tmp') ? '/tmp' : os.tmpdir();
    sockets = fs.mkdtempSync(path.join(base, 'ae-'));
    register('socket dir', () => { fs.rmSync(sockets, { recursive: true, force: true }); });
  }
  temp = { root, tmp, sockets };
  return temp;
}
function childEnv(extra = {}) {
  const { tmp, sockets } = tempRoot();
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, npm_config_offline: 'true', ...(sockets ? { PWTEST_SOCKETS_DIR: sockets } : {}) };
  for (const k of SCRUBBED_ENV) delete env[k];
  return { ...env, ...extra };
}

// files: { 'rel/path': string | object (written as JSON) }
function project({ files = {} } = {}) {
  const deps = found || requireDeps();
  const { root, tmp } = tempRoot();
  const dir = fs.mkdtempSync(path.join(root, 'proj-'));
  fs.symlinkSync(deps.nodeModules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  };
  write('.gitignore', 'test/.auth/\n.playwright-cli/\nnode_modules/\n');
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }); // best effort: check-ignore then works as in a real project
  return { root, dir, tmp, env: (extra) => childEnv(extra), write, read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'), exists: (rel) => fs.existsSync(path.join(dir, rel)) };
}

// ---- processes ------------------------------------------------------------------------------------
// One async command: never blocks this process (the fixture lives in it).
function exec(cmd, args, { cwd = process.cwd(), env = childEnv(), timeout = 90000, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    let out = ''; let err = '';
    try { child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { resolve({ status: null, stdout: '', stderr: e.message, out: e.message }); return; }
    const t = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ status: null, stdout: out, stderr: err + e.message, out: out + err + e.message }); });
    child.on('close', (status) => { clearTimeout(t); resolve({ status, stdout: out, stderr: err, out: `${out}\n${err}` }); });
  });
}

// A long-lived child (a server): resolves when `readyLine` (RegExp) matches its stdout.
function startChild(script, args = [], { readyLine = null, cwd = process.cwd(), env = childEnv(), timeout = 20000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; let err = '';
  let exited = false;
  const gone = new Promise((r) => child.on('exit', () => { exited = true; r(); }));
  const stop = async (sync) => {
    if (exited) return;
    if (sync) { try { child.kill('SIGKILL'); } catch { /* gone */ } return; }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* gone */ } await Promise.race([gone, new Promise((r) => setTimeout(r, 1000))]); }
  };
  register(`child ${path.basename(script)}`, stop);
  const handle = { child, out: () => out, err: () => err, stop: () => stop(false), exited: () => exited, ready: '' };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${path.basename(script)} printed no ready line within ${timeout} ms: ${mask(`${out}${err}`).slice(-300)}`)), timeout);
    const check = () => {
      if (!readyLine) { clearTimeout(t); resolve(handle); return true; }
      const m = readyLine.exec(out);
      if (m) { handle.ready = m[0]; clearTimeout(t); resolve(handle); return true; }
      return false;
    };
    child.stdout.on('data', (d) => { out += d; if (!handle.ready) check(); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { if (!handle.ready) { clearTimeout(t); reject(new Error(`${path.basename(script)} exited (${code}) before it was ready: ${mask(`${out}${err}`).slice(-300)}`)); } });
    if (!readyLine) check();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startFixture() {
  const f = await require('./fixture_app.js').startFixture();
  register('fixture app', () => f.close());
  return f;
}

// ---- the real CLI -----------------------------------------------------------------------------------
let sessionSeq = 0;
// A playwright-cli session of this process, driven through the real `npx playwright-cli` from the
// project (npm_config_offline=true: npx never downloads). `open` uses the bundled Chromium, headless
// (the CLI's own default would be the installed Chrome, headed).
function cliSession(proj) {
  const name = `e2e-${process.pid}-${++sessionSeq}`;
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const shell = process.platform === 'win32';
  const pw = (...args) => exec(npx, ['playwright-cli', `-s=${name}`, ...args.map(String)], { cwd: proj.dir, env: proj.env(), shell });
  register(`cli session ${name}`, () => {
    spawnSync(npx, ['playwright-cli', `-s=${name}`, 'close'], { cwd: proj.dir, env: proj.env(), stdio: 'ignore', timeout: 20000, shell, windowsHide: true });
  });
  return { name, pw, open: (url) => pw('open', '--browser=chromium', ...(url ? [url] : [])), close: () => pw('close') };
}

// ---- the library browser ------------------------------------------------------------------------------
// A headless bundled Chromium through the repo's own session.js loadPlaywright (resolved from the
// project). Every context aborts any request whose host is not 127.0.0.1 and records its URL.
async function libBrowser(proj = null) {
  const p = proj || project();
  const S = require(SESSION_JS);
  const pw = S.loadPlaywright(p.dir);
  const browser = await pw.chromium.launch({ headless: true });
  register('library browser', () => browser.close());
  const external = [];
  return {
    browser, pw,
    external: () => external.slice(),
    context: async (opts = {}) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
      await context.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== HOST, (route) => { external.push(route.request().url()); return route.abort(); });
      return context;
    },
  };
}

// ---- assertions ---------------------------------------------------------------------------------------
function walk(dir, skip, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isSymbolicLink() || skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
    if (e.isDirectory()) walk(full, skip, base, out); else out.push({ full, rel });
  }
  return out;
}
// Asserts that no sentinel shows in any captured output or in any file under `dir` (except the paths
// in `exclude`, relative to dir: the saved login legitimately holds them). Never prints a sentinel.
function scanOutputs(sentinels, outputs, dir, { exclude = [] } = {}) {
  const list = sentinels.filter(Boolean);
  list.forEach((s) => masked.add(s));
  outputs.forEach((o, i) => {
    const text = typeof o === 'string' ? o : String((o && o.out) || '');
    list.forEach((s, k) => { if (text.includes(s)) throw new Error(`sentinel #${k} appears in output #${i}`); });
  });
  if (dir) {
    for (const f of walk(dir, exclude)) {
      let buf; try { buf = fs.readFileSync(f.full); } catch { continue; }
      list.forEach((s, k) => { if (buf.includes(s)) throw new Error(`sentinel #${k} appears in file ${f.rel}`); });
    }
  }
}

// ---- the runner ----------------------------------------------------------------------------------------
// cases: [[name, async fn], ...], run in order; a failed case is named and the rest still run.
async function run(cases, { watchdogMs = 120000 } = {}) {
  let passed = 0; const failures = [];
  // A ref'd timer, cleared in `finally`: an unref'd one would let a hung case with no live handle exit 0.
  const dog = setTimeout(() => {
    process.stderr.write(`  FAIL - watchdog: the file ran longer than ${watchdogMs} ms; stopping everything it started\n`);
    releaseSync();
    process.exit(1);
  }, watchdogMs);
  try {
    for (const [name, fn] of cases) {
      try { await fn(); passed++; console.log(`  ok - ${name}`); }
      catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${mask(String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '))}`); }
    }
  } finally {
    clearTimeout(dog);
    await releaseAll();
  }
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exit(failures.length ? 1 : 0);
}

module.exports = {
  REPO_ROOT, HOST, find, requireDeps, skipOrFail, project, exec, startChild, freePort, startFixture, cliSession, libBrowser,
  run, scanOutputs, mask, register,
};
