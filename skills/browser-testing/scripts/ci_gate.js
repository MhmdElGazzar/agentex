'use strict';
// AgenTeX CI gate — THE pipeline entry point (design: ci-quality-gate, Option A).
// A consumer's CI/CD pipeline invokes this one script from the project root; it
// owns everything the owner fixed hard semantics for: per-attempt CI preflight,
// the headless session spawn, the per-attempt wall-clock budget (process-tree
// kill, partial artifacts preserved), BLOCKED-only retries, fail-closed verdict
// location, the single stdout JSON line, and the 0/1/2 exit code.
//
//   node <plugin-root>/skills/browser-testing/scripts/ci_gate.js
//        [--spec <file>]... | --suite <folder> | --all
//        [--env <name>]
//        [--retries N] [--timeout-minutes N] [--warnings-fail true|false]
//        [--flaky-fails-gate true|false]
//        [--settings <file>]          # headless permission settings override
//        [--claude-cmd <cmd>]         # test/debug injection; default "claude"
//
// Exit codes (the product): 0 = PASS (EXPECTED FAIL honored as pass upstream),
// 1 = FAIL (real product defects), 2 = BLOCKED (environment/infrastructure or
// otherwise indeterminate). Under no input does an environment failure produce
// exit 1.
//
// Flow per invocation:
//  1. Validate usage + project — violations exit 2 with {code:"usage"}. All
//     diagnostics go to stderr; stdout carries exactly ONE JSON line, ever.
//  2. Resolve policy: flags > config/project.json `ci` block > defaults
//     (retries 3, warningsFailGate true, timeoutMinutes 60, flakyFailsGate false).
//  3. Attempt loop (max 1 + retries):
//     a. ci_preflight.js — token-free; a failure concludes the attempt BLOCKED
//        with its named preflight-* reasons and never spends a session.
//     b. Spawn `<claude-cmd> --bare -p "/agentex:execute-test ci <scope> [on <env>]"
//        --plugin-dir <self-resolved root> --add-dir <self-resolved root>
//        [--settings <file>] --permission-mode dontAsk --output-format json`
//        with env AGENTEX_CI=1, AGENTEX_VERDICT_PATH=<absolute handshake path>,
//        AGENTEX_CI_POLICY=<json>. `--add-dir` grants the session READ access to
//        the plugin's own root (references, scripts, templates) in every install
//        layout — marketplace-managed or pinned checkout: the shipped settings
//        allow Read(./**) only, which is the CONSUMER project, so without this
//        grant a plugin installed elsewhere cannot read references/ci-mode.md or
//        write_verdict.js and every run fail-closes to BLOCKED no-verdict. The
//        grant is read-oriented and scoped to the plugin root — writes stay
//        governed by the deny-by-default settings, which never widen.
//        claude's own exit code is NOT the verdict — the verdict travels through
//        the artifact write_verdict.js writes (script-to-script handshake).
//     c. Enforce the per-attempt budget: on expiry kill the child process tree
//        (Windows: taskkill /T /F), preserve whatever the run wrote, conclude
//        the attempt BLOCKED {code:"timeout"}.
//     d. Locate the attempt's verdict: the AGENTEX_VERDICT_PATH copy first;
//        fallback: the UNIQUE executions/*/verdict.json newer than the attempt
//        start. Missing/unparseable/ambiguous → BLOCKED {code:"no-verdict"} —
//        fail-closed: a session that did not deterministically conclude can only
//        be exit 2, never 0 or 1.
//  4. Retry ONLY a BLOCKED attempt (owner decision 8) — never exit 0/1, and
//     never a BLOCKED whose only reason is `unstable` (Flake doctrine: retrying
//     to clear instability is the silent-retry anti-pattern one level up).
//     Fixed 30s pause between attempts (AGENTEX_CI_RETRY_DELAY_MS is a
//     fixture-only test seam).
//  5. Conclude: first non-BLOCKED attempt (or the last) is final. Write the
//     final verdict JSON (with retries + attemptHistory) into the final run
//     folder as verdict.json (creating a minimal executions/execu_<ts>/ if the
//     attempt died before init_run.js ran), print it as the ONE stdout line,
//     set process.exitCode, and drain — never force-exit (Windows/Node 24
//     corrupts forced exit codes, and the exit code IS the product).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
const { COUNT_KEYS, DEFAULTS } = require(path.join(__dirname, 'write_verdict.js'));

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const CI_PREFLIGHT = path.join(__dirname, 'ci_preflight.js');
const DEFAULT_SETTINGS = path.join(PLUGIN_ROOT, 'skills', 'browser-testing', 'templates', 'ci', 'ci-settings.json');
const RETRY_DELAY_MS = process.env.AGENTEX_CI_RETRY_DELAY_MS !== undefined
  ? Math.max(0, Number(process.env.AGENTEX_CI_RETRY_DELAY_MS) || 0)
  : 30_000;

const log = (msg) => process.stderr.write(`ci_gate: ${msg}\n`);

function parseArgs(argv) {
  const out = { specs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--spec': out.specs.push(argv[++i]); break;
      case '--suite': out.suite = argv[++i]; break;
      case '--all': out.all = true; break;
      case '--env': out.env = argv[++i]; break;
      case '--retries': out.retries = argv[++i]; break;
      case '--timeout-minutes': out.timeoutMinutes = argv[++i]; break;
      case '--warnings-fail': out.warningsFail = argv[++i]; break;
      case '--flaky-fails-gate': out.flakyFailsGate = argv[++i]; break;
      case '--settings': out.settings = argv[++i]; break;
      case '--claude-cmd': out.claudeCmd = argv[++i]; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

function parseBool(v, name) {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`--${name} expects true|false, got ${JSON.stringify(v)}`);
}

function parseNum(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got ${JSON.stringify(v)}`);
  return n;
}

// flags > config `ci` block > defaults (write_verdict shares the same defaults).
function resolvePolicy(cwd, args) {
  let ci = {};
  try { ci = pc.loadProjectConfig(cwd).ci || {}; }
  catch (e) { throw new Error(`config/project.json unreadable: ${e.message}`); }
  const pick = (flag, key, isBool) => flag !== undefined ? flag
    : (isBool ? typeof ci[key] === 'boolean' : Number.isFinite(ci[key])) ? ci[key]
    : DEFAULTS[key];
  return {
    warningsFailGate: pick(parseBool(args.warningsFail, 'warnings-fail'), 'warningsFailGate', true),
    retries: pick(parseNum(args.retries, 'retries'), 'retries', false),
    timeoutMinutes: pick(parseNum(args.timeoutMinutes, 'timeout-minutes'), 'timeoutMinutes', false),
    flakyFailsGate: pick(parseBool(args.flakyFailsGate, 'flaky-fails-gate'), 'flakyFailsGate', true),
  };
}

function resolveScope(args) {
  const forms = [args.specs.length > 0, Boolean(args.suite), Boolean(args.all)].filter(Boolean).length;
  if (forms !== 1) {
    throw new Error('exactly one scope form is required: --spec <file> (repeatable) | --suite <folder> | --all');
  }
  if (args.all) return { kind: 'all', value: 'all' };
  if (args.suite) return { kind: 'suite', value: args.suite.replace(/\\/g, '/') };
  const specs = args.specs.map((s) => s.replace(/\\/g, '/'));
  return specs.length === 1 ? { kind: 'spec', value: specs[0] } : { kind: 'list', value: specs.join(' ') };
}

const q = (s) => `"${s}"`;

function killTree(child) {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

// Run a child, stream its output to stderr (stdout stays ours alone), resolve on close.
function run(command, { cwd, env, budgetMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env, detached: process.platform !== 'win32' });
    let out = ''; let timedOut = false;
    child.stdout.on('data', (d) => { out += d; process.stderr.write(d); });
    child.stderr.on('data', (d) => process.stderr.write(d));
    const timer = budgetMs ? setTimeout(() => { timedOut = true; log(`attempt budget exceeded (${budgetMs}ms) — killing the session process tree`); killTree(child); }, budgetMs) : null;
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, timedOut }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: null, out, timedOut, error: e.message }); });
  });
}

async function runPreflight(cwd, envName) {
  const cmd = [q(process.execPath), q(CI_PREFLIGHT), ...(envName ? ['--env', q(envName)] : []), '--plugin-root', q(PLUGIN_ROOT)].join(' ');
  const r = await run(cmd, { cwd, env: process.env });
  try {
    const parsed = JSON.parse(r.out.trim().split(/\r?\n/).pop());
    return { ok: parsed.ok === true, blockedReasons: parsed.blockedReasons || [] };
  } catch {
    return { ok: false, blockedReasons: [{ code: 'preflight-tools', detail: 'ci_preflight produced no parseable output' }] };
  }
}

function validVerdict(obj) {
  return obj && typeof obj === 'object'
    && ['PASS', 'FAIL', 'BLOCKED'].includes(obj.verdict)
    && [0, 1, 2].includes(obj.exitCode)
    && obj.counts && typeof obj.counts === 'object';
}

function readJsonQuietly(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Primary: the handshake copy. Fallback: the UNIQUE executions/*/verdict.json
// newer than the attempt start. Anything else is no-verdict (fail-closed).
function locateVerdict(cwd, handshakePath, attemptStartMs) {
  const fromHandshake = readJsonQuietly(handshakePath);
  if (validVerdict(fromHandshake)) return fromHandshake;
  const execDir = path.join(cwd, 'executions');
  let fresh = [];
  try {
    fresh = fs.readdirSync(execDir)
      .map((e) => path.join(execDir, e, 'verdict.json'))
      .filter((f) => { try { return fs.statSync(f).mtimeMs >= attemptStartMs - 2000; } catch { return false; } });
  } catch { /* no executions dir yet */ }
  if (fresh.length !== 1) return null;
  const fromDisk = readJsonQuietly(fresh[0]);
  return validVerdict(fromDisk) ? fromDisk : null;
}

const nowStamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cwd = process.cwd();
  let args, policy, scope;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(path.join(cwd, 'config', 'project.json')) && !fs.existsSync(path.join(cwd, 'test'))) {
      throw new Error(`${cwd} does not look like an AgenTeX project (no config/project.json and no test/ folder) — run /init-test first, then invoke the gate from the project root`);
    }
    scope = resolveScope(args);
    policy = resolvePolicy(cwd, args);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, blockedReasons: [{ code: 'usage', detail: e.message }] }));
    process.exitCode = 2;
    return;
  }

  const gateStart = new Date();
  const envName = args.env || (() => { try { return pc.loadProjectConfig(cwd).defaultEnvironment || null; } catch { return null; } })();
  const settingsPath = args.settings || (fs.existsSync(DEFAULT_SETTINGS) ? DEFAULT_SETTINGS : null);
  const claudeCmd = args.claudeCmd || 'claude';
  const prompt = `/agentex:execute-test ci ${scope.value}${args.env ? ` on ${args.env}` : ''}`;
  const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ci-gate-'));
  const maxAttempts = 1 + policy.retries;
  const budgetMs = Math.max(1, Math.round(policy.timeoutMinutes * 60_000));
  const attempts = []; // { attempt, verdict|null, reasons, runDir|null }

  for (let n = 1; n <= maxAttempts; n++) {
    log(`attempt ${n}/${maxAttempts} — CI preflight`);
    const preflight = await runPreflight(cwd, args.env);
    if (!preflight.ok) {
      attempts.push({ attempt: n, verdict: null, reasons: preflight.blockedReasons, runDir: null });
    } else {
      const attemptStartMs = Date.now();
      const handshakePath = path.join(handshakeDir, `attempt-${n}`, 'verdict.json');
      const command = [
        claudeCmd, '--bare', '-p', q(prompt),
        '--plugin-dir', q(PLUGIN_ROOT),
        '--add-dir', q(PLUGIN_ROOT), // read grant on the plugin's own root (D1) — see flow 3b
        ...(settingsPath ? ['--settings', q(settingsPath)] : []),
        '--permission-mode', 'dontAsk',
        '--output-format', 'json',
      ].join(' ');
      log(`attempt ${n}/${maxAttempts} — spawning headless session: ${prompt}`);
      const session = await run(command, {
        cwd,
        env: { ...process.env, AGENTEX_CI: '1', AGENTEX_VERDICT_PATH: handshakePath, AGENTEX_CI_POLICY: JSON.stringify(policy) },
        budgetMs,
      });
      if (session.timedOut) {
        attempts.push({
          attempt: n, verdict: null, runDir: null,
          reasons: [{ code: 'timeout', detail: `attempt exceeded the ${policy.timeoutMinutes}-minute budget — session killed, partial artifacts preserved under executions/` }],
        });
      } else {
        const verdict = locateVerdict(cwd, handshakePath, attemptStartMs);
        if (verdict) {
          attempts.push({ attempt: n, verdict, reasons: verdict.blockedReasons || [], runDir: verdict.runDir || null });
        } else {
          attempts.push({
            attempt: n, verdict: null, runDir: null,
            reasons: [{ code: 'no-verdict', detail: 'the session did not conclude deterministically (missing, unparseable, or ambiguous verdict artifact) — fail-closed' + (session.error ? `; session error: ${session.error}` : '') }],
          });
        }
      }
    }

    const last = attempts[attempts.length - 1];
    const outcome = last.verdict ? last.verdict.verdict : 'BLOCKED';
    if (outcome !== 'BLOCKED') break; // exit 0/1 is never retried
    const codes = last.reasons.map((r) => r.code);
    if (codes.length > 0 && codes.every((c) => c === 'unstable')) {
      log('BLOCKED for `unstable` only — never auto-retried (Flake doctrine)');
      break;
    }
    if (n < maxAttempts) { log(`attempt ${n} BLOCKED (${codes.join(', ') || 'no reason'}) — retrying in ${RETRY_DELAY_MS}ms`); await sleep(RETRY_DELAY_MS); }
  }

  // Conclude: first non-BLOCKED (the loop breaks on it) or the last attempt.
  const finalAttempt = attempts[attempts.length - 1];
  const finished = new Date();
  const zeroCounts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  let base = finalAttempt.verdict;
  if (!base) {
    const runDir = `executions/execu_${nowStamp()}`;
    base = {
      schemaVersion: 1, verdict: 'BLOCKED', exitCode: 2, counts: zeroCounts,
      durationMs: 0, runDir, reportPath: `${runDir}/report.md`,
      blockedReasons: finalAttempt.reasons,
      attempt: 1, maxAttempts: 1, retries: 0, attemptHistory: [],
      scope: { kind: null, value: null }, environment: null,
      pluginVersion: (readJsonQuietly(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')) || {}).version || null,
      startedAt: gateStart.toISOString(), finishedAt: finished.toISOString(), policy,
    };
  }
  const final = {
    ...base,
    attempt: finalAttempt.attempt,
    maxAttempts,
    retries: attempts.length - 1,
    attemptHistory: attempts.map((a) => ({
      attempt: a.attempt,
      runDir: a.runDir,
      verdict: a.verdict ? a.verdict.verdict : 'BLOCKED',
      reasonCodes: a.reasons.map((r) => r.code),
    })),
    scope,
    environment: envName,
    startedAt: gateStart.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - gateStart.getTime(),
    policy,
  };

  const line = JSON.stringify(final);
  try {
    fs.mkdirSync(path.resolve(cwd, final.runDir), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, final.runDir, 'verdict.json'), line);
  } catch (e) {
    log(`could not write the final verdict.json: ${e.message}`);
  }
  console.log(line);
  process.exitCode = final.exitCode;
}

if (require.main === module) {
  main().catch((e) => {
    // Fail closed: an unexpected gate error is indeterminate — exit 2, never 0/1.
    console.log(JSON.stringify({ ok: false, blockedReasons: [{ code: 'session-error', detail: `ci_gate crashed: ${e.message}` }] }));
    process.exitCode = 2;
  });
}
