'use strict';
// AgenTeX verdict writer — the deterministic gate step (design: ci-quality-gate).
// Turns a finished run's summary into the PUBLIC contract-v1 verdict: one JSON
// line on stdout, <runDir>/verdict.json on disk, an AGENTEX_VERDICT_PATH copy
// when the CI gate set that env var (script-to-script handshake — no agent
// judgment between the mapping and the gate), and process.exitCode = the
// verdict's exit code.
//
// Usage (run from the consumer project root, normally at REPORT time in CI mode):
//   node write_verdict.js --summary <run-summary.json> --run-dir <executions/execu_...>
//        [--report-path <p>] [--env <name>]
//        [--scope-kind spec|list|suite|all] [--scope-value <v>]
//        [--started-at <ISO>] [--duration-ms <n>]
//        [--warnings-fail-gate true|false] [--flaky-fails-gate true|false]
//        [--retries <n>] [--timeout-minutes <n>]
//        [--run-reason <code>[:<detail>]]...        # run-level BLOCKED reasons
//        [--plugin-root <path>]
//
// The run-summary is the extent-report input shape (same `summary` counts
// vocabulary): {"summary": {"total","passed","failed","blocked","warnings",
// "viewMismatch","flaky","naDescoped","notRun"}, ...}. The temp summary file is
// the caller's to delete afterward (extent-report convention); verdict.json is
// the retained artifact.
//
// VERDICT MAPPING — fixed order; the 1-vs-2 promise in code. Exit 1 is reachable
// ONLY through product observations; every environment path terminates in 3/4:
//   1. counts.failed > 0                          -> FAIL / exit 1
//   2. warningsFailGate && counts.warnings > 0    -> FAIL / exit 1
//   3. blocked>0 | viewMismatch>0 | notRun>0 | any --run-reason
//                                                 -> BLOCKED / exit 2, named reasons
//   4. flakyFailsGate && counts.flaky > 0         -> BLOCKED / exit 2, reason
//                                                    `unstable`, retryable:false
//                                                    (never auto-retried — Flake doctrine)
//   5. otherwise                                  -> PASS / exit 0
// naDescoped never gates; non-policy flaky never gates (visible in counts).
// EXPECTED FAIL needs no handling here — it arrives as `passed` (resolved upstream).
//
// Policy precedence: CLI flags > AGENTEX_CI_POLICY (set by ci_gate.js) >
// config/project.json `ci` block > defaults (warningsFailGate true, retries 3,
// timeoutMinutes 60, flakyFailsGate false).
//
// The verdict object is built from a WHITELIST — nothing from the summary beyond
// the eight counts can reach the output, so a secret-shaped value in the input is
// structurally incapable of being echoed. Environment NAME only, paths relative
// to the project root. exitCode + event-loop drain; never process.exit.
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

const COUNT_KEYS = ['passed', 'failed', 'blocked', 'warnings', 'viewMismatch', 'flaky', 'naDescoped', 'notRun'];
const RUN_REASON_CODES = ['needs-user', 'interaction-required', 'captcha-or-otp', 'timeout', 'session-error'];
const DEFAULTS = { warningsFailGate: true, retries: 3, timeoutMinutes: 60, flakyFailsGate: false };

function parseArgs(argv) {
  const out = { runReasons: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'run-reason') out.runReasons.push(argv[++i]);
    else out[key] = argv[++i];
  }
  return out;
}

function parseBool(v) {
  if (v === undefined) return undefined;
  if (v === 'true' || v === true) return true;
  if (v === 'false' || v === false) return false;
  throw new Error(`expected true|false, got ${JSON.stringify(v)}`);
}

function parseIntOpt(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got ${JSON.stringify(v)}`);
  return n;
}

// flags > AGENTEX_CI_POLICY > config ci block > defaults
function resolvePolicy(cwd, args) {
  let fromEnv = {};
  try { fromEnv = process.env.AGENTEX_CI_POLICY ? JSON.parse(process.env.AGENTEX_CI_POLICY) : {}; }
  catch { process.stderr.write('write_verdict: AGENTEX_CI_POLICY is not valid JSON — ignored\n'); }
  let fromConfig = {};
  try { fromConfig = pc.loadProjectConfig(cwd).ci || {}; }
  catch (e) { process.stderr.write(`write_verdict: config/project.json unreadable (${e.message}) — defaults apply\n`); }
  const pickBool = (flag, key) => flag !== undefined ? flag
    : typeof fromEnv[key] === 'boolean' ? fromEnv[key]
    : typeof fromConfig[key] === 'boolean' ? fromConfig[key] : DEFAULTS[key];
  const pickNum = (flag, key) => flag !== undefined ? flag
    : Number.isFinite(fromEnv[key]) ? fromEnv[key]
    : Number.isFinite(fromConfig[key]) ? fromConfig[key] : DEFAULTS[key];
  return {
    warningsFailGate: pickBool(parseBool(args['warnings-fail-gate']), 'warningsFailGate'),
    retries: pickNum(parseIntOpt(args.retries, 'retries'), 'retries'),
    timeoutMinutes: pickNum(parseIntOpt(args['timeout-minutes'], 'timeout-minutes'), 'timeoutMinutes'),
    flakyFailsGate: pickBool(parseBool(args['flaky-fails-gate']), 'flakyFailsGate'),
  };
}

function readCounts(summaryFile) {
  let data;
  try { data = JSON.parse(fs.readFileSync(summaryFile, 'utf8')); }
  catch (e) { throw new Error(`run summary unreadable: ${e.message}`); }
  if (!data || typeof data.summary !== 'object' || data.summary === null) {
    throw new Error('run summary has no "summary" counts object');
  }
  const counts = {};
  for (const k of COUNT_KEYS) {
    const v = data.summary[k] === undefined ? 0 : data.summary[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`summary.${k} must be a non-negative number, got ${JSON.stringify(v)}`);
    }
    counts[k] = v;
  }
  return counts;
}

function parseRunReasons(raw) {
  return raw.map((r) => {
    const idx = r.indexOf(':');
    const code = idx === -1 ? r : r.slice(0, idx);
    const detail = idx === -1 ? '' : r.slice(idx + 1);
    if (!RUN_REASON_CODES.includes(code)) {
      throw new Error(`unknown --run-reason code "${code}" — allowed: ${RUN_REASON_CODES.join(', ')}`);
    }
    return { code, detail };
  });
}

// The fixed mapping. Pure — exported for reuse and tested through the CLI.
function computeVerdict(counts, runReasons, policy) {
  if (counts.failed > 0) return { verdict: 'FAIL', exitCode: 1, blockedReasons: [] };
  if (policy.warningsFailGate && counts.warnings > 0) return { verdict: 'FAIL', exitCode: 1, blockedReasons: [] };
  const reasons = [];
  if (counts.blocked > 0) reasons.push({ code: 'blocked-scenarios', detail: `${counts.blocked} scenario(s) blocked` });
  if (counts.viewMismatch > 0) reasons.push({ code: 'view-mismatch', detail: `${counts.viewMismatch} ui-check view mismatch(es) — no PASS/FAIL was issued` });
  if (counts.notRun > 0) reasons.push({ code: 'incomplete', detail: `${counts.notRun} planned scenario(s) not run` });
  reasons.push(...runReasons);
  if (policy.flakyFailsGate && counts.flaky > 0) {
    reasons.push({ code: 'unstable', detail: `${counts.flaky} flaky scenario(s) under flakyFailsGate`, retryable: false });
  }
  if (reasons.length > 0) return { verdict: 'BLOCKED', exitCode: 2, blockedReasons: reasons };
  return { verdict: 'PASS', exitCode: 0, blockedReasons: [] };
}

const relSlash = (cwd, p) => path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, '/').replace(/\/+$/, '');

function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  // Everything up to the mapping is validation; any violation is usage / exit 2 —
  // fail-closed: a garbage input must never produce a trusted artifact (nor a 0/1).
  let counts, policy, runReasons, runDir;
  try {
    if (!args.summary) throw new Error('--summary <run-summary.json> is required');
    if (!args['run-dir']) throw new Error('--run-dir <executions/execu_...> is required');
    runDir = relSlash(cwd, args['run-dir']);
    counts = readCounts(args.summary);
    policy = resolvePolicy(cwd, args);
    runReasons = parseRunReasons(args.runReasons);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, blockedReasons: [{ code: 'usage', detail: e.message }] }));
    process.exitCode = 2;
    return;
  }

  const { verdict, exitCode, blockedReasons } = computeVerdict(counts, runReasons, policy);

  const finished = new Date();
  const startedAt = args['started-at'] || finished.toISOString();
  const durationMs = args['duration-ms'] !== undefined
    ? Math.max(0, Number(args['duration-ms']) || 0)
    : Math.max(0, finished.getTime() - (Date.parse(startedAt) || finished.getTime()));

  const out = {
    schemaVersion: 1,
    verdict,
    exitCode,
    counts,
    durationMs,
    runDir,
    reportPath: args['report-path'] ? relSlash(cwd, args['report-path']) : `${runDir}/report.md`,
    blockedReasons,
    attempt: 1,
    maxAttempts: 1 + policy.retries,
    retries: 0,
    attemptHistory: [],
    scope: { kind: args['scope-kind'] || null, value: args['scope-value'] || null },
    environment: args.env || null,
    pluginVersion: (() => {
      const root = args['plugin-root'] || path.resolve(__dirname, '..', '..', '..');
      try { return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; }
      catch { return null; }
    })(),
    startedAt,
    finishedAt: finished.toISOString(),
    policy,
  };

  const line = JSON.stringify(out);
  try {
    fs.mkdirSync(path.resolve(cwd, runDir), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, runDir, 'verdict.json'), line);
  } catch (e) {
    process.stderr.write(`write_verdict: could not write verdict.json: ${e.message}\n`);
  }
  if (process.env.AGENTEX_VERDICT_PATH) {
    try {
      fs.mkdirSync(path.dirname(process.env.AGENTEX_VERDICT_PATH), { recursive: true });
      fs.writeFileSync(process.env.AGENTEX_VERDICT_PATH, line);
    } catch (e) {
      process.stderr.write(`write_verdict: could not copy verdict to AGENTEX_VERDICT_PATH: ${e.message}\n`);
    }
  }
  console.log(line);
  process.exitCode = exitCode;
}

if (require.main === module) main();

module.exports = { computeVerdict, COUNT_KEYS, RUN_REASON_CODES, DEFAULTS };
