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

// A fake `sqlcmd` first on PATH records its arguments and writes its -o result file like the
// real one, so the output encoding is checked without a database. POSIX only: spawnSync
// ('sqlcmd') resolves an .exe on Windows, which a script cannot stand in for.
const NON_ASCII = 'مرحبا بالعالم — Привет, мир — 你好，世界';
function runWithFakeSqlcmd(fileEncoding) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-fake-sqlcmd-'));
  const argsFile = path.join(bin, 'args.json');
  fs.writeFileSync(path.join(bin, 'sqlcmd'), [
    `#!${process.execPath}`,
    `const fs = require('fs'); const a = process.argv.slice(2);`,
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));`,
    `const text = ${JSON.stringify(NON_ASCII + '\r\n\r\n(1 rows affected)\r\n')};`,
    `const out = a[a.indexOf('-o') + 1];`,
    `const enc = ${JSON.stringify(fileEncoding)};`,
    `fs.writeFileSync(out, enc === 'utf16le-bom'`,
    `  ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')])`,
    `  : enc === 'utf16le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf8'));`,
  ].join('\n'), { mode: 0o755 });
  const dir = proj({
    'integration/sample_db.json': CATALOG,
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 's', name: 'd' } },
  });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const k of ['DB_SERVER', 'DB_PORT', 'DB_NAME', 'DB_USER', 'SQLCMDPASSWORD']) delete env[k];
  const r = spawnSync(process.execPath, [RUNNER, '--entry', 'sample-db.ping', '--expect-rows', '1', '--log', path.join(dir, 'x.log')], { cwd: dir, encoding: 'utf8', env });
  return {
    code: r.status, out: JSON.parse((r.stdout || '{}').trim().split('\n').pop()),
    args: JSON.parse(fs.readFileSync(argsFile, 'utf8')), log: fs.readFileSync(path.join(dir, 'x.log'), 'utf8'),
  };
}
if (process.platform === 'win32') {
  console.log('  skip - sqlcmd result encoding (needs a POSIX shell for the fake sqlcmd)');
} else {
  test('sqlcmd writes a Unicode result file (-u -o): non-ASCII text reaches the log intact, rows counted', () => {
    const { code, out, args, log } = runWithFakeSqlcmd('utf16le-bom');
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.rows, 1);
    assert.ok(args.includes('-u'), `sqlcmd args lack -u: ${args.join(' ')}`);
    const o = args.indexOf('-o');
    assert.ok(o >= 0 && args[o + 1], `sqlcmd args lack -o <file>: ${args.join(' ')}`);
    assert.ok(!fs.existsSync(args[o + 1]), 'the temp result file was not removed');
    assert.ok(log.includes(NON_ASCII), 'non-ASCII text lost in the log');
  });
  test('a UTF-8 result file (a sqlcmd that ignores -u) is read as UTF-8', () => {
    const { code, out, log } = runWithFakeSqlcmd('utf8');
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.ok(log.includes(NON_ASCII), 'non-ASCII text lost in the log');
  });
  test('a UTF-16LE result file without a BOM is read as UTF-16LE', () => {
    const { code, out, log } = runWithFakeSqlcmd('utf16le');
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.rows, 1);
    assert.ok(log.includes(NON_ASCII), 'non-ASCII text lost in the log');
  });
}

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
