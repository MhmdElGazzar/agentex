'use strict';

// Shared parallel coordinator. Codex uses its default worker; packaged Copilot
// must inject a host-owned worker. Claude dispatch remains separate. No worker
// writes run-level final files.
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadProjectConfig, loadEnvironment, readEnvVar } = require('../../../scripts/lib/project_config.js');
const { finalizeParallel } = require('../../test-execution/scripts/finalize_parallel_run.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const PREFLIGHT = path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'scripts', 'preflight.js');
const INIT_RUN = path.join(PLUGIN_ROOT, 'skills', 'test-execution', 'scripts', 'init_run.js');
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// Model streams are untrusted transcripts. Keep only fixed, non-secret process
// signals; never copy arbitrary lines from either stream into run artifacts.
const DIAGNOSTIC_SIGNALS = [
  ['ENOENT', /\bENOENT\b/i], ['EACCES', /\bEACCES\b/i], ['EPERM', /\bEPERM\b/i],
  ['ECONNREFUSED', /\bECONNREFUSED\b|ERR_CONNECTION_REFUSED/i],
  ['ETIMEDOUT', /\bETIMEDOUT\b|ERR_TIMED_OUT/i],
  ['AUTHENTICATION', /authentication (?:failed|required)|unauthorized/i],
  ['USAGE_LIMIT', /usage limit|quota exceeded|rate limit/i],
  ['MISSING_RESOURCE', /cannot find module|module not found|no such file/i],
  ['INVALID_ARGUMENT', /unknown (?:argument|option)|invalid (?:argument|option)/i],
];
function firstDiagnosticSignal(text) {
  const found = DIAGNOSTIC_SIGNALS.map(([name, pattern]) => ({ name, index: text.search(pattern) }))
    .filter(item => item.index >= 0).sort((a, b) => a.index - b.index);
  return found[0]?.name || null;
}
function safeWorkerDiagnostic(stream, bytes, text, exitCode, outcome, firstSignal) {
  const signals = DIAGNOSTIC_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return `AgenTeX sanitized ${stream} process diagnostic\n` +
    `outcome=${outcome}\nexitCode=${Number.isInteger(exitCode) ? exitCode : 'unknown'}\n` +
    `bytes=${bytes}\nfirstSignal=${firstSignal || firstDiagnosticSignal(text) || 'UNCLASSIFIED'}\n` +
    `signals=${signals.join(',') || 'UNCLASSIFIED'}\n` +
    'Raw model/tool transcript withheld by release privacy policy.\n';
}
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function validateConcurrency(value, count) {
  const concurrency = value === undefined ? DEFAULT_CONCURRENCY : Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  return Math.min(concurrency, count);
}

function isSpec(file) {
  if (path.extname(file).toLowerCase() !== '.md') return false;
  const body = fs.readFileSync(file, 'utf8');
  return /^\s*#\s*Spec\s*:/im.test(body) && /^\s*##\s*Scenarios?\b/im.test(body);
}

function resolveSpecs(cwd, { specs = [], specDir } = {}) {
  if (specDir && specs.length) throw new Error('use explicit specs or a directory, not both');
  if (!specDir && !specs.length) throw new Error('at least one saved specification is required');
  const root = fs.realpathSync(cwd);
  const checked = file => {
    const absolute = path.resolve(cwd, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || !inside(root, fs.realpathSync(absolute))) {
      throw new Error(`spec file not found inside consumer project: ${file}`);
    }
    if (!isSpec(absolute)) throw new Error(`not an AgenTeX saved spec: ${file}`);
    return path.relative(cwd, absolute).replace(/\\/g, '/');
  };
  let files = specs;
  if (specDir) {
    const directory = path.resolve(cwd, specDir);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory() || !inside(root, fs.realpathSync(directory))) {
      throw new Error(`spec directory not found inside consumer project: ${specDir}`);
    }
    const found = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && isSpec(full)) found.push(path.relative(cwd, full));
      }
    };
    walk(directory);
    files = found;
  }
  const resolved = files.map(checked);
  if (!resolved.length) throw new Error('no AgenTeX saved specs found');
  if (new Set(resolved.map(s => process.platform === 'win32' ? s.toLowerCase() : s)).size !== resolved.length) {
    throw new Error('duplicate spec assignment');
  }
  return resolved;
}

function resolveTarget(cwd, { targetUrl, environment, loginMode } = {}) {
  const project = loadProjectConfig(cwd);
  const env = loadEnvironment(cwd, environment);
  const url = targetUrl || (env && env.portalUrl) || readEnvVar(cwd, 'QA_TARGET_URL');
  if (!url) throw new Error('target URL is required; no environment/default/legacy target resolved');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('target must be an HTTP(S) URL without embedded credentials');
  }
  const mode = loginMode || (['session', 'fresh', 'per-test'].includes(project.login?.mode) ? project.login.mode : 'fresh');
  if (!['none', 'fresh', 'per-test', 'session'].includes(mode)) throw new Error('invalid login mode');
  return { targetUrl: url, environment: env ? env.name : null, loginMode: mode,
    testData: env ? { defaults: env.defaults || {}, users: env.users || {} } : {} };
}

function resolveAuthState(cwd, environment, requested) {
  const authRoot = path.join(cwd, 'test', '.auth');
  if (!fs.existsSync(authRoot)) throw new Error('session login requires a saved test/.auth state');
  const realRoot = fs.realpathSync(authRoot);
  let file = requested;
  if (!file) {
    const suffix = environment ? `-${environment}-state.json` : '-state.json';
    const candidates = fs.readdirSync(authRoot).filter(name => name.endsWith(suffix));
    if (candidates.length !== 1) throw new Error('session login requires --auth-state when zero or multiple saved states match');
    file = path.join(authRoot, candidates[0]);
  }
  const absolute = path.resolve(cwd, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() ||
    !inside(realRoot, fs.realpathSync(absolute))) throw new Error('auth state must be a file inside test/.auth');
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error('invalid saved auth state');
  return absolute;
}

function prepareAuthCopies(assignments, source) {
  const created = [];
  try {
    for (const assignment of assignments) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-worker-auth-'));
      created.push({ session: assignment.session, dir });
      const file = path.join(dir, 'state.json');
      fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(file, 0o600); } catch {}
      assignment.authStatePath = file;
      assignment.authTempDir = dir;
    }
    return created;
  } catch (error) { cleanupAuthCopies(created); throw error; }
}

function cleanupAuthCopies(copies) {
  const issues = [];
  const tmpRoot = fs.realpathSync(os.tmpdir());
  for (const copy of copies) {
    try {
      const target = fs.realpathSync(copy.dir);
      if (!inside(tmpRoot, target) || !path.basename(target).startsWith('agentex-worker-auth-')) {
        throw new Error('temporary auth directory failed ownership check');
      }
      fs.rmSync(target, { recursive: true, force: true });
    } catch { issues.push({ session: copy.session, reason: 'worker-owned temporary auth state could not be removed' }); }
  }
  return issues;
}

function runJsonScript(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 90000, shell: false });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(script)} failed: ${(result.error?.message || result.stdout || result.stderr || '').slice(0, 500)}`);
  try { return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
  catch { throw new Error(`${path.basename(script)} did not return JSON`); }
}

function allocate(cwd, specs, resolved, preflight) {
  const labels = specs.map(spec => path.basename(spec, '.md').replace(/,/g, '-'));
  const init = runJsonScript(INIT_RUN, ['--sessions', labels.join(',')], cwd);
  const sessions = Object.entries(init.sessions);
  if (sessions.length !== specs.length) throw new Error('init_run session count mismatch');
  const runRoot = path.resolve(cwd, init.runDir);
  const runDir = init.runDir.replace(/\\/g, '/');
  const assignments = specs.map((spec, index) => {
    const [session, info] = sessions[index];
    const sessionDir = path.resolve(cwd, info.dir);
    if (session === 'default' || !inside(runRoot, sessionDir)) throw new Error('invalid allocated session');
    return { runId: path.basename(init.runDir), runDir,
      workerId: `worker-${String(index + 1).padStart(3, '0')}`, session, spec,
      label: path.basename(spec, '.md'), targetUrl: resolved.targetUrl, environment: resolved.environment,
      loginMode: resolved.loginMode, testData: resolved.testData, workingDir: cwd,
      executionDir: runRoot, sessionDir, browserWorkingDir: sessionDir,
      artifacts: { screenshots: path.join(sessionDir, 'screenshots'), logs: path.join(sessionDir, 'logs'),
        result: path.join(sessionDir, 'executor-result.json') },
      evidenceExpectations: { screenshotPerScenario: true, console: true, requests: true },
      playwrightCommand: preflight['playwright-cli'].command };
  });
  return { runDir, assignments };
}

function resolveRunHandoff(cwd, destination) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('run handoff path is required');
  const file = path.resolve(cwd, destination);
  const parent = path.dirname(file);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('run handoff parent directory must already exist');
  }
  if (fs.existsSync(file)) throw new Error('run handoff destination already exists');
  return file;
}

function validateInvocationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)) {
    throw new Error('invocation ID must be 8..128 safe characters');
  }
  return value;
}

function atomicPublish(file, body, label) {
  const temporary = path.join(path.dirname(file), `.agentex-${label}-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.linkSync(temporary, file); // Atomic, exclusive publication: never replace an existing identity.
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function writeRunHandoff(file, runDir, invocationId) {
  const body = JSON.stringify({ schemaVersion: 1, runId: path.basename(runDir), runDir,
    ...(invocationId ? { invocationId } : {}) }) + '\n';
  atomicPublish(file, body, 'run-handoff');
}

function workerPrompt(assignment) {
  return `Use the AgenTeX agentex-executor skill at ${path.join(PLUGIN_ROOT, 'skills/agentex-executor/SKILL.md')} and the shared test-execution skill. This is ONE immutable parallel assignment. Read the supplied spec and required Playwright reference before browser actions. Do not discover or run any other spec. Run browser CLI commands from browserWorkingDir, which is your sandbox-writable session directory; read project configuration from workingDir. Write ONLY inside sessionDir, including scratch, logs, screenshots, and executor-result.json, except that loginMode=session may refresh ONLY the private authStatePath supplied in this assignment; never read/write the shared original auth state. Do not write run-summary.json, report.md, bugs/bug-list.md, HTML, or any sibling session. Never close another session. Do not install packages or change application/plugin code. If a permission boundary blocks the preflight-provided CLI, request narrow approval for the exact session-scoped command; never disable sandbox. Run one attempt per scenario, retry only infrastructure per shared flake doctrine. Always attempt -s=<your session> close and record cleanup honestly. The coordinator validates and finalizes after you exit. Do not print secret values or envSecret names. Assignment JSON (testData contains configuration values/references, not resolved envSecret values):\n${JSON.stringify(assignment)}`;
}

function stopOwnedProcess(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // Exact tracked PID only; /T closes its owned descendants, never global Node/Codex.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
    killer.on('close', code => { if (code !== 0) try { child.kill(); } catch {} });
  } else { try { child.kill('SIGTERM'); } catch {} }
}

function codexWorker(assignment, { timeoutMs, signal, codexExecutable = 'codex', spawnWorker = spawn } = {}) {
  return new Promise(resolve => {
    const pluginSource = JSON.stringify(PLUGIN_ROOT.replace(/\\/g, '/'));
    const args = ['--approve-for-me', '-c', 'marketplaces.agentex-local.source_type="local"',
      '-c', `marketplaces.agentex-local.source=${pluginSource}`, '--cd', assignment.sessionDir];
    const browserCache = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    if (process.platform === 'win32' && fs.existsSync(browserCache)) args.push('--add-dir', browserCache);
    if (assignment.authTempDir) args.push('--add-dir', assignment.authTempDir);
    args.push('exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-');
    let child;
    try { child = spawnWorker(codexExecutable, args, { cwd: assignment.sessionDir, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ outcome: 'launch-failed', detail: error.code || error.message }); return; }
    let settled = false, timedOut = false, cancelled = false, stdoutBytes = 0, stderrBytes = 0;
    let stdoutTail = '', stderrTail = '', firstStdoutSignal, firstStderrSignal;
    const retainSignals = (current, chunk, remember) => {
      const combined = current.slice(-128) + chunk.toString('utf8');
      remember(firstDiagnosticSignal(combined));
      return (current + chunk.toString('utf8')).slice(-65536);
    };
    const done = (outcome, detail) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      // Files stay in the assigned session slice and contain only allowlisted
      // signal names/counts. Raw Codex output is never persisted.
      let diagnosticError;
      try {
        fs.writeFileSync(path.join(assignment.artifacts.logs, 'worker-stdout.log'),
          safeWorkerDiagnostic('stdout', stdoutBytes, stdoutTail, child.exitCode, outcome, firstStdoutSignal), { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(assignment.artifacts.logs, 'worker-stderr.log'),
          safeWorkerDiagnostic('stderr', stderrBytes, stderrTail, child.exitCode, outcome, firstStderrSignal), { flag: 'wx', mode: 0o600 });
      } catch (error) { diagnosticError = error.code || 'DIAGNOSTIC_WRITE_FAILED'; }
      resolve({ outcome, detail: diagnosticError ? `${detail || outcome}; diagnostic write ${diagnosticError}` : detail,
        exitCode: child.exitCode, pid: child.pid, stdoutBytes, stderrBytes });
    };
    const onAbort = () => { cancelled = true; stopOwnedProcess(child);
      setTimeout(() => done('cancelled', 'coordinator interrupted'), 5000).unref(); };
    const timer = setTimeout(() => { timedOut = true; stopOwnedProcess(child);
      setTimeout(() => done('timeout', `worker exceeded ${timeoutMs} ms`), 5000).unref(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Drain output without storing model/tool transcripts (which can contain secrets).
    child.stdout.on('data', data => { stdoutBytes += data.length;
      stdoutTail = retainSignals(stdoutTail, data, signal => { firstStdoutSignal ||= signal; }); });
    child.stderr.on('data', data => { stderrBytes += data.length;
      stderrTail = retainSignals(stderrTail, data, signal => { firstStderrSignal ||= signal; }); });
    child.on('error', error => done('launch-failed', error.code || error.message));
    child.on('close', code => done(cancelled ? 'cancelled' : timedOut ? 'timeout' : code === 0 ? 'completed' : 'crashed',
      code === 0 ? undefined : `exit ${code}`));
    child.stdin.on('error', () => {});
    child.stdin.end(workerPrompt(assignment));
  });
}

async function schedule(assignments, concurrency, worker, { timeoutMs = DEFAULT_TIMEOUT_MS, watchdogGraceMs = 6000, signal } = {}) {
  const states = new Array(assignments.length);
  let next = 0, active = 0, maxActive = 0;
  const startedAt = new Date().toISOString();
  const loop = async () => {
    while (next < assignments.length && !signal?.aborted) {
      const index = next++, assignment = assignments[index];
      active++; maxActive = Math.max(maxActive, active);
      const start = new Date().toISOString();
      let result, watchdog;
      try {
        // A coordinator watchdog covers even a buggy/mock worker that never
        // resolves; the production worker has its own process-kill watchdog.
        result = await Promise.race([worker(assignment, { timeoutMs, signal }),
          new Promise(resolve => { watchdog = setTimeout(() => resolve({ outcome: 'timeout', detail: `worker exceeded ${timeoutMs} ms` }), timeoutMs + watchdogGraceMs); })]);
      }
      catch (error) { result = { outcome: 'crashed', detail: error.code || error.message }; }
      finally { clearTimeout(watchdog); }
      states[index] = { workerId: assignment.workerId, session: assignment.session, startedAt: start,
        endedAt: new Date().toISOString(), ...result };
      active--;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, assignments.length) }, loop));
  for (let i = 0; i < states.length; i++) if (!states[i]) states[i] = { workerId: assignments[i].workerId,
    session: assignments[i].session, outcome: 'cancelled', detail: 'coordinator interrupted before launch' };
  return { states, startedAt, endedAt: new Date().toISOString(), maxActive };
}

function cliAction(command, args, cwd, timeout = 20000) {
  const result = spawnSync(command.executable, [...command.args, ...args], { cwd, encoding: 'utf8',
    shell: false, timeout });
  return { ok: !result.error && result.status === 0, stdout: result.stdout || '',
    error: result.error?.code || (result.status === 0 ? null : `exit ${result.status}`) };
}

function hasSession(listOutput, session) {
  return new RegExp(`(^|[^a-z0-9._-])${session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9._-]|$)`, 'mi').test(listOutput);
}

async function runParallel({ cwd = process.cwd(), specs, specDir, targetUrl, environment, loginMode,
  authState, concurrency, timeoutMs = DEFAULT_TIMEOUT_MS, worker = codexWorker, preflight, signal,
  runHandoff, invocationId, resultValidator } = {}) {
  // The selective Copilot package carries this canonical coordinator but not
  // the Codex executor skill. Its host must inject its own assignment worker.
  if (worker === codexWorker && fs.existsSync(path.join(PLUGIN_ROOT, '..', 'package-integrity.json')) &&
      !fs.existsSync(path.join(PLUGIN_ROOT, '.codex-plugin'))) {
    throw new Error('packaged Copilot parallel execution requires a host-owned worker callback');
  }
  cwd = fs.realpathSync(cwd);
  if (invocationId !== undefined && runHandoff === undefined) throw new Error('invocation ID requires a run handoff');
  const handoffFile = runHandoff === undefined ? null : resolveRunHandoff(cwd, runHandoff);
  const ownerId = handoffFile ? validateInvocationId(invocationId === undefined ? crypto.randomUUID() : invocationId) : null;
  const files = resolveSpecs(cwd, { specs, specDir });
  const limit = validateConcurrency(concurrency, files.length);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) throw new Error('timeoutMs must be 1000..3600000');
  const resolved = resolveTarget(cwd, { targetUrl, environment, loginMode });
  const authSource = resolved.loginMode === 'session'
    ? resolveAuthState(cwd, resolved.environment, authState) : null;
  const tools = preflight || runJsonScript(PREFLIGHT, [], cwd);
  if (tools['playwright-cli']?.status !== 'READY') {
    throw new Error(`Playwright preflight ${tools['playwright-cli']?.status || 'UNKNOWN'}; use scoped approval if required`);
  }
  const { runDir, assignments } = allocate(cwd, files, resolved, tools);
  // An exclusive coordinator marker closes the init_run timestamp race if two
  // independent coordinators happen to allocate the same run directory.
  const ownerFile = path.join(cwd, runDir, 'coordinator-owner.json');
  const ownerBody = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(),
    ...(ownerId ? { schemaVersion: 1, runId: path.basename(runDir), invocationId: ownerId } : {}) }) + '\n';
  if (ownerId) atomicPublish(ownerFile, ownerBody, 'coordinator-owner');
  else fs.writeFileSync(ownerFile, ownerBody, { flag: 'wx' });
  // Publish the exact allocated identity after ownership exists, before auth preparation or any worker starts.
  if (handoffFile) writeRunHandoff(handoffFile, runDir, ownerId);
  const authCopies = authSource ? prepareAuthCopies(assignments, authSource) : [];
  assignments.forEach(Object.freeze);
  let scheduled, authCleanupIssues;
  try { scheduled = await schedule(assignments, limit, worker, { timeoutMs, signal }); }
  finally { authCleanupIssues = cleanupAuthCopies(authCopies); }
  const cleanup = [];
  // Abnormal workers may have left a browser. Close only assigned sessions.
  for (let i = 0; i < assignments.length; i++) if (scheduled.states[i].outcome !== 'completed') {
    cleanup.push({ session: assignments[i].session, ...cliAction(tools['playwright-cli'].command,
      [`-s=${assignments[i].session}`, 'close'], assignments[i].sessionDir) });
  }
  const listed = cliAction(tools['playwright-cli'].command, ['list'], cwd);
  if (listed.ok) for (const assignment of assignments) if (hasSession(listed.stdout, assignment.session)) {
    cleanup.push({ session: assignment.session, ...cliAction(tools['playwright-cli'].command,
      [`-s=${assignment.session}`, 'close'], assignment.sessionDir) });
  }
  const listedAfter = cliAction(tools['playwright-cli'].command, ['list'], cwd);
  const ownedRemaining = listedAfter.ok ? assignments.filter(a => hasSession(listedAfter.stdout, a.session)).map(a => a.session) : null;
  const cleanupIssues = authCleanupIssues.concat(listedAfter.ok
    ? ownedRemaining.map(session => ({ session, reason: 'owned browser session remains open after cleanup' }))
    : assignments.map(a => ({ session: a.session, reason: `browser cleanup could not be verified: ${listedAfter.error}` })));
  const issuesBySession = new Map();
  for (const issue of cleanupIssues) {
    issuesBySession.set(issue.session, issuesBySession.has(issue.session)
      ? `${issuesBySession.get(issue.session)}; ${issue.reason}` : issue.reason);
  }
  const uniqueCleanupIssues = [...issuesBySession].map(([session, reason]) => ({ session, reason }));
  const manifest = { runDir, assignments: assignments.map(({ testData, playwrightCommand, authStatePath, authTempDir, ...safe }) => safe),
    targetUrl: resolved.targetUrl, environment: resolved.environment, loginMode: resolved.loginMode,
    startedAt: scheduled.startedAt, endedAt: new Date().toISOString(), tools: { node: tools.node,
      'playwright-cli': { ok: true, status: 'READY', version: tools['playwright-cli'].version } },
    workerStates: scheduled.states.map(({ pid, stdoutBytes, stderrBytes, ...state }) => state), cleanupIssues: uniqueCleanupIssues };
  const runRoot = path.resolve(cwd, runDir);
  fs.writeFileSync(path.join(runRoot, 'parallel-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const final = finalizeParallel({ ...manifest, cwd, resultValidator });
  const timing = { schemaVersion: 1, concurrency: limit, specCount: files.length, startedAt: scheduled.startedAt,
    endedAt: scheduled.endedAt, maxActive: scheduled.maxActive, workerStates: scheduled.states,
    cleanup, browserList: { ok: listedAfter.ok, ownedRemaining } };
  fs.writeFileSync(path.join(runRoot, 'parallel-timing.json'), JSON.stringify(timing, null, 2) + '\n', { flag: 'wx' });
  return { ...final, timing, codexInvocations: worker === codexWorker ? files.length : 0 };
}

function parseArgs(argv) {
  const out = { specs: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--spec') out.specs.push(value);
    else if ({ '--spec-dir': 'specDir', '--target-url': 'targetUrl', '--environment': 'environment',
      '--login-mode': 'loginMode', '--auth-state': 'authState', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs',
      '--run-handoff': 'runHandoff', '--invocation-id': 'invocationId' }[key]) {
      const field = { '--spec-dir': 'specDir', '--target-url': 'targetUrl', '--environment': 'environment',
        '--login-mode': 'loginMode', '--auth-state': 'authState', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs',
        '--run-handoff': 'runHandoff', '--invocation-id': 'invocationId' }[key];
      if (out[field] !== undefined) throw new Error(`duplicate ${key}`);
      out[field] = ['concurrency', 'timeoutMs'].includes(field) ? Number(value) : value;
    } else throw new Error(`unknown argument: ${key}`);
  }
  return out;
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runParallel({ ...parseArgs(process.argv.slice(2)), signal: controller.signal })
    .then(result => { console.log(JSON.stringify(result)); process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0; })
    .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; });
}

module.exports = { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, validateConcurrency, isSpec, resolveSpecs,
  resolveTarget, resolveAuthState, prepareAuthCopies, cleanupAuthCopies, allocate, schedule, runParallel,
  codexWorker, safeWorkerDiagnostic, cliAction, hasSession, parseArgs, resolveRunHandoff, writeRunHandoff, validateInvocationId };
