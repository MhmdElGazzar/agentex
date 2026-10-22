'use strict';
// Tests for run-tests.js — the parallel runner for every tracked *.test.js.
// Each case builds a throwaway git repo of tiny passing/failing tests and runs the
// runner from inside it, so the real suite is never discovered (no recursion).
// Run: node scripts/run-tests.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs, partition, lastLines } = require('./run-tests.js');

const SCRIPT = path.join(__dirname, 'run-tests.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
// A git repo whose tracked tests are `files`; `untracked` are written but never added.
function fixtureRepo(files, untracked = {}) {
  const dir = tmp('agentex-run-tests-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  for (const [rel, body] of Object.entries(untracked)) write(dir, rel, body);
  return dir;
}
function run(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, lines, out: lines.length ? JSON.parse(lines[0]) : null, stderr: r.stderr };
}

const PASS = "console.log('fine');\n";
// 30 numbered stdout lines, then exit 3.
const FAIL = "for (let i = 1; i <= 30; i++) console.log('line ' + i);\nprocess.exitCode = 3;\n";
// Fails with its reason on stderr only (two pipes have no common order, so tests never
// assert how stdout and stderr interleave — only that both are captured).
const FAIL_STDERR = "console.error('the reason is on stderr');\nprocess.exit(4);\n";
// Asserts it runs from the repo root: ROOT_MARKER sits there and nowhere else.
const AT_ROOT = "if (!require('fs').existsSync('ROOT_MARKER')) { console.error('cwd ' + process.cwd()); process.exit(1); }\n";
// Fails if any other test of the same kind is running at the same moment.
const ALONE = `
const fs = require('fs'), path = require('path');
const dir = path.join(process.cwd(), 'active');
fs.mkdirSync(dir, { recursive: true });
const me = path.join(dir, String(process.pid));
fs.writeFileSync(me, '');
const others = fs.readdirSync(dir).filter((f) => f !== String(process.pid));
const end = Date.now() + 150; while (Date.now() < end) {}
fs.unlinkSync(me);
if (others.length) { console.error('overlapped with ' + others); process.exit(1); }
`;
// Passes only when all `n` such tests are running at once (a barrier, 20 s cap).
const together = (n) => `
const fs = require('fs'), path = require('path');
const dir = path.join(process.cwd(), 'barrier');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, String(process.pid)), '');
const deadline = Date.now() + 20000;
(function wait() {
  if (fs.readdirSync(dir).length >= ${n}) return;
  if (Date.now() > deadline) { console.error('never ran together'); process.exit(1); }
  setTimeout(wait, 20);
})();
`;

test('runs every tracked *.test.js; one failure → exit 1, one JSON line with its exit code and a 20-line tail', () => {
  const dir = fixtureRepo({
    'a/pass.test.js': PASS,
    'b/fail.test.js': FAIL,
    'c/deep/other.test.js': PASS,
    'c/helper.js': 'throw new Error("not a test, never run");\n',
  }, { 'untracked.test.js': 'process.exit(9);\n' });
  const r = run(dir);
  assert.strictEqual(r.code, 1, r.stderr);
  assert.strictEqual(r.lines.length, 1, 'exactly one stdout line');
  assert.strictEqual(r.out.ok, false);
  assert.strictEqual(r.out.total, 3, 'tracked tests only — untracked and non-test files are not run');
  assert.strictEqual(r.out.passed, 2);
  assert.strictEqual(r.out.failed.length, 1);
  const f = r.out.failed[0];
  assert.strictEqual(f.file, 'b/fail.test.js');
  assert.strictEqual(f.exit, 3);
  const tail = f.tail.split('\n');
  assert.strictEqual(tail.length, 20);
  assert.ok(tail.includes('line 30') && tail.includes('line 11') && !tail.includes('line 10'), f.tail);
  assert.strictEqual(typeof r.out.durationMs, 'number');
  assert.match(r.stderr, /FAIL b\/fail\.test\.js \(exit 3\)/);
  assert.match(r.stderr, /2\/3 passed, 1 failed/);
});

test('stderr is captured into the tail too', () => {
  const r = run(fixtureRepo({ 'e.test.js': FAIL_STDERR }));
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.out.failed, [{ file: 'e.test.js', exit: 4, tail: 'the reason is on stderr' }]);
});

test('all pass → exit 0, ok:true, failed:[]', () => {
  const dir = fixtureRepo({ 'x.test.js': PASS, 'y/z.test.js': PASS });
  const r = run(dir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([r.out.ok, r.out.total, r.out.passed, r.out.failed], [true, 2, 2, []]);
});

test('each file runs from the repo root, even when the runner is started in a subfolder', () => {
  const dir = fixtureRepo({ ROOT_MARKER: '', 'sub/a.test.js': AT_ROOT, 'sub/deeper/b.test.js': AT_ROOT });
  const r = run(path.join(dir, 'sub', 'deeper'));
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.total, 2);
});

test('--filter <substring> keeps only matching paths', () => {
  const dir = fixtureRepo({ 'keep/one.test.js': PASS, 'keep/two.test.js': PASS, 'drop/bad.test.js': FAIL });
  const r = run(dir, ['--filter', 'keep/']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.out.total, 2);
});

test('--concurrency N runs N files at the same time', () => {
  const dir = fixtureRepo({ 'a.test.js': together(3), 'b.test.js': together(3), 'c.test.js': together(3) });
  const r = run(dir, ['--concurrency', '3']);
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
});

test('--serial and --concurrency 1 never overlap two files', () => {
  const files = { 'a.test.js': ALONE, 'b.test.js': ALONE, 'c.test.js': ALONE, 'd.test.js': ALONE };
  for (const args of [['--serial'], ['--concurrency', '1']]) {
    const r = run(fixtureRepo(files), args);
    assert.strictEqual(r.code, 0, `${args}: ${JSON.stringify(r.out)}`);
    assert.strictEqual(r.out.total, 4);
  }
});

test('usage errors → exit 2 with one JSON line {ok:false,error}', () => {
  const dir = fixtureRepo({ 'a.test.js': PASS });
  for (const args of [['--concurrency', '0'], ['--concurrency', 'x'], ['--filter'], ['--bogus'], ['--filter', 'nothing-matches']]) {
    const r = run(dir, args);
    assert.strictEqual(r.code, 2, `${args.join(' ')} → ${r.code}`);
    assert.strictEqual(r.lines.length, 1);
    assert.strictEqual(r.out.ok, false);
    assert.ok(r.out.error, args.join(' '));
  }
});

test('outside a git repo → exit 2 (IO error), nothing run', () => {
  const r = run(tmp('agentex-run-tests-nogit-'));
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.out.ok, false);
});

test('parseArgs: defaults to the CPU count; --serial means concurrency 1', () => {
  assert.strictEqual(parseArgs([]).concurrency, Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
  assert.strictEqual(parseArgs(['--serial']).concurrency, 1);
  assert.deepStrictEqual(parseArgs(['--concurrency', '4', '--filter', 'lib']), { concurrency: 4, filter: 'lib', serial: false });
  assert.throws(() => parseArgs(['--concurrency', '-1']), /concurrency/);
});

test('partition: SERIAL_ONLY files leave the pool and run after it, in list order', () => {
  const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'];
  assert.deepStrictEqual(partition(files, ['d.test.js', 'b.test.js', 'gone.test.js']),
    { pool: ['a.test.js', 'c.test.js'], serial: ['d.test.js', 'b.test.js'] });
  assert.deepStrictEqual(partition(files, []), { pool: files, serial: [] });
});

test('lastLines: the last n lines, trailing blank lines dropped, CRLF tolerated', () => {
  assert.strictEqual(lastLines('a\nb\nc\n\n', 2), 'b\nc');
  assert.strictEqual(lastLines('a\r\nb\r\n', 5), 'a\nb');
  assert.strictEqual(lastLines('', 5), '');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
