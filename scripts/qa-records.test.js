'use strict';
// Unit tests for the QA watchlist helper, scripts/qa-records.js
// (skill-consolidation-foundation R8 / WP-10).
// Run: node scripts/qa-records.test.js
// Fully offline. The clock, the randomness and the lock timings are INJECTED.
// The default paths are never repeated here: every expectation reads
// STRUCTURED_DEFAULTS.qaRecords (the one home of those paths).
// spawnSync appears ONLY here (test-side) to pin the one-JSON-line CLI
// contract; the delivered script spawns nothing.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run, headerFor, KINDS } = require('./qa-records.js');
const { STRUCTURED_DEFAULTS: D } = require('./lib/project_config.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const ALL_KINDS = Object.keys(D.qaRecords);
const NOW = new Date('2026-10-09T08:07:06.123Z');
// A fixed clock and a scripted hex source — ids become predictable.
function opts(cwd, extra = {}) {
  let n = 0;
  const hex = extra.hex || ['a1b2', 'c3d4', 'e5f6', '0a0b', '1c1d', '2e2f', '3a3b', '4c4d'];
  return { cwd, now: () => NOW, randomHex: () => hex[n++ % hex.length], lockWaitMs: 60, lockRetryMs: 10, ...extra };
}
function proj(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-qa-'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(config, null, 2));
  }
  return dir;
}
const fileOf = (dir, kind) => path.join(dir, D.qaRecords[kind]);
const folderOf = (dir) => path.join(dir, path.dirname(D.qaRecords.pendingQuestions));
const read = (p) => fs.readFileSync(p, 'utf8');
// Every path under dir (relative, posix), for "nothing was created" checks.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p).split(path.sep).join('/'));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
// Exactly one line differs between a and b (same line count, every other byte equal).
function oneLineChanged(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  assert.strictEqual(a.length, b.length, 'same number of lines');
  const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.strictEqual(diff.length, 1, `exactly one line changed (got ${diff.length})`);
  const i = diff[0];
  assert.strictEqual([...a.slice(0, i), b[i], ...a.slice(i + 1)].join('\n'), after, 'every other byte unchanged');
  return { index: i, before: a[i], after: b[i] };
}

(async () => {
  await test('KINDS are exactly the qaRecords config keys', async () => {
    assert.deepStrictEqual(KINDS, ALL_KINDS);
  });

  await test('headerFor(kind): the Markdown header — marker comment, title, blank line; unknown kind throws', async () => {
    for (const k of ALL_KINDS) {
      const h = headerFor(k);
      const lines = h.split('\n');
      assert.strictEqual(lines[0], `<!-- agentex:qa-records kind=${k} schemaVersion=1 -->`);
      assert.match(lines[1], /^# \S/);
      assert.strictEqual(lines[2], '');
      assert.ok(h.endsWith('\n\n'), 'ends in a blank line');
    }
    assert.strictEqual(new Set(ALL_KINDS.map((k) => headerFor(k).split('\n')[1])).size, 4, 'four distinct titles');
    assert.throws(() => headerFor('nope'), /pendingQuestions/);
  });

  await test('LAZY: no file and no folder exist before the first append — list and resolve create nothing', async () => {
    const dir = proj();
    assert.deepStrictEqual(tree(dir), []);
    const l = await run(['list', '--kind', 'all', '--status', 'all'], opts(dir));
    assert.strictEqual(l.code, 0, JSON.stringify(l.out));
    assert.deepStrictEqual(l.out.entries, []);
    assert.strictEqual(l.out.count, 0);
    const r = await run(['resolve', '--kind', 'envIssues', '--id', 'blocker-20261009080706-a1b2', '--resolution', 'x'], opts(dir));
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.out.reason, 'unknown-id');
    assert.deepStrictEqual(tree(dir), [], 'still nothing on disk');
    assert.ok(!fs.existsSync(folderOf(dir)));
  });

  await test('append creates the folder and ONLY that kind\'s file, with headerFor(kind); id + timestamp; created flag', async () => {
    const dir = proj();
    const r = await run(['append', '--kind', 'pendingQuestions', '--text', 'Which export format is the default?', '--ref', '42'], opts(dir));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.ok, true);
    assert.strictEqual(r.out.kind, 'pendingQuestions');
    assert.strictEqual(r.out.file, D.qaRecords.pendingQuestions);
    assert.strictEqual(r.out.created, true);
    assert.match(r.out.id, /^[a-z]+-20261009080706-a1b2$/);
    assert.strictEqual(r.out.createdAt, NOW.toISOString());
    const folderRel = path.posix.dirname(D.qaRecords.pendingQuestions);
    assert.deepStrictEqual(tree(dir), [folderRel, D.qaRecords.pendingQuestions].sort(), 'only that kind\'s file; no lock left behind');
    assert.strictEqual(read(fileOf(dir, 'pendingQuestions')),
      headerFor('pendingQuestions') +
      `- [ ] ${r.out.id} · ${NOW.toISOString()} · 42\n` +
      '  Which export format is the default?\n');
    const r2 = await run(['append', '--kind', 'pendingQuestions', '--text', 'Second'], opts(dir, { hex: ['ffff'] }));
    assert.strictEqual(r2.code, 0);
    assert.strictEqual(r2.out.created, false);
    assert.ok(read(fileOf(dir, 'pendingQuestions')).endsWith(`- [ ] ${r2.out.id} · ${NOW.toISOString()} · —\n  Second\n`), 'no ref -> an em dash');
    assert.strictEqual(read(fileOf(dir, 'pendingQuestions')).split('agentex:qa-records').length, 2, 'the header is written once');
  });

  await test('ids: <kind-prefix>-<UTC yyyymmddHHMMss>-<4 hex>; each kind has its own prefix', async () => {
    const dir = proj();
    const prefixes = [];
    for (const k of ALL_KINDS) {
      const r = await run(['append', '--kind', k, '--text', 't'], opts(dir));
      assert.strictEqual(r.code, 0, JSON.stringify(r.out));
      const m = /^([a-z]+)-(\d{14})-([0-9a-f]{4})$/.exec(r.out.id);
      assert.ok(m, r.out.id);
      assert.strictEqual(m[2], '20261009080706');
      prefixes.push(m[1]);
    }
    assert.strictEqual(new Set(prefixes).size, 4, `distinct prefixes: ${prefixes}`);
  });

  await test('an id collision in the same file draws new randomness (never a duplicate id)', async () => {
    const dir = proj();
    const a = await run(['append', '--kind', 'envIssues', '--text', 'one'], opts(dir, { hex: ['abcd'] }));
    const b = await run(['append', '--kind', 'envIssues', '--text', 'two'], opts(dir, { hex: ['abcd', 'abcd', 'beef'] }));
    assert.strictEqual(b.code, 0, JSON.stringify(b.out));
    assert.notStrictEqual(a.out.id, b.out.id);
    assert.ok(b.out.id.endsWith('-beef'));
  });

  await test('multi-line text: every text line indented two spaces — text can never forge a column-0 entry line', async () => {
    const dir = proj();
    const forged = 'first line\n- [ ] fake-20260101000000-0000 · 2026-01-01T00:00:00.000Z · 7\n\nlast';
    const r = await run(['append', '--kind', 'pendingRechecks', '--text', forged], opts(dir));
    assert.strictEqual(r.code, 0);
    const body = read(fileOf(dir, 'pendingRechecks')).slice(headerFor('pendingRechecks').length);
    assert.strictEqual(body, `- [ ] ${r.out.id} · ${NOW.toISOString()} · —\n  first line\n  - [ ] fake-20260101000000-0000 · 2026-01-01T00:00:00.000Z · 7\n  \n  last\n`);
    const l = await run(['list', '--kind', 'pendingRechecks'], opts(dir));
    assert.strictEqual(l.out.count, 1);
    assert.strictEqual(l.out.entries[0].text, forged, 'the text round-trips exactly');
  });

  await test('list filters by kind, status (default open) and ref', async () => {
    const dir = proj();
    const q1 = await run(['append', '--kind', 'pendingQuestions', '--text', 'q1', '--ref', '42'], opts(dir, { hex: ['0001'] }));
    await run(['append', '--kind', 'pendingQuestions', '--text', 'q2', '--ref', '43'], opts(dir, { hex: ['0002'] }));
    await run(['append', '--kind', 'envIssues', '--text', 'e1', '--ref', '42'], opts(dir, { hex: ['0003'] }));
    const res = await run(['resolve', '--kind', 'pendingQuestions', '--id', q1.out.id, '--resolution', 'CSV, per the PO'], opts(dir));
    assert.strictEqual(res.code, 0, JSON.stringify(res.out));
    const texts = (r) => r.out.entries.map((e) => e.text).sort();
    assert.deepStrictEqual(texts(await run(['list'], opts(dir))), ['e1', 'q2'], 'default: every kind, open only');
    assert.deepStrictEqual(texts(await run(['list', '--status', 'all'], opts(dir))), ['e1', 'q1', 'q2']);
    assert.deepStrictEqual(texts(await run(['list', '--status', 'resolved'], opts(dir))), ['q1']);
    assert.deepStrictEqual(texts(await run(['list', '--kind', 'envIssues', '--status', 'all'], opts(dir))), ['e1']);
    assert.deepStrictEqual(texts(await run(['list', '--ref', '42', '--status', 'all'], opts(dir))), ['e1', 'q1']);
    const one = (await run(['list', '--status', 'resolved'], opts(dir))).out.entries[0];
    assert.strictEqual(one.kind, 'pendingQuestions');
    assert.strictEqual(one.status, 'resolved');
    assert.strictEqual(one.resolution, 'CSV, per the PO');
    assert.strictEqual(one.resolvedAt, NOW.toISOString());
    assert.strictEqual(one.ref, '42');
    for (const bad of [['list', '--kind', 'nope'], ['list', '--status', 'closed']]) {
      const r = await run(bad, opts(dir));
      assert.strictEqual(r.code, 2, bad.join(' '));
    }
  });

  await test('resolve (.md) replaces exactly ONE line — the entry\'s first — and leaves every other byte unchanged', async () => {
    const dir = proj();
    const ids = [];
    for (const t of ['alpha\nalpha 2', 'beta', 'gamma']) {
      const r = await run(['append', '--kind', 'deferredConditions', '--text', t, '--ref', 'PROJ-7'], opts(dir, { hex: [String(ids.length).padStart(4, '0')] }));
      ids.push(r.out.id);
    }
    const before = read(fileOf(dir, 'deferredConditions'));
    const r = await run(['resolve', '--kind', 'deferredConditions', '--id', ids[1], '--resolution', 'Covered by\nthe regression suite'], opts(dir));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.status, 'resolved');
    const after = read(fileOf(dir, 'deferredConditions'));
    const ch = oneLineChanged(before, after);
    assert.strictEqual(ch.before, `- [ ] ${ids[1]} · ${NOW.toISOString()} · PROJ-7`);
    assert.strictEqual(ch.after, `- [x] ${ids[1]} · ${NOW.toISOString()} · PROJ-7 · resolved ${NOW.toISOString()}: Covered by the regression suite`);
    assert.ok(!fs.existsSync(`${fileOf(dir, 'deferredConditions')}.tmp`) && !fs.existsSync(`${fileOf(dir, 'deferredConditions')}.lock`));
  });

  await test('resolve keeps a CRLF file\'s line endings and a file without a trailing newline intact', async () => {
    const dir = proj();
    const r = await run(['append', '--kind', 'envIssues', '--text', 'one'], opts(dir));
    const f = fileOf(dir, 'envIssues');
    fs.writeFileSync(f, read(f).replace(/\n/g, '\r\n').replace(/\r\n$/, '')); // an editor's CRLF, no final newline
    const before = read(f);
    assert.strictEqual((await run(['resolve', '--kind', 'envIssues', '--id', r.out.id, '--resolution', 'fixed'], opts(dir))).code, 0);
    const after = read(f);
    assert.strictEqual(after, before.replace(`- [ ] ${r.out.id} · ${NOW.toISOString()} · —`, `- [x] ${r.out.id} · ${NOW.toISOString()} · — · resolved ${NOW.toISOString()}: fixed`));
    const a2 = await run(['append', '--kind', 'envIssues', '--text', 'two'], opts(dir, { hex: ['9999'] }));
    assert.strictEqual(a2.code, 0);
    const l = await run(['list', '--kind', 'envIssues', '--status', 'all'], opts(dir));
    assert.deepStrictEqual(l.out.entries.map((e) => [e.text, e.status]), [['one', 'resolved'], ['two', 'open']], 'an append after a missing final newline never merges lines');
  });

  await test('.jsonl (a team override, chosen by extension): one object per line, no header; resolve replaces exactly that one line', async () => {
    const dir = proj({ qaRecords: { envIssues: 'notes/env.jsonl' } });
    const a = await run(['append', '--kind', 'envIssues', '--text', 'Staging DB down', '--ref', '42'], opts(dir, { hex: ['0001'] }));
    const b = await run(['append', '--kind', 'envIssues', '--text', 'SSO flaky'], opts(dir, { hex: ['0002'] }));
    assert.strictEqual(a.code, 0, JSON.stringify(a.out));
    assert.strictEqual(a.out.file, 'notes/env.jsonl');
    const f = path.join(dir, 'notes', 'env.jsonl');
    const before = read(f);
    const lines = before.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0], { schemaVersion: 1, id: a.out.id, kind: 'envIssues', status: 'open', createdAt: NOW.toISOString(), ref: '42', text: 'Staging DB down', data: null });
    assert.deepStrictEqual(Object.keys(lines[1]), ['schemaVersion', 'id', 'kind', 'status', 'createdAt', 'ref', 'text', 'data']);
    const r = await run(['resolve', '--kind', 'envIssues', '--id', a.out.id, '--resolution', 'Restored'], opts(dir));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const ch = oneLineChanged(before, read(f));
    assert.deepStrictEqual(JSON.parse(ch.after), { ...lines[0], status: 'resolved', resolvedAt: NOW.toISOString(), resolution: 'Restored' });
    assert.ok(!fs.existsSync(fileOf(dir, 'envIssues')), 'the overridden kind never touches the default path');
    void b;
  });

  await test('--data <json file>: stored in a .jsonl entry; refused (exit 2, nothing written) for a Markdown path', async () => {
    const dir = proj({ qaRecords: { pendingRechecks: 'notes/rechecks.jsonl' } });
    const dataFile = path.join(dir, 'd.json');
    fs.writeFileSync(dataFile, JSON.stringify({ bug: 77, build: '1.2.3' }));
    const ok = await run(['append', '--kind', 'pendingRechecks', '--text', 't', '--data', dataFile], opts(dir));
    assert.strictEqual(ok.code, 0, JSON.stringify(ok.out));
    assert.deepStrictEqual(JSON.parse(read(path.join(dir, 'notes', 'rechecks.jsonl'))).data, { bug: 77, build: '1.2.3' });
    const l = await run(['list', '--kind', 'pendingRechecks'], opts(dir));
    assert.deepStrictEqual(l.out.entries[0].data, { bug: 77, build: '1.2.3' });
    const md = await run(['append', '--kind', 'pendingQuestions', '--text', 't', '--data', dataFile], opts(dir));
    assert.strictEqual(md.code, 2);
    assert.match(md.out.error.message, /\.jsonl/);
    assert.ok(!fs.existsSync(fileOf(dir, 'pendingQuestions')));
    fs.writeFileSync(dataFile, '{not json');
    const bad = await run(['append', '--kind', 'pendingRechecks', '--text', 't', '--data', dataFile], opts(dir));
    assert.strictEqual(bad.code, 2);
  });

  await test('non-ASCII round-trips byte-exact: --text, --text-file, the file, list, list --out', async () => {
    const dir = proj();
    const ar = 'هل يجب أن يكون التصدير بصيغة CSV؟';
    const lat = 'Résumé: naïve façade — Ünïcödé ✓';
    const tf = path.join(dir, 'in.txt');
    fs.writeFileSync(tf, `${lat}\n`, 'utf8');
    const a = await run(['append', '--kind', 'pendingQuestions', '--text', ar], opts(dir, { hex: ['0001'] }));
    const b = await run(['append', '--kind', 'pendingQuestions', '--text-file', tf], opts(dir, { hex: ['0002'] }));
    assert.strictEqual(a.code + b.code, 0);
    const bytes = fs.readFileSync(fileOf(dir, 'pendingQuestions'));
    assert.ok(bytes.includes(Buffer.from(`  ${ar}\n`, 'utf8')) && bytes.includes(Buffer.from(`  ${lat}\n`, 'utf8')));
    const l = await run(['list', '--kind', 'pendingQuestions'], opts(dir));
    assert.deepStrictEqual(l.out.entries.map((e) => e.text), [ar, lat], 'the trailing newline of a text file is dropped');
    const out = await run(['list', '--kind', 'pendingQuestions', '--out', 'tmp/q.json'], opts(dir));
    assert.strictEqual(out.code, 0);
    assert.strictEqual(out.out.out, path.join(dir, 'tmp', 'q.json'));
    assert.strictEqual(out.out.count, 2);
    assert.ok(!('entries' in out.out), 'stdout carries the path and counts, never the bodies');
    const fileBytes = fs.readFileSync(path.join(dir, 'tmp', 'q.json'));
    assert.strictEqual(out.out.bytes, fileBytes.length);
    assert.ok(fileBytes.includes(Buffer.from(ar, 'utf8')), 'the --out file holds the exact UTF-8 bytes');
    assert.deepStrictEqual(JSON.parse(fileBytes.toString('utf8')).entries.map((e) => e.text), [ar, lat]);
    const r = await run(['resolve', '--kind', 'pendingQuestions', '--id', a.out.id, '--resolution', 'نعم، CSV'], opts(dir));
    assert.strictEqual(r.code, 0);
    assert.strictEqual((await run(['list', '--status', 'resolved'], opts(dir))).out.entries[0].resolution, 'نعم، CSV');
  });

  await test('paths come from the getter: defaults are STRUCTURED_DEFAULTS.qaRecords; an override moves exactly that kind', async () => {
    const dir = proj({ qaRecords: { pendingQuestions: 'team/questions.md' } });
    const a = await run(['append', '--kind', 'pendingQuestions', '--text', 'q'], opts(dir));
    const b = await run(['append', '--kind', 'pendingRechecks', '--text', 'r'], opts(dir));
    assert.strictEqual(a.out.file, 'team/questions.md');
    assert.strictEqual(b.out.file, D.qaRecords.pendingRechecks);
    assert.ok(fs.existsSync(path.join(dir, 'team', 'questions.md')));
    assert.ok(fs.existsSync(fileOf(dir, 'pendingRechecks')));
    assert.ok(!fs.existsSync(fileOf(dir, 'pendingQuestions')));
  });

  await test('ConfigError on a bad qaRecords path: exit 2 naming the key; nothing is written', async () => {
    for (const bad of ['../outside/env.md', '/abs/env.md', 'records/env.txt']) {
      const dir = proj({ qaRecords: { envIssues: bad } });
      const r = await run(['append', '--kind', 'envIssues', '--text', 't'], opts(dir));
      assert.strictEqual(r.code, 2, bad);
      assert.match(r.out.error.message, /qaRecords\.envIssues/);
      assert.strictEqual(r.out.reason, 'config');
      assert.deepStrictEqual(tree(dir), ['config', 'config/project.json']);
      assert.strictEqual((await run(['list'], opts(dir))).code, 2, 'list refuses too');
    }
  });

  await test('lock busy: a live lock past the bounded wait -> exit 1 lock-busy naming the lock file; nothing written', async () => {
    const dir = proj();
    const f = fileOf(dir, 'envIssues');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.lock`, JSON.stringify({ pid: 999999, at: NOW.toISOString() }));
    const t0 = Date.now();
    const r = await run(['append', '--kind', 'envIssues', '--text', 't'], opts(dir));
    assert.strictEqual(r.code, 1, JSON.stringify(r.out));
    assert.strictEqual(r.out.reason, 'lock-busy');
    assert.ok(r.out.error.message.includes(`${D.qaRecords.envIssues}.lock`), r.out.error.message);
    assert.ok(Date.now() - t0 >= 50, 'it waited before giving up');
    assert.ok(!fs.existsSync(f), 'no entry was written');
    assert.ok(fs.existsSync(`${f}.lock`), 'a live lock is never broken');
  });

  await test('lock released between attempts: a lock removed during the wait lets the append through', async () => {
    const dir = proj();
    const f = fileOf(dir, 'envIssues');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.lock`, JSON.stringify({ pid: 999999, at: NOW.toISOString() }));
    setTimeout(() => fs.unlinkSync(`${f}.lock`), 20);
    const r = await run(['append', '--kind', 'envIssues', '--text', 't'], opts(dir, { lockWaitMs: 2000 }));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(!('brokeStaleLock' in r.out));
  });

  await test('stale lock (older than 60 s): broken loudly — brokeStaleLock:true — and the write proceeds', async () => {
    const dir = proj();
    const f = fileOf(dir, 'envIssues');
    const r0 = await run(['append', '--kind', 'envIssues', '--text', 'first'], opts(dir, { hex: ['0001'] }));
    fs.writeFileSync(`${f}.lock`, JSON.stringify({ pid: 999999, at: new Date(NOW.getTime() - 61_000).toISOString() }));
    const r = await run(['resolve', '--kind', 'envIssues', '--id', r0.out.id, '--resolution', 'ok'], opts(dir));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.brokeStaleLock, true);
    assert.ok(!fs.existsSync(`${f}.lock`), 'the lock is released afterwards');
    fs.writeFileSync(`${f}.lock`, JSON.stringify({ pid: 999999, at: new Date(NOW.getTime() - 59_000).toISOString() }));
    const busy = await run(['append', '--kind', 'envIssues', '--text', 't'], opts(dir));
    assert.strictEqual(busy.out.reason, 'lock-busy', 'a 59 s old lock is still live');
  });

  await test('unknown id -> exit 2 unknown-id; already resolved -> exit 2 already-resolved with no rewrite', async () => {
    const dir = proj();
    const a = await run(['append', '--kind', 'pendingRechecks', '--text', 't'], opts(dir));
    const u = await run(['resolve', '--kind', 'pendingRechecks', '--id', 'retest-20000101000000-dead', '--resolution', 'x'], opts(dir));
    assert.strictEqual(u.code, 2);
    assert.strictEqual(u.out.reason, 'unknown-id');
    assert.strictEqual((await run(['resolve', '--kind', 'pendingRechecks', '--id', a.out.id, '--resolution', 'done'], opts(dir))).code, 0);
    const before = fs.readFileSync(fileOf(dir, 'pendingRechecks'));
    const mtime = fs.statSync(fileOf(dir, 'pendingRechecks')).mtimeMs;
    const again = await run(['resolve', '--kind', 'pendingRechecks', '--id', a.out.id, '--resolution', 'again'], opts(dir));
    assert.strictEqual(again.code, 2);
    assert.strictEqual(again.out.reason, 'already-resolved');
    assert.ok(fs.readFileSync(fileOf(dir, 'pendingRechecks')).equals(before));
    assert.strictEqual(fs.statSync(fileOf(dir, 'pendingRechecks')).mtimeMs, mtime, 'no rewrite at all');
    const wrongKind = await run(['resolve', '--kind', 'envIssues', '--id', a.out.id, '--resolution', 'x'], opts(dir));
    assert.strictEqual(wrongKind.out.reason, 'unknown-id', 'an id is looked up in its own kind\'s file only');
  });

  await test('bad usage exits 2 and writes nothing: unknown subcommand, unknown kind, missing text, empty text, bad ref', async () => {
    const dir = proj();
    const cases = [
      [],
      ['nope'],
      ['append', '--text', 't'],
      ['append', '--kind', 'questions', '--text', 't'],
      ['append', '--kind', 'envIssues'],
      ['append', '--kind', 'envIssues', '--text', '   '],
      ['append', '--kind', 'envIssues', '--text', 't', '--ref', 'two words'],
      ['append', '--kind', 'envIssues', '--text', 't', '--text-file', 'x'],
      ['append', '--kind', 'envIssues', '--text-file', 'missing.txt'],
      ['resolve', '--kind', 'envIssues', '--id', 'x'],
      ['resolve', '--kind', 'envIssues', '--resolution', 'x'],
    ];
    for (const argv of cases) {
      const r = await run(argv, opts(dir));
      assert.strictEqual(r.code, 2, `${argv.join(' ')} -> ${JSON.stringify(r.out)}`);
      assert.strictEqual(r.out.ok, false);
    }
    const unk = await run(['append', '--kind', 'questions', '--text', 't'], opts(dir));
    for (const k of ALL_KINDS) assert.ok(unk.out.error.message.includes(k), 'names the accepted kinds');
    assert.deepStrictEqual(tree(dir), []);
  });

  await test('structural: no process.exit, no child_process in the delivered script', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'qa-records.js'), 'utf8');
    assert.ok(!src.includes('process.exit('), 'qa-records.js must not force-exit');
    assert.ok(!/child_process|spawnSync|execSync/.test(src));
  });

  await test('CLI: one JSON line; exit 2 on bad usage; exit 0 on an append (spawned)', async () => {
    const dir = proj();
    const bad = spawnSync(process.execPath, [path.join(__dirname, 'qa-records.js')], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(bad.status, 2, bad.stderr);
    assert.strictEqual(bad.stdout.trim().split(/\r?\n/).length, 1);
    assert.strictEqual(JSON.parse(bad.stdout).ok, false);
    const ok = spawnSync(process.execPath, [path.join(__dirname, 'qa-records.js'), 'append', '--kind', 'envIssues', '--text', 'مرحبا'], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    const line = JSON.parse(ok.stdout);
    assert.strictEqual(line.ok, true);
    assert.strictEqual(line.created, true);
    assert.ok(read(fileOf(dir, 'envIssues')).includes('  مرحبا\n'));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
