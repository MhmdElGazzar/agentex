// AgenTeX preflight — checks every tool a run might need, in one call.
//
// Usage: node preflight.js
// Prints ONE JSON line: {"playwright-cli": {...}, "playwright": {...}, "curl": {...},
// "sqlcmd": {...}, "az": {...}, "node": {...}} — informational, always exits 0.
// The agent decides what's required for the run at hand (sqlcmd only matters for db: steps, etc.)
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

console.log(JSON.stringify({
  node: { ok: true, version: process.version },
  'playwright-cli': probe('npx', ['playwright-cli', '--version']),
  playwright: probePlaywrightPackage(),
  curl: probe('curl', ['--version']),
  sqlcmd: probe('sqlcmd', ['--version']),
  az: probe('az', ['--version']),
}));
