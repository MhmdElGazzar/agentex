// AgenTeX preflight — checks every tool a run might need, in one call.
//
// Usage: node preflight.js [--needs browser,api,db]
// Prints ONE JSON line: {"playwright-cli": {...}, "playwright": {...}, "curl": {...},
// "sqlcmd": {...}, "az": {...}, "node": {...}} — informational, always exits 0.
// The agent decides what's required for the run at hand (sqlcmd only matters for db: steps, etc.)
//
// Probe posture (backlog/preflight-probe-false-negative): the playwright-cli probe
// judges by OUTPUT, not exit code alone. On Windows + Node v24 a working
// @playwright/cli prints its version and then dies on its own exit path with an
// upstream libuv assertion (UV_HANDLE_CLOSING) — a benign exit-crash, not a broken
// tool. When the version output is present AND the crash matches that known
// signature, the tool is reported usable with a note; any other failure keeps
// reporting broken exactly as before. The exception is scoped to the
// playwright-cli probe only, keyed to the known signature.
const { spawnSync } = require('child_process');

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
function judgePlaywrightCliProbe(r) {
  if (r.error) return { ok: false, error: r.error.message };
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.status === 0) {
    const first = (stdout + stderr).trim().split('\n').find(l => l.trim()) || '';
    return { ok: true, version: first.trim().slice(0, 120) };
  }
  // Non-zero exit: trust the evidence the probe already has. A plausible version
  // line (outside the crash text) + the known benign signature = a usable tool.
  const versionLine = (stdout + '\n' + stderr).split('\n')
    .find(l => VERSION_LINE.test(l) && !CRASH_TEXT.test(l));
  if (versionLine && BENIGN_EXIT_CRASH.test(stdout + stderr)) {
    return {
      ok: true,
      version: versionLine.trim().slice(0, 120),
      note: 'version confirmed; known benign exit-crash on this stack',
    };
  }
  return { ok: false, error: stderr.trim().split('\n')[0] || `exit ${r.status}` };
}

// The playwright-cli probe. AGENTEX_PWCLI_PROBE_CMD is a fixture-only test seam
// (replaces the probed command so tests never need a live install).
function probePlaywrightCli() {
  const cmd = process.env.AGENTEX_PWCLI_PROBE_CMD || 'npx playwright-cli --version';
  try {
    const r = spawnSync(cmd, { encoding: 'utf8', timeout: 60000, shell: true });
    return judgePlaywrightCliProbe(r);
  } catch (e) { return { ok: false, error: e.message }; }
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

module.exports = { probe, judgePlaywrightCliProbe, probePlaywrightCli, probePlaywrightPackage };

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
