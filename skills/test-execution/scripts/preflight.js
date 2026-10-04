// AgenTeX preflight — checks every tool a run might need, in one call.
//
// Usage: node preflight.js [--needs browser,api,db]
// Prints ONE JSON line: {"playwright-cli": {...}, "playwright": {...}, "curl": {...},
// "sqlcmd": {...}, "az": {...}, "node": {...}} — informational, always exits 0.
// The agent decides what's required for the run at hand (sqlcmd only matters for db: steps, etc.)
//
// Probe posture (backlog/preflight-probe-false-negative): the playwright-cli probe
// runs the installed package's bin with Node directly, without cmd.exe/npx.
// It judges by OUTPUT, not exit code alone. On Windows + Node v24 a working
// @playwright/cli prints its version and then dies on its own exit path with an
// upstream libuv assertion (UV_HANDLE_CLOSING) — a benign exit-crash, not a broken
// tool. When the version output is present AND the crash matches that known
// signature, the tool is reported usable with a note; any other failure keeps
// reporting broken exactly as before. The exception is scoped to the
// playwright-cli probe only, keyed to the known signature.
const { spawnSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

function probe(cmd, args) {
  try {
    // single command string: avoids DEP0190 (shell:true with an args array) on Windows
    const r = spawnSync([cmd, ...args].join(' '), { encoding: 'utf8', timeout: 60000, shell: true });
    if (r.error || r.status !== 0) return { ok: false, error: (r.error && r.error.message) || (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}` };
    const first = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').find(l => l.trim()) || '';
    return { ok: true, version: first.trim().slice(0, 120) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The known benign exit-crash signature: upstream libuv assertion on the CLI's own
// exit path (observed on Windows + Node v24; the tool has already done its work).
const BENIGN_EXIT_CRASH = /UV_HANDLE_CLOSING/;
// A plausible version line: semver-ish digits, taken from a line that is NOT part
// of the crash/assertion text itself.
const VERSION_LINE = /\d+\.\d+\.\d+/;
const CRASH_TEXT = /Assertion failed|UV_HANDLE_CLOSING/;

// Pure judgment over a spawnSync-shaped result ({error, status, stdout, stderr}).
// Exported for fixture-level tests — no live tool needed.
function judgePlaywrightCliProbe(r, { sandboxed = false } = {}) {
  if (r.error) {
    const status = r.error.code === 'EPERM' || r.error.code === 'EACCES'
      ? (sandboxed ? 'BLOCKED_BY_SANDBOX' : 'APPROVAL_REQUIRED') : 'BROKEN_EXECUTABLE';
    return { ok: false, status, error: r.error.message };
  }
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.status === 0) {
    const first = (stdout + '\n' + stderr).split(/\r?\n/).find(l => VERSION_LINE.test(l) && !CRASH_TEXT.test(l));
    return first ? { ok: true, status: 'READY', version: first.trim().slice(0, 120) }
      : { ok: false, status: 'BROKEN_EXECUTABLE', error: 'CLI exited successfully without version output' };
  }
  // Non-zero exit: trust the evidence the probe already has. A plausible version
  // line (outside the crash text) + the known benign signature = a usable tool.
  const versionLine = (stdout + '\n' + stderr).split('\n')
    .find(l => VERSION_LINE.test(l) && !CRASH_TEXT.test(l));
  if (versionLine && BENIGN_EXIT_CRASH.test(stdout + stderr)) {
    return {
      ok: true,
      status: 'READY',
      version: versionLine.trim().slice(0, 120),
      note: 'version confirmed; known benign exit-crash on this stack',
    };
  }
  return { ok: false, status: 'BROKEN_EXECUTABLE', error: stderr.trim().split('\n')[0] || `exit ${r.status}` };
}

function resolvePlaywrightCliEntry({ cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  try {
    const pkgFile = require.resolve('@playwright/cli/package.json', { paths: [cwd] });
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const entry = path.resolve(path.dirname(pkgFile), pkg.bin['playwright-cli']);
    if (fs.existsSync(entry)) return entry;
  } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const wrapper = platform === 'win32' ? path.join(dir, 'playwright-cli.cmd') : path.join(dir, 'playwright-cli');
    if (!fs.existsSync(wrapper)) continue;
    for (const pkgFile of [path.join(dir, 'node_modules', '@playwright', 'cli', 'package.json'),
                           path.join(dir, '..', '@playwright', 'cli', 'package.json')]) {
      if (!fs.existsSync(pkgFile)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const entry = path.resolve(path.dirname(pkgFile), pkg.bin['playwright-cli']);
      if (fs.existsSync(entry)) return entry;
    }
    if (platform !== 'win32') {
      const entry = fs.realpathSync(wrapper);
      if (path.extname(entry) === '.js') return entry;
    }
  }
  return null;
}

// AGENTEX_PWCLI_PROBE_CMD is an existing fixture-only seam: a quoted Node path
// and quoted JS file. It is parsed into argv; it never reaches a shell.
function fixtureCommand(value) {
  const match = /^"([^"]+)"\s+"([^"]+)"$/.exec(value);
  if (!match) throw new Error('AGENTEX_PWCLI_PROBE_CMD must contain quoted executable and JS paths');
  return { executable: match[1], args: [match[2], '--version'] };
}

function probePlaywrightCli({ cwd = process.cwd(), env = process.env, platform = process.platform,
  spawn = spawnSync, resolveEntry = resolvePlaywrightCliEntry } = {}) {
  try {
    const command = env.AGENTEX_PWCLI_PROBE_CMD
      ? fixtureCommand(env.AGENTEX_PWCLI_PROBE_CMD)
      : { executable: process.execPath, args: [resolveEntry({ cwd, env, platform }), '--version'] };
    if (!command.args[0]) return { ok: false, status: 'MISSING_DEPENDENCY', error: '@playwright/cli is not installed in the project or on PATH' };
    const r = spawn(command.executable, command.args, { encoding: 'utf8', timeout: 60000, shell: false });
    const judged = judgePlaywrightCliProbe(r, { sandboxed: Boolean(env.CODEX_SANDBOX) });
    return judged.ok ? { ...judged, command: { executable: command.executable, args: command.args.slice(0, -1) } } : judged;
  } catch (e) { return { ok: false, status: 'UNKNOWN_ENVIRONMENT_FAILURE', error: e.message }; }
}

// The playwright PACKAGE, resolved the way session.js resolves it — from the project, not
// from the plugin. Separate from playwright-cli above: only the library can load a saved
// storageState, so /optimize-login needs this one, and finding out at preflight beats
// finding out when a resume fails mid-run.
function probePlaywrightPackage(cwd = process.cwd()) {
  const path = require('path');
  const paths = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) { paths.push(d); if (path.dirname(d) === d) break; }
  for (const name of ['playwright', 'playwright-core']) {
    for (const resolve of [() => require.resolve(name + '/package.json'),
                           () => require.resolve(name + '/package.json', { paths })]) {
      try {
        const pkg = JSON.parse(require('fs').readFileSync(resolve(), 'utf8'));
        return { ok: true, version: `${pkg.name}@${pkg.version}` };
      } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') return { ok: false, error: e.message }; }
    }
  }
  return { ok: false, error: 'not installed in this project — npm i -D playwright && npx playwright install chromium (needed only for /optimize-login session resume)' };
}

module.exports = { probe, judgePlaywrightCliProbe, resolvePlaywrightCliEntry, probePlaywrightCli, probePlaywrightPackage };

// --needs <list> (from spec_drivers.js): without browser, the playwright probes are skipped
// (the CLI probe can take up to 60s). Default: every probe, as before.
function inventory(needs) {
  const skip = { ok: null, skipped: 'not needed by this run' };
  const browser = !needs || needs.has('browser');
  return {
    node: { ok: true, version: process.version },
    'playwright-cli': browser ? probePlaywrightCli() : skip,
    playwright: browser ? probePlaywrightPackage() : skip,
    curl: probe('curl', ['--version']),
    sqlcmd: probe('sqlcmd', ['--version']),
    az: probe('az', ['--version']),
  };
}

module.exports.inventory = inventory;

if (require.main === module) {
  const i = process.argv.indexOf('--needs');
  const needs = i >= 0 ? new Set(String(process.argv[i + 1] || '').split(',').map((x) => x.trim()).filter(Boolean)) : null;
  console.log(JSON.stringify(inventory(needs)));
}
