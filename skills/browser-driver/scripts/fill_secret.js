#!/usr/bin/env node
'use strict';
// AgenTeX secret field fill: types an { "envSecret": "NAME" } value into a field of the
// run's playwright-cli session. The value goes from the environment to the page and
// nowhere else: never into argv, tool output, a log, a report, or the verdict. The
// browser twin of mobile-testing's `appium_client.js send-keys --text-env`.
//
// It fills and checks; it NEVER judges. Printed results are PASS or BLOCKED only
// (exit 0 / 2). Whether the scenario passes stays the agent's call.
//
// Usage (from the consumer project root, like every playwright-cli command of the run):
//   node fill_secret.js --session <s> --target <ref|locator> [--target ...] --env-var <NAME>
//     [--env <name>] [--press-sequentially] [--submit | --submit-target <ref|locator>]
//     [--timeout-ms <n>]
//
//   --target     a snapshot ref (e4, f1e7) or a Playwright locator (#password). Repeat it
//                for segmented inputs (OTP boxes): character i goes to target i, so the
//                target count must equal the value's character count.
//   --press-sequentially  type key by key (auto-advancing widgets) instead of fill.
//   --submit     press Enter on the last target in the SAME call; --submit-target clicks
//                that element instead. Then, once the page settles, every field a
//                fill_secret call filled on this page (marked in-page with the attribute
//                data-agentex-secret, this call's and earlier calls') that still holds a
//                value is cleared ("scrubbed") — every later playwright-cli command
//                writes a page snapshot to .playwright-cli/, and a snapshot shows input
//                values in clear text, password fields included.
//
// Checks, in order, all before any browser call:
//   1. usage;
//   2. NAME is declared as { envSecret } in the active environment (--env, else
//      defaultEnvironment) or config/project.json — only declared names are fillable, so
//      a page cannot talk the agent into typing an unrelated secret;
//   3. the value resolves non-empty (process env, then the project's .env).
//
// Delivery: the Playwright code (value inside) is written to a mode-0600 file in a fresh
// temp dir outside the project, run as `npx playwright-cli -s=<s> run-code --raw
// --filename=<file>` with no shell, and removed in `finally` — also on error and timeout.
// playwright-cli takes run-code source only as an argument or a file (stdin is ignored),
// and echoes the source on its stdout: the child's output is captured and NEVER relayed.
//
// Prints ONE JSON line:
//   {"result":"PASS","envVar":"NAME","targets":N,"masked":[bool...],"submitted":bool,"scrubbed":n}
//   {"result":"BLOCKED","envVar":"NAME","targets":N,"masked":[],"reason":"<code>","detail":"...",
//    "infrastructure"?:true}
// Reasons: secret-unavailable · target-not-found · driver-error (+ infrastructure: true when
// the session is gone or the CLI hung) · usage. Every line written is redacted (value → ***).
//
// AGENTEX_PWCLI_CMD is a fixture-only test seam: a node script run in place of
// `npx playwright-cli` (like AGENTEX_PWCLI_PROBE_CMD in preflight.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
const { collectEnvSecretNames } = require(path.join(__dirname, '..', '..', 'test-execution', 'scripts', 'ci_preflight.js'));

const DEFAULT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 500;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_RE = /^(?:f\d+)?e\d+$/;

// ---- output: one JSON line, every write redacted ----------------------------------------
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const rawStderrWrite = process.stderr.write.bind(process.stderr);
const secrets = [];
function redact(s) {
  s = String(s);
  for (const v of secrets) if (v) s = s.split(v).join('***');
  return s;
}
process.stdout.write = (chunk, ...rest) => rawStderrWrite(redact(chunk), ...rest);
process.stderr.write = (chunk, ...rest) => rawStderrWrite(redact(chunk), ...rest);

let emitted = false;
function emit(obj) {
  if (emitted) return;
  emitted = true;
  rawStdoutWrite(redact(JSON.stringify(obj)) + '\n');
  process.exitCode = obj.result === 'PASS' ? 0 : 2;
}

class Blocked extends Error {
  constructor(reason, detail, extra = {}) { super(detail); this.reason = reason; this.extra = extra; }
}
const usage = (msg) => new Blocked('usage', `${msg} — usage: fill_secret.js --session <s> --target <ref|locator> [--target ...] --env-var <NAME> [--env <name>] [--press-sequentially] [--submit | --submit-target <ref|locator>] [--timeout-ms <n>]`);

// ---- args ---------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { targets: [], pressSequentially: false, submit: false, submitTarget: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  const value = (i, flag) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw usage(`${flag} needs a value`);
    return String(argv[i]);
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--session') a.session = value(++i, f);
    else if (f === '--target') a.targets.push(value(++i, f));
    else if (f === '--env-var') a.envVar = value(++i, f);
    else if (f === '--env') a.env = value(++i, f);
    else if (f === '--press-sequentially') a.pressSequentially = true;
    else if (f === '--submit') a.submit = true;
    else if (f === '--submit-target') a.submitTarget = value(++i, f);
    else if (f === '--timeout-ms') a.timeoutMs = Number(value(++i, f));
    else throw usage(`unknown argument ${JSON.stringify(f).slice(0, 60)}`);
  }
  if (!a.session) throw usage('--session is required');
  if (a.session === 'default' || !SESSION_RE.test(a.session)) throw usage(`--session must be the run's own session name (letters, digits, . _ -; never "default")`);
  if (!a.targets.length) throw usage('at least one --target is required');
  if (a.targets.some((t) => !t.trim())) throw usage('--target must not be empty');
  if (!a.envVar) throw usage('--env-var is required');
  if (!NAME_RE.test(a.envVar)) throw usage('--env-var expects an environment variable NAME (letters, digits, _), not a value or $NAME');
  if (a.submit && a.submitTarget) throw usage('pass --submit or --submit-target, not both');
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) throw usage('--timeout-ms must be a positive number');
  return a;
}

// ---- B3: only declared names are fillable ------------------------------------------------
function declaredNames(cwd, envName) {
  let environment;
  try { environment = pc.loadEnvironment(cwd, envName || null); }
  catch (e) { throw usage(e.message); }
  const names = new Set();
  if (environment) collectEnvSecretNames(environment, names);
  let project;
  try { project = pc.loadProjectConfig(cwd); } catch (e) { throw usage(e.message); }
  collectEnvSecretNames(project, names);
  return names;
}

// ---- the code run inside the session ------------------------------------------------------
const toSelector = (t) => (REF_RE.test(t) ? `aria-ref=${t}` : t);

function buildCode({ selectors, pieces, pressSequentially, submit }) {
  return `async (page) => {
  const T = ${JSON.stringify(selectors)};
  const V = ${JSON.stringify(pieces)};
  const SEQ = ${pressSequentially ? 'true' : 'false'};
  const SUBMIT = ${JSON.stringify(submit)};
  const loc = (s) => page.locator(s);
  const found = [];
  for (const s of T) found.push((await loc(s).count()) === 1);
  if (found.some((f) => !f)) return { found, filled: false };
  if (SUBMIT && SUBMIT.click && (await loc(SUBMIT.click).count()) !== 1) return { found, filled: false, submitFound: false };
  for (let i = 0; i < T.length; i++) {
    const l = loc(T[i]);
    if (SEQ) { await l.click(); await l.pressSequentially(V[i]); } else { await l.fill(V[i]); }
  }
  const probe = (e) => {
    e.setAttribute('data-agentex-secret', '');
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(e) : null;
    const sec = cs ? (cs.webkitTextSecurity || (cs.getPropertyValue && cs.getPropertyValue('-webkit-text-security')) || 'none') : 'none';
    const v = 'value' in e ? String(e.value || '') : String(e.textContent || '');
    return { masked: String(e.type || '').toLowerCase() === 'password' || (sec !== 'none' && sec !== ''), nonEmpty: v.length > 0 };
  };
  const masked = [], nonEmpty = [];
  for (const s of T) { const r = await loc(s).evaluate(probe); masked.push(!!r.masked); nonEmpty.push(!!r.nonEmpty); }
  let submitted = false, scrubbed = 0;
  if (SUBMIT) {
    if (SUBMIT.click) await loc(SUBMIT.click).click();
    else { const last = loc(T[T.length - 1]); if ((await last.count()) === 1) await last.press('Enter', { timeout: 5000 }); }
    submitted = true;
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) {}
    try { await page.waitForTimeout(${SETTLE_MS}); } catch (e) {}
    // Every field a fill_secret call marked on this page (this call's and earlier ones'),
    // never any other field.
    const marked = loc('[data-agentex-secret]');
    let n = 0; try { n = await marked.count(); } catch (e) {}
    for (let i = 0; i < n; i++) {
      try {
        const l = marked.nth(i);
        if (await l.evaluate((e) => String(('value' in e ? e.value : e.textContent) || '').length > 0)) { await l.fill(''); scrubbed++; }
      } catch (e) {}
    }
  }
  return { found, filled: true, masked, nonEmpty, submitted, scrubbed };
}`;
}

// ---- the channel: a 0600 temp file, a shell-less child, output never relayed ----------------
function cliCommand(cliArgs) {
  const seam = process.env.AGENTEX_PWCLI_CMD;
  if (seam) return { cmd: process.execPath, args: [seam, ...cliArgs], shell: false };
  if (process.platform === 'win32') {
    // npx is a .cmd shim on Windows, which Node only spawns through a shell. Nothing secret
    // is on this line (session name validated, temp path quoted); the value is in the file.
    const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
    return { cmd: 'npx.cmd', args: ['playwright-cli', ...cliArgs].map(q), shell: true };
  }
  return { cmd: 'npx', args: ['playwright-cli', ...cliArgs], shell: false };
}

const INFRA_RE = /is not open|not running|no such session|ECONNREFUSED|ECONNRESET|has been closed|browser has disconnected|Target closed/i;

function runInSession(session, code, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-fill-'));
  const file = path.join(dir, 'fill.js');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once('exit', cleanup); // a signal-free crash still removes it
  try {
    fs.writeFileSync(file, code, { mode: 0o600, flag: 'wx' });
    const { cmd, args, shell } = cliCommand([`-s=${session}`, 'run-code', '--raw', `--filename=${file}`]);
    const r = spawnSync(cmd, args, {
      cwd: process.cwd(), env: process.env, shell, encoding: 'utf8', timeout: timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (r.error) {
      if (r.error.code === 'ETIMEDOUT') throw new Blocked('driver-error', `playwright-cli did not answer within ${timeoutMs}ms — the session may be hung; the field state is unknown`, { infrastructure: true });
      throw new Blocked('driver-error', `could not start playwright-cli (${r.error.code || 'spawn error'}) — is @playwright/cli installed in this project?`, { infrastructure: true });
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.status !== 0) {
      if (INFRA_RE.test(out)) throw new Blocked('driver-error', `session ${session} is not open (playwright-cli exit ${r.status}) — the browser session is gone`, { infrastructure: true });
      throw new Blocked('driver-error', `playwright-cli exited ${r.status} — its output is withheld because it may echo the value`);
    }
    if (/^### Error/m.test(r.stdout || '')) {
      if (INFRA_RE.test(out)) throw new Blocked('driver-error', `session ${session} closed during the fill`, { infrastructure: true });
      throw new Blocked('driver-error', 'the fill raised an error inside the page (field not editable, detached, or timed out) — its output is withheld because it may echo the value');
    }
    return parseResult(r.stdout || '');
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}

function parseResult(stdout) {
  const t = stdout.trim();
  const candidates = [t, t.split('\n')[0], (t.match(/### Result\s*\n([^\n]*)/) || [])[1]];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const j = JSON.parse(c);
      if (j && Array.isArray(j.found)) return j;
    } catch { /* next */ }
  }
  throw new Blocked('driver-error', 'playwright-cli answered without a readable result — its output is withheld because it may echo the value');
}

// ---- main ---------------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  let a = { targets: [] };
  const base = () => ({ envVar: a.envVar && NAME_RE.test(a.envVar) ? a.envVar : null, targets: a.targets.length });
  try {
    a = parseArgs(argv);
    const cwd = process.cwd();

    if (!declaredNames(cwd, a.env).has(a.envVar)) {
      throw new Blocked('secret-unavailable', `${a.envVar} is not declared as { "envSecret": "${a.envVar}" } in the active environment or config/project.json — only declared names are fillable; declare it in environments/<env>.json`);
    }
    const raw = pc.readEnvVar(cwd, a.envVar);
    const value = raw === null ? '' : String(raw);
    if (!value.trim()) {
      throw new Blocked('secret-unavailable', `${a.envVar} is not set (or empty) in the process environment or the project's .env — inject it by NAME via the CI secret store (the step's env: block) or .env`);
    }
    secrets.push(value, JSON.stringify(value).slice(1, -1));

    let pieces;
    if (a.targets.length === 1) pieces = [value];
    else {
      pieces = Array.from(value);
      if (pieces.length !== a.targets.length) {
        throw usage(`the value does not split one character per target across the ${a.targets.length} targets given — pass one --target per box, or one --target with --press-sequentially`);
      }
    }

    const selectors = a.targets.map(toSelector);
    const submit = a.submitTarget ? { click: toSelector(a.submitTarget) } : (a.submit ? { enter: true } : null);
    const res = runInSession(a.session, buildCode({ selectors, pieces, pressSequentially: a.pressSequentially, submit }), a.timeoutMs);

    if (!res.filled) {
      if (res.submitFound === false) throw new Blocked('target-not-found', `submit target ${a.submitTarget} is not on the page (or not unique) — re-snapshot and pass the current ref; nothing was typed`);
      const missing = a.targets.filter((_, i) => !res.found[i]);
      throw new Blocked('target-not-found', `target(s) not on the page or not unique: ${missing.join(', ')} — re-snapshot and pass the current ref; nothing was typed`);
    }
    const empty = (res.nonEmpty || []).map((ok, i) => (ok ? null : a.targets[i])).filter(Boolean);
    if (empty.length) {
      throw new Blocked('driver-error', `field(s) still empty after the fill: ${empty.join(', ')} — the field rejected the input`, { masked: res.masked });
    }
    emit({ result: 'PASS', ...base(), masked: res.masked, submitted: !!res.submitted, scrubbed: res.scrubbed || 0 });
  } catch (e) {
    if (e instanceof Blocked) {
      const { masked = [], ...extra } = e.extra;
      emit({ result: 'BLOCKED', ...base(), masked, reason: e.reason, detail: e.message, ...extra });
    } else {
      emit({ result: 'BLOCKED', ...base(), masked: [], reason: 'driver-error', detail: `fill_secret crashed: ${e && e.message}` });
    }
  }
}

if (require.main === module) main();

module.exports = { buildCode, parseArgs, toSelector };
