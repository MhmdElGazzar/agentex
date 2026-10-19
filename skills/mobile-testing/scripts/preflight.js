// AgenTeX mobile preflight — checks every tool a mobile run might need, in one call.
//
// Usage: node preflight.js
// Prints ONE JSON line: {"node":{...}, "appium":{...}, "adb":{...}, "xcrun":{...}, "curl":{...}}
// — informational, always exits 0. The agent decides what's required for the run at hand
// (xcrun only matters for iOS, adb only for Android, etc.)
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

console.log(JSON.stringify({
  node: { ok: true, version: process.version },
  appium: probe('npx', ['appium', '--version']),
  adb: probe('adb', ['version']),
  xcrun: probe('xcrun', ['simctl', 'help']),
  curl: probe('curl', ['--version']),
}));
