'use strict';
// Unit tests for scripts/lib/learnings.js — the plugin-learnings file grammar, the
// append under a lock, the one-line absorbed mark (field-feedback-loop S-1).
// Run: node scripts/lib/learnings.test.js
// Offline. The clock, the random source and the lock timings are injected; the
// 20-child concurrency test spawns real processes (test-side only).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('./learnings.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const NOW = new Date('2026-10-22T10:15:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-learn-'));
const file = (dir) => path.join(dir, L.FILE_REL);
const lockFile = (dir) => path.join(dir, L.LOCK_REL);
function opts(extra = {}) {
  let n = 0;
  const hex = extra.hex || ['7f3a', 'c41e', '0a0b', '1c1d'];
  return { now: () => NOW, randomHex: () => hex[n++ % hex.length], lockWaitMs: 80, lockRetryMs: 10, ...extra };
}
const entry = (o = {}) => ({
  trigger: 'workaround', affected: 'test-design', version: '0.26.0',
  fields: { problem: 'The skill could not attach steps.', workaround: 'Called the CLI directly.', mode: 'sequential' }, ...o,
});
// Every file under dir (relative, posix), files only.
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}
function runChild(code, cwd) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, out, err }));
  });
}

(async () => {
  // ---- first test: 20 concurrent appenders, one header, byte identity ------------------
  await test('20 concurrent appends: 20 intact, non-interleaved entries and ONE header; earlier bytes identical', async () => {
    const dir = tmp();
    // a first entry through the API, then the snapshot every later append must preserve
    await L.appendEntry(dir, entry(), opts());
    const before = fs.readFileSync(file(dir));
    const lib = JSON.stringify(path.join(__dirname, 'learnings.js'));
    const kids = [];
    for (let i = 0; i < 20; i++) {
      const code = `const L=require(${lib});L.appendEntry(process.cwd(),{trigger:'workaround',affected:'unknown',version:'0.26.0',fields:{problem:'child ${i} problem line one\\nline two of ${i}',workaround:'child ${i} workaround'}}).then(r=>{console.log(JSON.stringify(r))},e=>{console.error(e.message);process.exit(1)})`;
      kids.push(runChild(code, dir));
    }
    const res = await Promise.all(kids);
    res.forEach((r, i) => assert.strictEqual(r.status, 0, `child ${i}: ${r.err}`));
    const after = fs.readFileSync(file(dir));
    assert.ok(after.slice(0, before.length).equals(before), 'every pre-existing byte identical');
    const parsed = L.parse(after);
    assert.strictEqual(parsed.entries.length, 21);
    assert.strictEqual(parsed.unparsed, 0);
    assert.strictEqual(new Set(parsed.entries.map((e) => e.id)).size, 21, 'unique ids');
    const headers = after.toString('utf8').split('\n').filter((l) => l.startsWith('<!-- agentex:plugin-learnings'));
    assert.strictEqual(headers.length, 1);
    for (let i = 0; i < 20; i++) {
      const e = parsed.entries.find((x) => x.fields.problem === `child ${i} problem line one\nline two of ${i}`);
      assert.ok(e, `child ${i} entry intact`);
      assert.strictEqual(e.fields.workaround, `child ${i} workaround`);
    }
    assert.deepStrictEqual(files(dir).filter((f) => f.endsWith('.lock')), [], 'no lock left behind');
  });

  await test('append creates the file with its header; the second append adds only the entry', async () => {
    const dir = tmp();
    const r1 = await L.appendEntry(dir, entry(), opts());
    assert.strictEqual(r1.created, true);
    assert.strictEqual(r1.file, '.agentex/plugin-learnings.md');
    assert.match(r1.id, /^PL-20261022T101500Z-7f3a$/);
    const t1 = fs.readFileSync(file(dir), 'utf8');
    assert.ok(t1.startsWith('<!-- agentex:plugin-learnings schemaVersion=1 -->\n# AgenTeX plugin learnings\n'));
    assert.ok(t1.includes('- [ ] PL-20261022T101500Z-7f3a · 2026-10-22 · workaround · test-design · v0.26.0\n  problem: The skill could not attach steps.\n  workaround: Called the CLI directly.\n  mode: sequential\n'));
    const r2 = await L.appendEntry(dir, entry(), opts({ hex: ['aaaa'] }));
    assert.strictEqual(r2.created, false);
    const t2 = fs.readFileSync(file(dir), 'utf8');
    assert.ok(t2.startsWith(t1));
    assert.strictEqual(t2.slice(t1.length).split('\n')[0], '- [ ] PL-20261022T101500Z-aaaa · 2026-10-22 · workaround · test-design · v0.26.0');
  });

  await test('grammar round-trip: all fields, multi-line continuation, non-ASCII and RTL intact', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry({
      trigger: 'forked-skill', affected: 'task-estimation',
      fields: { problem: 'مشكلة: الوصف\nsecond line — ünï', workaround: 'نسخنا المهارة', mode: 'parallel', session: 's-1', script: 'tools/x.js', fork: '.claude/skills/task-estimation/', rule: 'CLAUDE.md' },
    }), opts());
    const p = L.parse(fs.readFileSync(file(dir)));
    assert.strictEqual(p.schemaVersion, 1);
    assert.strictEqual(p.hasHeader, true);
    const e = p.entries[0];
    assert.strictEqual(e.status, 'open');
    assert.strictEqual(e.trigger, 'forked-skill');
    assert.strictEqual(e.affected, 'task-estimation');
    assert.strictEqual(e.version, '0.26.0');
    assert.strictEqual(e.date, '2026-10-22');
    assert.strictEqual(e.fields.problem, 'مشكلة: الوصف\nsecond line — ünï');
    assert.strictEqual(e.fields.workaround, 'نسخنا المهارة');
    assert.deepStrictEqual([e.fields.mode, e.fields.session, e.fields.script, e.fields.fork, e.fields.rule], ['parallel', 's-1', 'tools/x.js', '.claude/skills/task-estimation/', 'CLAUDE.md']);
  });

  await test('text can never forge an entry or header line (every text line is indented)', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry({ fields: { problem: 'a\n- [ ] PL-20260101T000000Z-dead · 2026-01-01 · workaround · x · v1\n<!-- agentex:plugin-learnings schemaVersion=9 -->', workaround: 'w' } }), opts());
    const p = L.parse(fs.readFileSync(file(dir)));
    assert.strictEqual(p.entries.length, 1);
    assert.strictEqual(p.schemaVersion, 1);
    assert.strictEqual(p.unparsed, 0);
  });

  await test('CRLF file stays CRLF: the append uses the file\'s own line ending', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts());
    const crlf = fs.readFileSync(file(dir), 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(file(dir), crlf);
    await L.appendEntry(dir, entry({ fields: { problem: 'two\nlines', workaround: 'w' } }), opts({ hex: ['bbbb'] }));
    const out = fs.readFileSync(file(dir), 'utf8');
    assert.ok(out.startsWith(crlf));
    assert.ok(!/(^|[^\r])\n/.test(out), 'no bare LF anywhere');
    assert.strictEqual(L.parse(Buffer.from(out)).entries.length, 2);
  });

  await test('user-edited and unknown lines are kept; unparsed column-0 lines counted, never touched', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts());
    let text = fs.readFileSync(file(dir), 'utf8');
    text += '  a hand-added indented line with no key\n  note: and an unknown key\n';
    text += 'A stray note the user typed at column 0\n';
    text += '- [ ] this is not a valid entry line\n';
    fs.writeFileSync(file(dir), text);
    await L.appendEntry(dir, entry(), opts({ hex: ['cccc'] }));
    const out = fs.readFileSync(file(dir), 'utf8');
    assert.ok(out.startsWith(text), 'the user\'s lines are still there, byte for byte');
    const p = L.parse(Buffer.from(out));
    assert.strictEqual(p.entries.length, 2);
    assert.strictEqual(p.unparsed, 2);
    assert.deepStrictEqual(Object.keys(p.entries[0].fields).filter((k) => !['problem', 'workaround', 'mode', 'note'].includes(k)), [], 'a keyless indented line is ignored');
    assert.strictEqual(p.entries[0].fields.problem, 'The skill could not attach steps.');
  });

  await test('a file that does not end in a newline never merges into its last line', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts());
    const text = fs.readFileSync(file(dir), 'utf8').replace(/\n$/, '');
    fs.writeFileSync(file(dir), text);
    await L.appendEntry(dir, entry(), opts({ hex: ['dddd'] }));
    assert.strictEqual(L.parse(fs.readFileSync(file(dir))).entries.length, 2);
  });

  await test('a missing header parses as v1 and none is ever prepended', async () => {
    const dir = tmp();
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    const body = '- [ ] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0\n  problem: p\n  workaround: w\n';
    fs.writeFileSync(file(dir), body);
    assert.strictEqual(L.parse(Buffer.from(body)).schemaVersion, 1);
    assert.strictEqual(L.parse(Buffer.from(body)).hasHeader, false);
    const r = await L.appendEntry(dir, entry(), opts({ hex: ['eeee'] }));
    assert.strictEqual(r.created, false);
    const out = fs.readFileSync(file(dir), 'utf8');
    assert.ok(out.startsWith(body));
    assert.ok(!out.includes('agentex:plugin-learnings'), 'no header prepended or added');
  });

  await test('a newer schema is refused on write (newer-schema, exit 2) and read verbs still parse', async () => {
    const dir = tmp();
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    const body = '<!-- agentex:plugin-learnings schemaVersion=2 -->\n# t\n\n- [ ] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0\n  problem: p\n  workaround: w\n';
    fs.writeFileSync(file(dir), body);
    await assert.rejects(L.appendEntry(dir, entry(), opts()), (e) => e.reason === 'newer-schema' && e.code === 2);
    assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), body, 'untouched');
    const p = L.parse(Buffer.from(body));
    assert.strictEqual(p.schemaVersion, 2);
    assert.strictEqual(p.entries.length, 1);
  });

  await test('field limits: 2,000 chars per field cut with the marker; 8 KiB per entry', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry({ fields: { problem: 'x'.repeat(5000), workaround: 'y'.repeat(100) } }), opts());
    let e = L.parse(fs.readFileSync(file(dir))).entries[0];
    assert.strictEqual(e.fields.problem, `${'x'.repeat(2000)}…[truncated]`);
    assert.strictEqual(e.fields.workaround, 'y'.repeat(100));
    const dir2 = tmp();
    const big = { problem: 'é'.repeat(1990), workaround: 'ж'.repeat(1990), mode: 'sequential', session: 'z'.repeat(1990), script: 'a/'.repeat(995), fork: 'b/'.repeat(995), rule: 'CLAUDE.md' };
    await L.appendEntry(dir2, entry({ fields: big }), opts());
    const text = fs.readFileSync(file(dir2), 'utf8');
    const start = text.indexOf('- [ ] ');
    assert.ok(Buffer.byteLength(text.slice(start)) <= 8192, `entry is ${Buffer.byteLength(text.slice(start))} bytes`);
    e = L.parse(Buffer.from(text)).entries[0];
    assert.ok(e.fields.problem.length > 0 && e.fields.workaround.length > 0);
  });

  await test('required fields: an empty problem or workaround is refused (exit 2), nothing written', async () => {
    const dir = tmp();
    await assert.rejects(L.appendEntry(dir, entry({ fields: { problem: '  ', workaround: 'w' } }), opts()), (e) => e.code === 2 && e.reason === 'usage');
    await assert.rejects(L.appendEntry(dir, entry({ fields: { problem: 'p' } }), opts()), (e) => e.code === 2);
    assert.ok(!fs.existsSync(file(dir)));
  });

  await test('markAbsorbed changes exactly one line, byte for byte, and keeps invalid UTF-8 elsewhere', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts());
    await L.appendEntry(dir, entry({ trigger: 'forked-skill', affected: 'task-estimation' }), opts({ hex: ['9999'] }));
    const buf = Buffer.concat([fs.readFileSync(file(dir)), Buffer.from([0x80, 0xff, 0x0a])]);
    const target = L.parse(buf).entries[1];
    const out = L.markAbsorbed(buf, [{ id: target.id, version: '0.27.0' }]);
    const a = buf.toString('latin1').split('\n'); const b = out.toString('latin1').split('\n');
    assert.strictEqual(a.length, b.length);
    const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    assert.strictEqual(diff.length, 1, 'exactly one line changed');
    assert.strictEqual(Buffer.from(b[diff[0]], 'latin1').toString('utf8'), '- [x] PL-20261022T101500Z-9999 · 2026-10-22 · forked-skill · task-estimation · v0.26.0 · absorbed in v0.27.0');
    const p = L.parse(out);
    assert.strictEqual(p.entries[1].status, 'absorbed');
    assert.strictEqual(p.entries[1].absorbedIn, '0.27.0');
    assert.strictEqual(p.entries[0].status, 'open');
    assert.ok(out.slice(out.length - 3).equals(Buffer.from([0x80, 0xff, 0x0a])), 'invalid UTF-8 survived');
  });

  await test('markAbsorbed refuses an unknown or already absorbed id', async () => {
    const dir = tmp();
    const r = await L.appendEntry(dir, entry(), opts());
    const buf = fs.readFileSync(file(dir));
    assert.throws(() => L.markAbsorbed(buf, [{ id: 'PL-nope', version: '1.0.0' }]), (e) => e.code === 2);
    const done = L.markAbsorbed(buf, [{ id: r.id, version: '1.0.0' }]);
    assert.throws(() => L.markAbsorbed(done, [{ id: r.id, version: '1.0.0' }]), (e) => e.code === 2);
  });

  await test('lineSha is stable for the entry line and changes when the line is edited', async () => {
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts());
    const buf = fs.readFileSync(file(dir));
    const e = L.parse(buf).entries[0];
    assert.match(e.lineSha, /^[0-9a-f]{16}$/);
    assert.strictEqual(L.parse(buf).entries[0].lineSha, e.lineSha);
    const edited = Buffer.from(buf.toString('utf8').replace('test-design', 'estimate-story'));
    assert.notStrictEqual(L.parse(edited).entries[0].lineSha, e.lineSha);
  });

  await test('a live lock past the wait is exit 1 lock-busy; the entry is not written', async () => {
    const dir = tmp();
    fs.mkdirSync(path.dirname(lockFile(dir)), { recursive: true });
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'x' }));
    await assert.rejects(L.appendEntry(dir, entry(), { ...opts({ now: () => new Date() }) }), (e) => e.reason === 'lock-busy' && e.code === 1);
    assert.ok(!fs.existsSync(file(dir)));
    assert.ok(fs.existsSync(lockFile(dir)), 'someone else\'s lock is left alone');
  });

  await test('a stale lock (older than 60 s) is broken loudly', async () => {
    const dir = tmp();
    fs.mkdirSync(path.dirname(lockFile(dir)), { recursive: true });
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 1, at: new Date(NOW.getTime() - 120_000).toISOString(), token: 'x' }));
    const r = await L.appendEntry(dir, entry(), opts());
    assert.strictEqual(r.brokeStaleLock, true);
    assert.strictEqual(L.parse(fs.readFileSync(file(dir))).entries.length, 1);
    assert.ok(!fs.existsSync(lockFile(dir)));
  });

  await test('id: PL-<UTC stamp>-<4 hex>; a taken id is redrawn', async () => {
    assert.strictEqual(L.newId(NOW, () => 'ABCD'), 'PL-20261022T101500Z-abcd');
    const dir = tmp();
    await L.appendEntry(dir, entry(), opts({ hex: ['7f3a', '7f3a', '1111'] }));
    const r = await L.appendEntry(dir, entry(), opts({ hex: ['7f3a', '1111'] }));
    assert.strictEqual(r.id, 'PL-20261022T101500Z-1111');
  });

  await test('structural: no process.exit, no network module in learnings.js', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'learnings.js'), 'utf8');
    assert.ok(!src.includes('process.exit('));
    assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|child_process)['"]\)/.test(src));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
