'use strict';
// Unit tests for the project layout contract (scripts/lib/layout.js): the CLAUDE.md block
// (render, parse, insert, refresh, byte identity outside the markers, user edits), the
// knowledge/INDEX.md line helper and the plugin-defined path set.
// Run: node scripts/lib/layout.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('./layout.js');
const scaffold = require('./scaffold.js');
const { STRUCTURED_DEFAULTS } = require('./project_config.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-layout-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(content) ? content : typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const claude = (dir) => fs.readFileSync(path.join(dir, 'CLAUDE.md'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const LF = '\n';
const CRLF = '\r\n';
// A pristine block rendered from an older route table — the "stale" shape a release that
// added a row meets in an existing project.
const OLD_ROUTES = layout.ROUTES.slice(0, -1);
const staleBlock = (eol = LF) => layout.renderBlock({ eol, routes: OLD_ROUTES });
const currentBlock = (eol = LF) => layout.renderBlock({ eol });
const EXTRA_ROUTE = { id: 'test-extra', write: 'A test-only extra row', to: '`extra/`', owns: ['extra/'] };

// ── render ──────────────────────────────────────────────────────────────────
test('ROUTES: the ids in order, memory last (owner amendment 2026-10-22)', () => {
  assert.deepStrictEqual(layout.ROUTES.map((r) => r.id),
    ['knowledge', 'watchlist', 'specs', 'config', 'runs', 'scratch', 'rules', 'memory']);
  for (const r of layout.ROUTES) {
    assert.ok(typeof r.write === 'string' && r.write && typeof r.to === 'string' && r.to, r.id);
    assert.ok(Array.isArray(r.owns), `${r.id}: owns is an array`);
  }
  assert.deepStrictEqual(layout.ROUTES.find((r) => r.id === 'memory').owns, [], 'memory owns nothing on disk');
});

test('render: the memory row routes lasting facts to the project, never personal memory', () => {
  const body = layout.renderBody();
  assert.ok(body.includes('| Anything about this project or its application you want to remember next session | The matching row above (usually `knowledge/`), never your personal memory: no teammate ever sees it. Personal memory is only for the user\'s own preferences |'));
});

test('render: static, the routing table from ROUTES in order, the INDEX-first rule, three numbered rules', () => {
  const body = layout.renderBody();
  assert.strictEqual(layout.renderBody(), body, 'same bytes every call');
  assert.match(body, /^## AgenTeX: where things go in this project\n/);
  assert.match(body, /\*\*Read `knowledge\/INDEX\.md` first\*\*/);
  const rows = body.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| If you') && !l.startsWith('|---'));
  assert.deepStrictEqual(rows, layout.ROUTES.map((r) => `| ${r.write} | ${r.to} |`));
  for (let n = 1; n <= 3; n++) assert.match(body, new RegExp(`^${n}\\. `, 'm'), `rule ${n}`);
  assert.strictEqual(layout.RULES.length, 3);
  assert.ok(body.endsWith('\n'));
});

test('render: never "test-run artifacts", never ${CLAUDE_PLUGIN_ROOT}, never a qaRecords default path', () => {
  const block = currentBlock();
  assert.ok(!block.includes('test-run artifacts'), 'the bullet check phrase');
  assert.ok(!block.includes('${CLAUDE_PLUGIN_ROOT}') && !block.includes('CLAUDE_PLUGIN_ROOT'));
  for (const p of Object.values(STRUCTURED_DEFAULTS.qaRecords)) assert.ok(!block.includes(p), p);
  assert.ok(!block.includes('qa-watchlist'), 'not even the default folder');
});

test('render: the whole block stays within the 3 KB budget', () => {
  const bytes = Buffer.byteLength(currentBlock(CRLF));
  assert.ok(bytes <= 3072, `${bytes} bytes`);
});

test('render: marker lines and hash = sha256/12 of the LF body', () => {
  const block = currentBlock();
  const lines = block.split('\n');
  assert.strictEqual(lines[0], `<!-- agentex:begin project-layout v1 hash=${sha(layout.renderBody()).slice(0, 12)} -->`);
  assert.strictEqual(lines[lines.length - 1], '<!-- agentex:end project-layout -->');
  assert.ok(!currentBlock(CRLF).replace(/\r\n/g, '').includes('\n'), 'a CRLF block has CRLF everywhere');
});

// ── parse ───────────────────────────────────────────────────────────────────
const parse = (s) => layout.parseBlock(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).state;

test('parse: absent / current / stale / edited / malformed', () => {
  assert.strictEqual(parse('# Mine\n'), 'absent');
  assert.strictEqual(parse(''), 'absent');
  assert.strictEqual(parse(`# Mine\n\n${currentBlock()}\n`), 'current');
  assert.strictEqual(parse(`# Mine\n\n${staleBlock()}\n`), 'stale');
  const edited = currentBlock().replace('Keep your own rules', 'Keep MY own rules');
  assert.strictEqual(parse(`${edited}\n`), 'edited');
  const emptied = `${currentBlock().split('\n')[0]}\n<!-- agentex:end project-layout -->\n`;
  assert.strictEqual(parse(emptied), 'edited', 'emptied between intact markers is an edit (RD-4)');
  const noHash = currentBlock().replace(/ hash=[0-9a-f]{12}/, '').replace('Keep your own', 'Keep our own');
  assert.strictEqual(parse(noHash), 'edited', 'missing hash + changed body');
  assert.strictEqual(parse(`${currentBlock()}\n${currentBlock()}\n`), 'malformed', 'two blocks');
  assert.strictEqual(parse('<!-- agentex:end project-layout -->\n'), 'malformed', 'end without begin');
  assert.strictEqual(parse(`${currentBlock().split('\n')[0]}\nx\n`), 'malformed', 'begin without end');
  assert.strictEqual(parse(`<!-- agentex:end project-layout -->\n${currentBlock().split('\n')[0]}\n`), 'malformed', 'end before begin');
});

test('parse: a CRLF-converted pristine block is still current (hash over LF-normalized text)', () => {
  assert.strictEqual(parse(`# Mine\r\n\r\n${currentBlock(CRLF)}\r\n`), 'current');
  assert.strictEqual(parse(`# Mine\r\n\r\n${staleBlock(CRLF)}\r\n`), 'stale');
  assert.strictEqual(parse(`# Mine\r\n\r\n${currentBlock()}\n`.replace(/\n/g, '\r\n')), 'current', 'converted after the fact');
});

test('parse: markers only count at a line start (an indented or quoted marker is user text)', () => {
  assert.strictEqual(parse('see `<!-- agentex:begin project-layout v1 -->` in the docs\n'), 'absent');
});

// ── insert (R1.4 EOL rules) ─────────────────────────────────────────────────
test('insert: missing file / empty file get the block alone', () => {
  const a = proj();
  const r = layout.ensureLayoutBlock(a);
  assert.strictEqual(r.state, 'created');
  assert.strictEqual(claude(a).toString(), `${currentBlock()}\n`);
  const b = proj({ 'CLAUDE.md': '' });
  layout.ensureLayoutBlock(b);
  assert.strictEqual(claude(b).toString(), `${currentBlock()}\n`);
});

test('insert: no trailing EOL → two EOLs; one EOL → one more; a blank-line ending → nothing', () => {
  for (const [before, sep] of [['# Mine', '\n\n'], ['# Mine\n', '\n'], ['# Mine\n\n', ''], ['# Mine\n   \n\n', '']]) {
    const dir = proj({ 'CLAUDE.md': before });
    layout.ensureLayoutBlock(dir);
    assert.strictEqual(claude(dir).toString(), `${before}${sep}${currentBlock()}\n`, JSON.stringify(before));
  }
});

test('insert: a CRLF file gets a CRLF block and CRLF separators', () => {
  const dir = proj({ 'CLAUDE.md': '# Mine\r\nrule one\r\n' });
  layout.ensureLayoutBlock(dir);
  assert.strictEqual(claude(dir).toString(), `# Mine\r\nrule one\r\n\r\n${currentBlock(CRLF)}\r\n`);
  assert.strictEqual(parse(claude(dir)), 'current');
});

test('insert: bytes before the block are identical (BOM, Arabic, accents, invalid UTF-8)', () => {
  const user = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# مشروعي — café\n- قاعدة: لا تحذف\n'), Buffer.from([0xff, 0x0a])]);
  const dir = proj({ 'CLAUDE.md': user });
  layout.ensureLayoutBlock(dir);
  const out = claude(dir);
  assert.ok(out.subarray(0, user.length).equals(user), 'every user byte kept');
  assert.strictEqual(parse(out), 'current');
});

// ── refresh in place ────────────────────────────────────────────────────────
function refreshFixture(eol) {
  const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`# مشروعي — Ünïcødé${eol}- user bullet before   ${eol}`), Buffer.from([0xfe]), Buffer.from(`${eol}${eol}`)]);
  const after = Buffer.concat([Buffer.from(`${eol}${eol}- user bullet after — آخر${eol}`), Buffer.from([0xc3, 0x28]), Buffer.from(`  trailing  ${eol}`)]);
  return { before, after, file: Buffer.concat([before, Buffer.from(staleBlock(eol)), after]) };
}

for (const [label, eol] of [['LF', LF], ['CRLF', CRLF]]) {
  test(`refresh (${label}): a stale pristine block is replaced in place; every byte outside the range identical`, () => {
    const { before, after, file } = refreshFixture(eol);
    const dir = proj({ 'CLAUDE.md': file });
    const r = layout.ensureLayoutBlock(dir);
    assert.strictEqual(r.state, 'refreshed');
    const out = claude(dir);
    assert.ok(out.subarray(0, before.length).equals(before), 'bytes before the block');
    assert.ok(out.subarray(out.length - after.length).equals(after), 'bytes after the block (the end line\'s EOL included)');
    assert.strictEqual(out.subarray(before.length, out.length - after.length).toString(), currentBlock(eol));
    assert.strictEqual(parse(out), 'current');
    assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md.tmp')), 'the tmp file never outlives the call');
  });
}

test('refresh: a block the user moved to the top is refreshed where it sits', () => {
  const dir = proj({ 'CLAUDE.md': `${staleBlock()}\n\n# Mine\n- a rule\n` });
  layout.ensureLayoutBlock(dir);
  assert.strictEqual(claude(dir).toString(), `${currentBlock()}\n\n# Mine\n- a rule\n`);
});

// ── idempotence ─────────────────────────────────────────────────────────────
test('idempotence: a second ensure writes nothing (bytes and mtime unchanged)', () => {
  const dir = proj({ 'CLAUDE.md': '# Mine\n' });
  layout.ensureLayoutBlock(dir);
  const file = path.join(dir, 'CLAUDE.md');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(file, past, past);
  const bytes = claude(dir);
  const mtime = fs.statSync(file).mtimeMs;
  const r = layout.ensureLayoutBlock(dir);
  assert.strictEqual(r.state, 'current');
  assert.strictEqual(r.kind, 'skipped');
  assert.ok(claude(dir).equals(bytes));
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
});

test('dryRun: reports created/refreshed without writing', () => {
  const dir = proj({ 'CLAUDE.md': `# Mine\n\n${staleBlock()}\n` });
  const bytes = claude(dir);
  assert.strictEqual(layout.ensureLayoutBlock(dir, { dryRun: true }).state, 'refreshed');
  assert.ok(claude(dir).equals(bytes));
  const empty = proj();
  assert.strictEqual(layout.ensureLayoutBlock(empty, { dryRun: true }).state, 'created');
  assert.ok(!fs.existsSync(path.join(empty, 'CLAUDE.md')));
});

// ── user edits and broken markers ───────────────────────────────────────────
test('edited block: zero writes and the [flag] text naming the file and the fix', () => {
  const edited = currentBlock().replace('Keep your own rules', 'Keep MY own rules');
  const dir = proj({ 'CLAUDE.md': `# Mine\n\n${edited}\n` });
  const bytes = claude(dir);
  const r = layout.ensureLayoutBlock(dir);
  assert.strictEqual(r.state, 'edited');
  assert.strictEqual(r.kind, 'flag');
  assert.ok(claude(dir).equals(bytes));
  assert.strictEqual(r.message, 'CLAUDE.md: the AgenTeX block was edited by hand, so it was not refreshed — move your own lines outside the block, delete the block (both marker lines too), then re-run /update-agentex to get the current one (docs/project-layout.md#the-agentex-block-in-claudemd)');
});

test('malformed markers: zero writes and the [flag] text', () => {
  const dir = proj({ 'CLAUDE.md': `${currentBlock()}\n${currentBlock()}\n` });
  const bytes = claude(dir);
  const r = layout.ensureLayoutBlock(dir);
  assert.strictEqual(r.state, 'malformed');
  assert.ok(claude(dir).equals(bytes));
  assert.match(r.message, /duplicate or broken AgenTeX block markers in CLAUDE\.md — keep one begin\/end pair, then re-run/);
});

// ── a CLAUDE.md that is a symlink (invariant #11: the link is the user's) ────
// Where the OS cannot create symlinks (Windows without the privilege), these cases skip.
const CAN_SYMLINK = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-layout-link-'));
  try { fs.symlinkSync('target', path.join(d, 'link')); return true; } catch { return false; }
})();
const POSIX_MODES = process.platform !== 'win32';
function linkTest(name, fn) {
  if (CAN_SYMLINK) test(name, fn);
  else console.log(`  skip - ${name} (this OS cannot create symlinks here)`);
}
const modeOf = (f) => fs.statSync(f).mode & 0o777;
// CRLF + non-ASCII user content, and a link CLAUDE.md → <target>.
function linkedProject(target, content, mode = 0o640) {
  const dir = proj({ [target]: content });
  fs.chmodSync(path.join(dir, target), mode);
  fs.symlinkSync(target, path.join(dir, 'CLAUDE.md'));
  return dir;
}
function assertStillLink(dir, target) {
  const l = path.join(dir, 'CLAUDE.md');
  assert.ok(fs.lstatSync(l).isSymbolicLink(), 'CLAUDE.md is still a symlink');
  assert.strictEqual(fs.readlinkSync(l), target, 'the link still points where the user pointed it');
}
const noTmp = (dir) => {
  const left = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else if (e.name.endsWith('.tmp')) left.push(path.relative(dir, full));
    }
  })(dir);
  assert.deepStrictEqual(left, [], 'no tmp file outlives the call');
};

linkTest('symlink (absent): the block is appended to the link target; the link stays a link; bytes before it and the mode kept', () => {
  const user = Buffer.from('# وكلاء — Ünïcødé\r\n- user rule: café\r\n', 'utf8');
  const dir = linkedProject('AGENTS.md', user);
  const r = layout.ensureLayoutBlock(dir);
  assert.strictEqual(r.state, 'created');
  assertStillLink(dir, 'AGENTS.md');
  const out = fs.readFileSync(path.join(dir, 'AGENTS.md'));
  assert.ok(out.subarray(0, user.length).equals(user), 'every user byte kept');
  assert.strictEqual(out.subarray(user.length).toString(), `\r\n${currentBlock(CRLF)}\r\n`);
  assert.strictEqual(parse(out), 'current');
  if (POSIX_MODES) assert.strictEqual(modeOf(path.join(dir, 'AGENTS.md')), 0o640, 'the target keeps its mode');
  noTmp(dir);
  assert.strictEqual(layout.ensureLayoutBlock(dir).state, 'current', 'read through the link on the next run');
});

linkTest('symlink (stale): the block is refreshed inside the target (a sub-folder); bytes outside the markers and the mode kept', () => {
  const { before, after, file } = refreshFixture(CRLF);
  const dir = linkedProject('shared/AGENTS.md', file, 0o600);
  const r = layout.ensureLayoutBlock(dir);
  assert.strictEqual(r.state, 'refreshed');
  assertStillLink(dir, 'shared/AGENTS.md');
  const out = fs.readFileSync(path.join(dir, 'shared', 'AGENTS.md'));
  assert.ok(out.subarray(0, before.length).equals(before), 'bytes before the block');
  assert.ok(out.subarray(out.length - after.length).equals(after), 'bytes after the block');
  assert.strictEqual(out.subarray(before.length, out.length - after.length).toString(), currentBlock(CRLF));
  if (POSIX_MODES) assert.strictEqual(modeOf(path.join(dir, 'shared', 'AGENTS.md')), 0o600, 'the target keeps its mode');
  noTmp(dir);
});

linkTest('symlink (dangling): a [flag] naming the missing target, zero writes — the link is never replaced and no target is created', () => {
  const dir = proj();
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  for (const dryRun of [true, false]) {
    const r = layout.ensureLayoutBlock(dir, { dryRun });
    assert.strictEqual(r.kind, 'flag');
    assert.strictEqual(r.state, 'dangling');
    assert.strictEqual(r.message, 'CLAUDE.md is a symlink to AGENTS.md, which does not exist, so the AgenTeX block was not written — create the target file (or replace the link with a file), then re-run /update-agentex (docs/project-layout.md#the-agentex-block-in-claudemd)');
    assertStillLink(dir, 'AGENTS.md');
    assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'no target was created');
  }
  noTmp(dir);
});

test('a regular CLAUDE.md keeps its file mode across append and refresh', () => {
  if (!POSIX_MODES) return;
  const dir = proj({ 'CLAUDE.md': `# Mine\n\n${staleBlock()}\n` });
  const file = path.join(dir, 'CLAUDE.md');
  fs.chmodSync(file, 0o640);
  assert.strictEqual(layout.ensureLayoutBlock(dir).state, 'refreshed');
  assert.strictEqual(modeOf(file), 0o640, 'refresh');
  const b = proj({ 'CLAUDE.md': '# Mine\n' });
  fs.chmodSync(path.join(b, 'CLAUDE.md'), 0o600);
  assert.strictEqual(layout.ensureLayoutBlock(b).state, 'created');
  assert.strictEqual(modeOf(path.join(b, 'CLAUDE.md')), 0o600, 'append');
});

// ── extension point (R1.6) ──────────────────────────────────────────────────
test('an extra route reaches a pristine block and leaves an edited block alone', () => {
  const routes = [...layout.ROUTES, EXTRA_ROUTE];
  const pristine = proj({ 'CLAUDE.md': `# Mine\n\n${currentBlock()}\n- after\n` });
  assert.strictEqual(layout.ensureLayoutBlock(pristine, { routes }).state, 'refreshed');
  const out = claude(pristine).toString();
  assert.ok(out.includes('| A test-only extra row | `extra/` |'));
  assert.ok(out.startsWith('# Mine\n\n') && out.endsWith('\n- after\n'));
  const edited = currentBlock().replace('Keep your own rules', 'Keep MY own rules');
  const mine = proj({ 'CLAUDE.md': `${edited}\n` });
  const bytes = claude(mine);
  assert.strictEqual(layout.ensureLayoutBlock(mine, { routes }).state, 'edited');
  assert.ok(claude(mine).equals(bytes));
});

// ── the bullet check judges the user's text only (R1.5) ──────────────────────
test('stripManagedBlock removes a balanced block only', () => {
  const s = `a\n${currentBlock()}\nb\n`;
  assert.strictEqual(layout.stripManagedBlock(s), 'a\n\nb\n');
  assert.strictEqual(layout.stripManagedBlock('no block\n'), 'no block\n');
  const broken = `${currentBlock()}\n${currentBlock()}\n`;
  assert.strictEqual(layout.stripManagedBlock(broken), broken, 'malformed: unchanged');
});

test('claudeMdHasBullet reports the same result before and after the block is added (four fixtures)', () => {
  const fixtures = {
    'bullet present': `# Mine\n\n${scaffold.CLAUDE_MD_BULLET}`,
    'bullet absent': '# Mine\n- my rule\n',
    'phrase without executions/': '# Mine\n- test-run artifacts are noisy\n',
    'executions/ without phrase': '# Mine\n- keep executions/ small\n',
  };
  for (const [label, content] of Object.entries(fixtures)) {
    const dir = proj({ 'CLAUDE.md': content });
    const before = scaffold.claudeMdHasBullet(dir);
    layout.ensureLayoutBlock(dir);
    assert.strictEqual(scaffold.claudeMdHasBullet(dir), before, label);
  }
  // The block names executions/; with "test-run artifacts" in the user's text it must still
  // not count as the bullet.
  const dir = proj({ 'CLAUDE.md': '# Mine\n- test-run artifacts are noisy\n' });
  layout.ensureLayoutBlock(dir);
  assert.ok(claude(dir).toString().includes('`executions/`'));
  assert.strictEqual(scaffold.claudeMdHasBullet(dir), false);
});

// ── knowledge/INDEX.md (R2.4) ───────────────────────────────────────────────
test('appendIndexLine: creates INDEX.md with its header, appends, no-op when linked, never rewrites', () => {
  const dir = proj();
  const index = path.join(dir, 'knowledge', 'INDEX.md');
  const r1 = layout.appendIndexLine(dir, 'notes.md', 'Settled facts moved from the root');
  assert.strictEqual(r1.kind, 'created');
  assert.strictEqual(fs.readFileSync(index, 'utf8'),
    '# Knowledge index\n\nSettled facts about the application under test. Read this first; open only the files that matter for the task.\n\n' +
    '- [notes.md](notes.md) — Settled facts moved from the root\n');
  const before = fs.readFileSync(index);
  assert.strictEqual(layout.appendIndexLine(dir, 'notes.md', 'another description').kind, 'skipped');
  assert.ok(fs.readFileSync(index).equals(before), 'no-op when the file is already linked');
  layout.appendIndexLine(dir, 'gotchas.md', layout.KNOWLEDGE_FILES['gotchas.md']);
  const after = fs.readFileSync(index);
  assert.ok(after.subarray(0, before.length).equals(before), 'append-only');
  assert.strictEqual(after.subarray(before.length).toString(),
    '- [gotchas.md](gotchas.md) — Recurring tool and environment problems, with their workaround\n');
});

test('appendIndexLine: a user-written INDEX.md with no trailing EOL is appended to, never rewritten', () => {
  const user = '# Our index\r\n- [team.md](team.md) — ours';
  const dir = proj({ 'knowledge/INDEX.md': user });
  layout.appendIndexLine(dir, 'old-notes.md', 'Moved notes');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'knowledge', 'INDEX.md'), 'utf8'),
    `${user}\r\n- [old-notes.md](old-notes.md) — Moved notes\r\n`);
});

test('KNOWLEDGE_FILES: the three fixed files and their INDEX descriptions', () => {
  assert.deepStrictEqual(Object.keys(layout.KNOWLEDGE_FILES), ['app-map.md', 'business-rules.md', 'gotchas.md']);
});

// ── plugin-defined paths ────────────────────────────────────────────────────
test('definedPaths: ROUTES owns + the plugin files + the default qaRecords files', () => {
  const { paths, notes } = layout.definedPaths(proj());
  for (const p of ['knowledge/', 'test/', 'config/', 'executions/', '.agentex/scratch/', 'CLAUDE.md',
    '.agentex/version.json', '.agentex/test-template.md', '.agentex/cache/', '.gitignore',
    'agentex.config.json', 'integrations/', ...Object.values(STRUCTURED_DEFAULTS.qaRecords)]) {
    assert.ok(paths.includes(p), p);
  }
  assert.deepStrictEqual(notes, []);
});

test('definedPaths: custom qaRecords paths are honoured; the defaults are then not defined', () => {
  const dir = proj({ 'config/project.json': { qaRecords: { envIssues: 'notes/env.jsonl' } } });
  const { paths } = layout.definedPaths(dir);
  assert.ok(paths.includes('notes/env.jsonl'));
  assert.ok(!paths.includes(STRUCTURED_DEFAULTS.qaRecords.envIssues));
  assert.ok(paths.includes(STRUCTURED_DEFAULTS.qaRecords.pendingQuestions), 'keys left out keep their defaults');
});

test('definedPaths: an invalid qaRecords block falls back to the defaults with one note', () => {
  const dir = proj({ 'config/project.json': { qaRecords: { envIssues: '/abs/env.md' } } });
  const { paths, notes } = layout.definedPaths(dir);
  for (const p of Object.values(STRUCTURED_DEFAULTS.qaRecords)) assert.ok(paths.includes(p), p);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /qaRecords/);
});

test('definedPaths: an extra route\'s owns becomes plugin-defined', () => {
  const { paths } = layout.definedPaths(proj(), { routes: [...layout.ROUTES, EXTRA_ROUTE] });
  assert.ok(paths.includes('extra/'));
});

// ── docs/project-layout.md mirrors the data (R7) ─────────────────────────────
test('docs/project-layout.md: the "Where things go" table equals ROUTES, in order', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'project-layout.md'), 'utf8');
  const sec = (md.split(/^## Where things go\s*$/m)[1] || '').split(/^## /m)[0];
  assert.ok(sec, 'section "## Where things go" is missing');
  const rows = sec.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| If you'));
  assert.deepStrictEqual(rows, layout.ROUTES.map((r) => `| ${r.write} | ${r.to} |`));
  assert.match(md, /^## The AgenTeX block in `CLAUDE\.md`$/m, 'the anchor the [flag] text links to');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
