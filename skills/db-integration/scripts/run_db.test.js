'use strict';
// Tests for run_db.js config resolution — only BLOCKED paths that exit BEFORE
// sqlcmd is spawned (no sqlcmd needed). Run: node skills/db-integration/scripts/run_db.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run_db.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-rundb-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const CATALOG = {
  name: 'sample-db',
  connection: {},
  queries: [{ name: 'ping', description: 'x', params: [], query: 'SELECT 1' }],
};
// Run the runner in a scrubbed env so the host machine's DB_*/SQLCMDPASSWORD can't leak in.
function run(cwd, args) {
  const env = { ...process.env };
  for (const k of ['DB_SERVER', 'DB_PORT', 'DB_NAME', 'DB_USER', 'SQLCMDPASSWORD']) delete env[k];
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: JSON.parse((r.stdout || '{}').trim().split('\n').pop()) };
}

test('named environment without a file -> BLOCKED listing available', () => {
  const dir = proj({ 'integration/sample_db.json': CATALOG, 'environments/qa.json': {} });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--env', 'live', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /available: qa/);
});
test('env db block with user but unresolvable password -> BLOCKED naming the var', () => {
  const dir = proj({
    'integration/sample_db.json': CATALOG,
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 's', name: 'd', user: 'u', password: { envSecret: 'MISSING_PW' } } },
  });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /MISSING_PW/);
});
test('no environment and empty catalog connection -> BLOCKED with guidance', () => {
  const dir = proj({ 'integration/sample_db.json': CATALOG });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /no db config/);
});
test('legacy catalog naming unset DB_NAME -> BLOCKED naming the var', () => {
  const dir = proj({
    'integration/sample_db.json': { ...CATALOG, connection: { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' } },
    '.env': 'DB_SERVER=srv\n',
  });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /DB_NAME/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
