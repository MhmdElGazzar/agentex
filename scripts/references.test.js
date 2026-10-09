'use strict';
// Structural checks on the plugin-root references (references/**/*.md).
// Run: node scripts/references.test.js
//
// 1. Dormant references (design axis S15). A plugin-root reference that no
//    skill, command or agent links is allowed ONLY while DORMANT below names
//    the phase that wires it. An allowlisted file that IS linked fails too
//    (a stale entry). The list must be EMPTY before 1.0.0 is cut.
// 2. Content pins for the shared references this phase ships:
//    task-lifecycle.md (six sections, workflow states only as config keys),
//    question-format.md (rules 1–6, the title rule a LINK to test-design —
//    never a copy), and the WIQL / JQL gotchas sections.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const REFS = path.join(ROOT, 'references');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// reference path (relative to references/) -> the phase that links it.
const DORMANT = {
  'question-format.md': 'Phase 1 (test-design / bug-report-azure overrides) and Phase 2 (requirement analysis)',
  'tracker/task-lifecycle.md': 'Phase 1 (test-execution lifecycle hooks)',
};

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// Every text a skill/command/agent carries (SKILL.md, its own references, commands, agents).
const LINKERS = [
  ...walk(path.join(ROOT, 'skills'), (p) => p.endsWith('.md')),
  ...(fs.existsSync(path.join(ROOT, 'commands')) ? walk(path.join(ROOT, 'commands'), (p) => p.endsWith('.md')) : []),
  ...(fs.existsSync(path.join(ROOT, 'agents')) ? walk(path.join(ROOT, 'agents'), (p) => p.endsWith('.md')) : []),
].map((p) => fs.readFileSync(p, 'utf8'));
// A reference is linked when a skill/command/agent names it, or when an
// already-linked reference points at it (reachable from a skill).
function linkedSet() {
  const all = walk(REFS, (p) => p.endsWith('.md')).map((p) => path.relative(REFS, p).split(path.sep).join('/'));
  const set = new Set(all.filter((r) => LINKERS.some((t) => t.includes(`references/${r}`))));
  const mentions = (from) => {
    const text = fs.readFileSync(path.join(REFS, from), 'utf8');
    const out = new Set();
    for (const m of text.matchAll(/references\/([\w./-]+\.md)/g)) out.add(m[1]);
    for (const m of text.matchAll(/(?:^|[\s(`'"])((?:\.\.?\/)*[\w-]+(?:\/[\w-]+)*\.md)/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[1]));
      if (!rel.startsWith('..')) out.add(rel);
    }
    return [...out].filter((r) => all.includes(r));
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of [...set]) for (const t of mentions(r)) if (!set.has(t)) { set.add(t); grew = true; }
  }
  return set;
}
const LINKED = linkedSet();
const linked = (rel) => LINKED.has(rel);

test('every plugin-root reference is linked by a skill/command/agent, or allowlisted as dormant with its phase', () => {
  const refs = walk(REFS, (p) => p.endsWith('.md')).map((p) => path.relative(REFS, p).split(path.sep).join('/'));
  const unlinked = refs.filter((r) => !linked(r) && !DORMANT[r]);
  assert.deepStrictEqual(unlinked, [], `unlinked references with no dormant entry: ${unlinked.join(', ')}`);
  for (const [r, phase] of Object.entries(DORMANT)) {
    assert.ok(refs.includes(r), `dormant entry for a missing file: ${r}`);
    assert.ok(!linked(r), `${r} is linked now — remove it from DORMANT`);
    assert.match(phase, /Phase [12]/, `${r}: the entry names the phase that wires it`);
  }
});

test('task-lifecycle.md: the six sections, in order', () => {
  const md = read('references/tracker/task-lifecycle.md');
  const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].toLowerCase());
  const want = [/config keys/, /stage start/, /stage end/, /retest close/, /close-out proposal/, /before reporting done/, /interactive only/];
  let at = -1;
  for (const re of want) {
    const i = heads.findIndex((h, k) => k > at && re.test(h));
    assert.ok(i > at, `missing or out-of-order section matching ${re} (have: ${heads.join(' | ')})`);
    at = i;
  }
});

test('task-lifecycle.md names workflow states only as config keys — never a state literal', () => {
  const md = read('references/tracker/task-lifecycle.md');
  for (const k of ['devDoneStates', 'devActiveStates', 'inTestState', 'qaStates', 'terminalStates', 'taskActiveState', 'taskClosedState', 'testCaseReadyState', 'closeOut.state', 'closeOut.assignee']) {
    assert.ok(md.includes(k), `config key ${k} is not named`);
  }
  const STATES = ['Active', 'Resolved', 'Closed', 'New', 'Done', 'In Progress', 'To Do', 'Testing', 'In Test', 'Ready', 'Removed', 'Committed', 'Approved', 'Design', 'QA'];
  for (const st of STATES) {
    for (const q of ['`', '"', '\'']) {
      assert.ok(!md.includes(`${q}${st}${q}`), `state literal ${q}${st}${q} in task-lifecycle.md — name the config key instead`);
    }
  }
});

test('question-format.md: rules 1–6; the title rule is a link to test-design\'s Title Convention; no title grammar copied', () => {
  const md = read('references/question-format.md');
  for (let n = 1; n <= 6; n++) assert.match(md, new RegExp(`^${n}\\. \\*\\*`, 'm'), `rule ${n}`);
  assert.ok(md.includes('](../skills/test-design/SKILL.md'), 'the link to test-design SKILL.md');
  assert.match(md, /Step 4/);
  assert.ok(!md.includes('||'), 'the "||" title grammar belongs to test-design only');
  assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'test-design', 'SKILL.md')));
  assert.match(read('skills/test-design/SKILL.md'), /^## Step 4 — Title Convention/m, 'the link target section exists');
});

test('ado-boards.md: a "WIQL gotchas" section with its four points', () => {
  const md = read('references/tracker/ado-boards.md');
  const sec = (md.split(/^## WIQL gotchas\s*$/m)[1] || '').split(/^## /m)[0];
  assert.ok(sec, 'section "## WIQL gotchas" is missing');
  assert.match(sec, /^1\. .*project clause/im);
  assert.match(sec, /^2\. .*capped/im);
  assert.match(sec, /^3\. .*\[System\.Parent\] IN/im);
  assert.match(sec, /^4\. .*pipe/im);
  assert.match(sec, /--out/);
  assert.match(sec, /truncated/);
});

test('jira-boards.md: a "JQL gotchas" section; Known limitations links capabilities.md', () => {
  const md = read('references/tracker/jira-boards.md');
  const sec = (md.split(/^## JQL gotchas\s*$/m)[1] || '').split(/^## /m)[0];
  assert.ok(sec, 'section "## JQL gotchas" is missing');
  for (const re of [/project = /, /10 pages/, /[Ss]ub-tasks/, /--out/, /batch/]) assert.match(sec, re);
  const lim = (md.split(/^## Known limitations.*$/m)[1] || '').split(/^## /m)[0];
  assert.match(lim, /capabilities\.md/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
