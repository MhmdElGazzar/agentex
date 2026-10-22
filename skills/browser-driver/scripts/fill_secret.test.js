'use strict';
// Tests for fill_secret.js — types an { envSecret } value into the run's playwright-cli
// session without the value ever reaching argv, stdout/stderr, or a file left behind.
//
// No live browser: AGENTEX_PWCLI_CMD (fixture-only seam) points at a fake playwright-cli,
// written below, that records its argv/stdin and the --filename file's state, then
// EVALUATES the generated Playwright code against a mock page — so the code the script
// builds is exercised, not just its plumbing. Like the real CLI, the fake echoes the code
// (value included) on stdout, so "never relay child output" is tested for real.
//
// The sentinel never appears literally in a command line: it travels only through the
// child's environment, exactly as a CI secret store delivers it.
//
// Run: node skills/browser-driver/scripts/fill_secret.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'fill_secret.js');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const CI_SETTINGS = path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'templates', 'ci', 'ci-settings.json');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL = 'EVAL_SENTINEL_FILL_x9';
const OTP = '4821';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- the fake playwright-cli -----------------------------------------------------------
const FAKE = path.join(tmp('agentex-fs-fake-'), 'fake_pwcli.js');
fs.writeFileSync(FAKE, String.raw`'use strict';
const fs = require('fs'); const path = require('path');
const rec = process.env.FAKE_REC; const secret = process.env[process.env.FAKE_VAR] || '';
const append = (file, obj) => {
  const f = path.join(rec, file);
  const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  all.push(obj); fs.writeFileSync(f, JSON.stringify(all));
};
const argv = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const fArg = argv.find((a) => a.startsWith('--filename='));
const file = fArg ? fArg.slice('--filename='.length) : null;
let code = null, fileInfo = null;
if (file && fs.existsSync(file)) {
  code = fs.readFileSync(file, 'utf8');
  const st = fs.statSync(file);
  fileInfo = { path: file, mode: st.mode & 0o777, insideCwd: path.resolve(file).startsWith(process.cwd() + path.sep) };
}
append('calls.json', { argv, stdinBytes: stdin.length, fileInfo, codeHasValue: !!(code && secret && code.includes(secret)) });
const mode = process.env.FAKE_MODE || 'eval';
if (mode === 'gone') { process.stdout.write("The browser '" + argv[0].slice(3) + "' is not open, please run open first\n"); process.exit(1); }
if (mode === 'error') { process.stdout.write('### Error\nError: boom while typing ' + secret + '\n'); process.exit(0); }
if (mode === 'hang') { setTimeout(() => {}, 60000); return; }
// eval: run the generated code against a mock page
const spec = JSON.parse(process.env.FAKE_PAGE || '{}');
const els = {};
for (const [sel, d] of Object.entries(spec.elements || {})) els[sel] = { type: d.type || 'text', value: d.value || '', count: d.count === undefined ? 1 : d.count, security: d.security || 'none', tagName: 'INPUT', attrs: d.marked ? { 'data-agentex-secret': '' } : {}, setAttribute(k, v) { this.attrs[k] = v; } };
const chars = Array.from(secret);
const act = (o) => append('actions.json', o);
global.getComputedStyle = (e) => ({ webkitTextSecurity: e.security, getPropertyValue: (p) => (p === '-webkit-text-security' ? e.security : '') });
const page = {
  locator(sel) {
    if (sel === '[data-agentex-secret]') {
      const marked = Object.entries(els).filter(([, e]) => e.count > 0 && 'data-agentex-secret' in e.attrs);
      return { async count() { return marked.length; }, nth: (i) => page.locator(marked[i][0]) };
    }
    const el = els[sel];
    return {
      async count() { return el ? el.count : 0; },
      async fill(v) { if (!el) throw new Error('no element'); el.value = v; act({ op: 'fill', sel, whole: v === secret, charIndex: v === '' ? -2 : chars.indexOf(v) }); },
      async pressSequentially(v) { if (!el) throw new Error('no element'); el.value += v; act({ op: 'pressSequentially', sel, whole: v === secret, charIndex: chars.indexOf(v) }); },
      async click() { act({ op: 'click', sel }); if (spec.navigateOnSubmit && spec.submitSel === sel) for (const k of Object.keys(els)) els[k].count = 0; },
      async press(key) { act({ op: 'press', sel, key }); if (key === 'Enter' && spec.navigateOnSubmit) for (const k of Object.keys(els)) els[k].count = 0; },
      async evaluate(fn) { return fn(el); },
    };
  },
  async waitForLoadState() {}, async waitForTimeout() {},
};
(async () => {
  try {
    const fn = eval('(' + code + ')');
    const r = await fn(page);
    process.stdout.write(argv.includes('--raw') ? JSON.stringify(r) + '\n' : '### Result\n' + JSON.stringify(r) + '\n');
  } catch (e) { process.stdout.write('### Error\n' + e.message + '\n'); }
  process.stdout.write('### Ran Playwright code\n` + '```' + String.raw`js\nawait (' + code + ')(page);\n` + '```' + String.raw`\n');
})();
`);

// ---- a consumer project ------------------------------------------------------------------
function proj({ env = { defaults: { password: { envSecret: 'QA_PASSWORD' }, otp: { envSecret: 'QA_OTP' } } }, project = { defaultEnvironment: 'qc' }, dotenv = null } = {}) {
  const dir = tmp('agentex-fs-proj-');
  if (project) { fs.mkdirSync(path.join(dir, 'config')); fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(project)); }
  if (env) { fs.mkdirSync(path.join(dir, 'environments')); fs.writeFileSync(path.join(dir, 'environments', 'qc.json'), JSON.stringify(env)); }
  if (dotenv !== null) fs.writeFileSync(path.join(dir, '.env'), dotenv);
  return dir;
}

const LOGIN_PAGE = { elements: { 'aria-ref=e4': { type: 'password' }, 'aria-ref=e5': { type: 'text' }, '#otp1': {}, '#otp2': {}, '#otp3': {}, '#otp4': {}, 'aria-ref=e11': {} } };

// Runs the script with an isolated TMPDIR so leftovers are attributable.
function run(args, { cwd = proj(), secretEnv = { QA_PASSWORD: SENTINEL, QA_OTP: OTP }, mode = 'eval', page = LOGIN_PAGE, fakeVar = 'QA_PASSWORD', seam = true } = {}) {
  const rec = tmp('agentex-fs-rec-');
  const tdir = tmp('agentex-fs-tmp-');
  const env = { ...process.env, TMPDIR: tdir, TEMP: tdir, TMP: tdir, FAKE_REC: rec, FAKE_MODE: mode, FAKE_PAGE: JSON.stringify(page), FAKE_VAR: fakeVar };
  delete env.QA_PASSWORD; delete env.QA_OTP;
  Object.assign(env, secretEnv);
  if (seam) env.AGENTEX_PWCLI_CMD = FAKE;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let json = null; try { json = JSON.parse(lines[lines.length - 1]); } catch {}
  const readRec = (f) => (fs.existsSync(path.join(rec, f)) ? JSON.parse(fs.readFileSync(path.join(rec, f), 'utf8')) : []);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', lines, json, calls: readRec('calls.json'), actions: readRec('actions.json'), tdir, cwd, argv: [SCRIPT, ...args] };
}

// Every file under dir (recursive), for "nothing written contains the value" sweeps.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// The value never surfaces: argv (ours and the child's), our stdout/stderr, any file left
// in the project or the temp dir. Applied to every run below.
function assertNoLeak(r, value = SENTINEL) {
  assert.ok(!r.argv.join(' ').includes(value), 'value in our argv');
  for (const c of r.calls) assert.ok(!c.argv.join(' ').includes(value), `value in child argv: ${c.argv.join(' ')}`);
  assert.ok(!r.stdout.includes(value), 'value in stdout');
  assert.ok(!r.stderr.includes(value), 'value in stderr');
  for (const f of [...walk(r.cwd), ...walk(r.tdir)]) assert.ok(!fs.readFileSync(f, 'utf8').includes(value), `value in ${f}`);
}

const BASE = ['--session', 'run-ab12', '--target', 'e4', '--env-var', 'QA_PASSWORD'];

// ---- 1-3: the channel ----------------------------------------------------------------------

test('PASS: one JSON line, exit 0, masked passes through, value never in argv/stdout/stderr/files', () => {
  const r = run(BASE);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.lines.length, 1, 'exactly one stdout line');
  assert.deepStrictEqual(r.json, { result: 'PASS', envVar: 'QA_PASSWORD', targets: 1, masked: [true], submitted: false, scrubbed: 0 });
  assert.strictEqual(r.calls.length, 1, 'one CLI call');
  assert.ok(r.calls[0].codeHasValue, 'the value travelled inside the code file');
  assert.deepStrictEqual(r.actions, [{ op: 'fill', sel: 'aria-ref=e4', whole: true, charIndex: -1 }]);
  assertNoLeak(r);
});

test('the child is `-s=<session> run-code --raw --filename=<file>`; the file is 0600, outside the project, gone afterwards', () => {
  const r = run(BASE);
  const c = r.calls[0];
  assert.strictEqual(c.argv[0], '-s=run-ab12');
  assert.deepStrictEqual(c.argv.slice(1, 3), ['run-code', '--raw']);
  assert.ok(c.argv[3].startsWith('--filename='), c.argv.join(' '));
  assert.strictEqual(c.stdinBytes, 0, 'nothing on stdin (the CLI ignores it)');
  assert.ok(c.fileInfo, 'the code file existed while the CLI ran');
  if (process.platform !== 'win32') assert.strictEqual(c.fileInfo.mode, 0o600);
  assert.strictEqual(c.fileInfo.insideCwd, false, 'temp file must live outside the project');
  assert.ok(!fs.existsSync(c.fileInfo.path), 'temp file removed');
  assert.deepStrictEqual(fs.readdirSync(r.tdir), [], 'temp dir left empty');
});

test('driver error: child output (which carries the value) is never relayed; temp file still removed', () => {
  const r = run(BASE, { mode: 'error' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.strictEqual(r.json.reason, 'driver-error');
  assert.ok(!r.json.infrastructure, 'a code error is not an infrastructure failure');
  assert.ok(!fs.existsSync(r.calls[0].fileInfo.path));
  assert.deepStrictEqual(fs.readdirSync(r.tdir), []);
  assertNoLeak(r);
});

test('session gone → driver-error with infrastructure: true', () => {
  const r = run(BASE, { mode: 'gone' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'driver-error');
  assert.strictEqual(r.json.infrastructure, true);
  assertNoLeak(r);
});

test('watchdog: a hung CLI is killed, BLOCKED driver-error (infrastructure), temp file removed', () => {
  const t0 = Date.now();
  const r = run([...BASE, '--timeout-ms', '800'], { mode: 'hang' });
  assert.ok(Date.now() - t0 < 15000, 'returned well before the fake would');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'driver-error');
  assert.strictEqual(r.json.infrastructure, true);
  assert.ok(!fs.existsSync(r.calls[0].fileInfo.path), 'temp file removed after timeout');
  assert.deepStrictEqual(fs.readdirSync(r.tdir), []);
  assertNoLeak(r);
});

// ---- 4-5: allowlist and lookup --------------------------------------------------------------

test('an undeclared name → secret-unavailable naming the NAME, before any browser call', () => {
  const r = run(['--session', 's1', '--target', 'e4', '--env-var', 'ANTHROPIC_API_KEY'], { secretEnv: { ANTHROPIC_API_KEY: SENTINEL } });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'secret-unavailable');
  assert.match(r.json.detail, /ANTHROPIC_API_KEY/);
  assert.match(r.json.detail, /envSecret/);
  assert.strictEqual(r.calls.length, 0, 'no browser call');
  assertNoLeak(r);
});

test('a name declared only in config/project.json is fillable', () => {
  const cwd = proj({ env: { defaults: {} }, project: { defaultEnvironment: 'qc', login: { password: { envSecret: 'APP_PASS' } } } });
  const r = run(['--session', 's1', '--target', 'e4', '--env-var', 'APP_PASS'], { cwd, secretEnv: { APP_PASS: SENTINEL }, fakeVar: 'APP_PASS' });
  assert.strictEqual(r.status, 0, r.stdout);
  assertNoLeak(r);
});

test('a legacy project with no environment and no declarations → secret-unavailable with the declare hint', () => {
  const cwd = proj({ env: null, project: null });
  const r = run(BASE, { cwd });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'secret-unavailable');
  assert.match(r.json.detail, /environments\/<env>\.json/);
  assert.strictEqual(r.calls.length, 0);
});

test('--env names the environment explicitly; an unknown one → usage', () => {
  const r = run([...BASE, '--env', 'nope']);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'usage');
  assert.strictEqual(r.calls.length, 0);
});

for (const [label, secretEnv] of [['missing', {}], ['empty', { QA_PASSWORD: '' }], ['whitespace-only', { QA_PASSWORD: '   ' }]]) {
  test(`a ${label} value → secret-unavailable naming the NAME, never captcha-or-otp, no browser call`, () => {
    const r = run(BASE, { secretEnv });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.strictEqual(r.json.reason, 'secret-unavailable');
    assert.match(r.json.detail, /QA_PASSWORD/);
    assert.ok(!/captcha/.test(r.stdout));
    assert.strictEqual(r.calls.length, 0);
  });
}

test('the value is found in the project .env when the process env lacks it (local trial)', () => {
  const cwd = proj({ dotenv: `QA_PASSWORD=${SENTINEL}\n` });
  const r = run(BASE, { cwd, secretEnv: {} });
  assert.strictEqual(r.status, 0, r.stdout);
  // .env itself holds the value by design; every OTHER file must not.
  for (const f of [...walk(cwd).filter((f) => path.basename(f) !== '.env'), ...walk(r.tdir)]) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(SENTINEL), f);
  }
  assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
});

// ---- 6: segmented inputs ------------------------------------------------------------------

test('segmented OTP: 4 targets, one character each, one CLI call', () => {
  const r = run(['--session', 's1', '--target', '#otp1', '--target', '#otp2', '--target', '#otp3', '--target', '#otp4', '--env-var', 'QA_OTP'], { fakeVar: 'QA_OTP' });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.targets, 4);
  assert.strictEqual(r.calls.length, 1);
  assert.deepStrictEqual(r.actions.map((a) => [a.sel, a.charIndex]), [['#otp1', 0], ['#otp2', 1], ['#otp3', 2], ['#otp4', 3]]);
  assertNoLeak(r, OTP);
});

test('segmented count mismatch → BLOCKED before any browser call; the message states the target count only', () => {
  const r = run(['--session', 's1', '--target', '#otp1', '--target', '#otp2', '--target', '#otp3', '--env-var', 'QA_OTP'], { fakeVar: 'QA_OTP' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.strictEqual(r.json.reason, 'usage');
  assert.match(r.json.detail, /3 targets/);
  assert.ok(!/\b4\b/.test(r.json.detail), 'never the value length');
  assert.strictEqual(r.calls.length, 0);
  assertNoLeak(r, OTP);
});

test('--press-sequentially types into a single auto-advancing target', () => {
  const r = run(['--session', 's1', '--target', '#otp1', '--env-var', 'QA_OTP', '--press-sequentially'], { fakeVar: 'QA_OTP' });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.actions.filter((a) => a.op === 'pressSequentially').map((a) => a.whole), [true]);
  assertNoLeak(r, OTP);
});

// ---- 7: masked flags, targets, submit -------------------------------------------------------

test('masked reflects type=password and -webkit-text-security; a plain text field is masked:false', () => {
  const page = { elements: { 'aria-ref=e4': { type: 'password' }, 'aria-ref=e5': { type: 'text' }, '#sec': { type: 'text', security: 'disc' } } };
  for (const [t, want] of [['e4', true], ['e5', false], ['#sec', true]]) {
    const r = run(['--session', 's1', '--target', t, '--env-var', 'QA_PASSWORD'], { page });
    assert.strictEqual(r.status, 0, r.stdout);
    assert.deepStrictEqual(r.json.masked, [want], t);
  }
});

test('a target that does not resolve → target-not-found, nothing typed', () => {
  const r = run(['--session', 's1', '--target', 'e99', '--env-var', 'QA_PASSWORD']);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'target-not-found');
  assert.match(r.json.detail, /e99/);
  assert.deepStrictEqual(r.actions.filter((a) => a.op === 'fill'), []);
  assertNoLeak(r);
});

test('an ambiguous target (2 matches) → target-not-found, nothing typed', () => {
  const r = run(['--session', 's1', '--target', 'input.pw', '--env-var', 'QA_PASSWORD'], { page: { elements: { 'input.pw': { count: 2 } } } });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.json.reason, 'target-not-found');
  assert.deepStrictEqual(r.actions, []);
});

test('--submit presses Enter on the last target in the same call; a field still holding the value is scrubbed', () => {
  const r = run([...BASE, '--submit']);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.actions.map((a) => a.op), ['fill', 'press', 'fill']);
  assert.strictEqual(r.actions[1].key, 'Enter');
  assert.strictEqual(r.actions[2].charIndex, -2, 'the scrub fills the empty string');
  assert.strictEqual(r.json.submitted, true);
  assert.strictEqual(r.json.scrubbed, 1);
  assertNoLeak(r);
});

test('--submit that navigates away: nothing left to scrub', () => {
  const r = run([...BASE, '--submit'], { page: { ...LOGIN_PAGE, navigateOnSubmit: true } });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.scrubbed, 0);
});

test('--submit also scrubs secret fields an EARLIER call filled without --submit (in-page marker, no state on disk)', () => {
  // Same page, two calls: the fake page persists only within one CLI call, so the earlier
  // fill is modelled as a field that already holds a value and carries the marker.
  const page = { elements: { 'aria-ref=e4': { type: 'password' }, 'aria-ref=e5': { type: 'text', value: 'x', marked: true }, 'aria-ref=e3': { type: 'text', value: 'user' } } };
  const r = run([...BASE, '--submit'], { page });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.scrubbed, 2, 'this call\'s target + the earlier marked field; never the unmarked username');
  assert.deepStrictEqual(r.actions.filter((a) => a.charIndex === -2).map((a) => a.sel).sort(), ['aria-ref=e4', 'aria-ref=e5']);
});

test('--submit-target clicks that element instead of pressing Enter', () => {
  const r = run([...BASE, '--submit-target', 'e11'], { page: { ...LOGIN_PAGE, navigateOnSubmit: true, submitSel: 'aria-ref=e11' } });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.actions.map((a) => [a.op, a.sel]), [['fill', 'aria-ref=e4'], ['click', 'aria-ref=e11']]);
  assert.strictEqual(r.json.submitted, true);
});

// ---- usage ------------------------------------------------------------------------------------

for (const [label, args] of [
  ['no --session', ['--target', 'e4', '--env-var', 'QA_PASSWORD']],
  ['the default session', ['--session', 'default', '--target', 'e4', '--env-var', 'QA_PASSWORD']],
  ['a session name with shell characters', ['--session', 's1;rm', '--target', 'e4', '--env-var', 'QA_PASSWORD']],
  ['no --target', ['--session', 's1', '--env-var', 'QA_PASSWORD']],
  ['no --env-var', ['--session', 's1', '--target', 'e4']],
  ['a non-name --env-var', ['--session', 's1', '--target', 'e4', '--env-var', '$QA_PASSWORD']],
  ['an unknown flag', [...BASE, '--text', 'x']],
]) {
  test(`usage: ${label} → BLOCKED usage, exit 2, no browser call`, () => {
    const r = run(args);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.strictEqual(r.json.reason, 'usage');
    assert.strictEqual(r.calls.length, 0);
  });
}

// ---- 8: template pin (B11) ----------------------------------------------------------------------
// The invocation the rule lines prescribe must be ALLOWED and not DENIED by every shell rule set
// the shipped CI settings carry (Bash today; PowerShell too once present) — else the fix itself
// fail-closes under dontAsk, and the deny-retry-lockout spiral starts.

function ruleMatches(rule, tool, cmd) {
  const m = rule.match(/^([A-Za-z]+)\((.*)\)$/);
  if (!m || m[1] !== tool) return false;
  let pat = m[2];
  if (pat.endsWith(':*')) pat = pat.slice(0, -2) + '*';
  const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(cmd);
}

test('template pin: every shell rule set in ci-settings.json allows the fill_secret.js invocation', () => {
  const { allow, deny } = JSON.parse(fs.readFileSync(CI_SETTINGS, 'utf8')).permissions;
  const tools = ['Bash', 'PowerShell'].filter((t) => allow.some((r) => r.startsWith(t + '(')));
  assert.ok(tools.includes('Bash'), 'Bash rules present');
  const cmds = [
    'node /opt/plugins/agentex/skills/browser-driver/scripts/fill_secret.js --session s --target e4 --env-var QA_PASSWORD',
    'node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/fill_secret.js --session s --target e4 --env-var QA_PASSWORD --submit',
    'node C:\\agentex\\skills\\browser-driver\\scripts\\fill_secret.js --session s --target #otp1 --target #otp2 --env-var QA_OTP --env qc',
  ];
  for (const tool of tools) {
    for (const cmd of cmds) {
      assert.ok(allow.some((r) => ruleMatches(r, tool, cmd)), `${tool}: no allow rule matches ${cmd}`);
      assert.ok(!deny.some((r) => ruleMatches(r, tool, cmd)), `${tool}: a deny rule matches ${cmd}`);
    }
  }
});

test('template pin: the matcher is not vacuous (a denied command is denied)', () => {
  const { deny } = JSON.parse(fs.readFileSync(CI_SETTINGS, 'utf8')).permissions;
  assert.ok(deny.some((r) => ruleMatches(r, 'Bash', 'git push origin main')));
});

// ---- summary ---------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error('Failures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exitCode = 1; }
