'use strict';
// Structural lint: scratch-only wording across every skill, reference, command and agent
// (project-layout-contract R5.3). Every temp, probe, dump or intermediate file the plugin
// tells the agent to write goes under the consumer project's .agentex/scratch/ — never the
// system temp directory, never a bare relative name at the project root, never
// .agentex/cache/ (the tracker cache, not scratch), never a file the agent picks inside the
// tool-owned .playwright-cli/ folder. A scratch file argument names its task subfolder
// (.agentex/scratch/<task>/…), bar GR's three flat files.
// Run: node scripts/scratch-wording.test.js
//
// Scope: every .md under skills/, references/, commands/ and agents/. docs/ and
// scripts/release-gate/ are maintainer- or reader-facing and may name the system temp dir.
//
// The matchers run over an in-test fixture table first, so the lint cannot pass by
// matching nothing.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const SCOPE = ['skills', 'references', 'commands', 'agents'];
const REFERENCE = 'references/project-layout.md';

// ── the rules ─────────────────────────────────────────────────────────────────
// Forbidden anywhere.
const FORBIDDEN = [
  { id: 'os-temp', re: /\bOS[- ]temp\b/i },
  { id: 'temp-env-var', re: /\$(TMP|TEMP|TMPDIR)\b|%(TEMP|TMP)%/ },
  { id: 'tmpdir-call', re: /os\.tmpdir|tmpdir\(\)|mkdtemp/ },
  { id: 'slash-tmp', re: /(^|[\s"'`(])\/tmp\// },
  { id: 'playwright-cli-file', re: /\.playwright-cli\/[\w.-]+\.\w+/ },
];
// Forbidden unless the same line names .agentex/scratch.
const TEMP_WORDING = /\btemp(orary)? (dir|directory|folder|file)\b/i;
// The file arguments whose value must be a scratch path, an evidence path or a placeholder.
// The link to the shared reference: through the plugin root, or a relative link.
const LINKS_REFERENCE = /references\/project-layout\.md|\]\((?:\.\.\/)+(?:references\/)?project-layout\.md\)/;
const FILE_ARG = /--(out|spec|text-file|body-file|ids-file|discussion-file|resolution-file|data|description-file)(?:[ \t]+|=)/g;

// The value right after a file flag: a quoted string, a <placeholder with spaces> plus any
// tail, or a run of non-space characters.
function readValue(s) {
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  if (s[0] === '<') {
    const end = s.indexOf('>');
    if (end !== -1) return s.slice(0, end + 1) + (s.slice(end + 1).match(/^[^\s`|)\]]*/) || [''])[0];
  }
  return (s.match(/^[^\s`|)\]]+/) || [''])[0];
}

const isScratch = (v) => v.startsWith('.agentex/scratch/');
// One subfolder per task (references/project-layout.md §Scratch): a scratch file argument
// names its task folder. GR's three flat files are kept so its text does not churn.
const FLAT_KEPT = ['cases.json', 'tasks.json', 'estimation-proposal.json'];
const isFlatScratch = (v) => {
  const rest = v.slice('.agentex/scratch/'.length);
  return rest !== '' && !rest.includes('/') && !FLAT_KEPT.includes(rest);
};
const isEvidence = (v) => /^(<SESSION_DIR>|\{\{SESSION_DIR\}\}|\$SESSION_DIR|\$\{SESSION_DIR\}|"\$SESSION_DIR"|executions\/)/.test(v);
// A pure placeholder: <file>, <spec>.json, <file.json>, <json file> — nothing else in it.
const isPlaceholder = (v) => /^<[^<>/]+>(\.\w+)?$/.test(v);
// An elided value ("--out ... --log ...") names no path at all.
const isElided = (v) => v === '...' || v === '…';
// A flag being described, not passed ("--out (first …)", "--out must …").
const isNotAValue = (v) => v === '' || /^[A-Za-z(—–-]/.test(v) && !/[./]/.test(v) && !/^[\w-]+\.\w+$/.test(v);

// The code parts of a Markdown text: inline code spans and fenced blocks, with their line
// numbers.
function codeParts(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) { fence = fence ? null : f[1]; return; }
    if (fence) { out.push({ line: i + 1, text: line }); return; }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ line: i + 1, text: m[1] });
  });
  return out;
}

// Every violation in one file's text: [{ line, rule, text }]. `self` = the reference itself
// (it states the rule, so it needs no link to itself).
function violations(md, { self = false } = {}) {
  const out = [];
  const lines = md.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { id, re } of FORBIDDEN) if (re.test(line)) out.push({ line: i + 1, rule: id, text: line.trim() });
    if (TEMP_WORDING.test(line) && !line.includes('.agentex/scratch')) {
      out.push({ line: i + 1, rule: 'temp-wording', text: line.trim() });
    }
  });
  const statesRule = md.includes('.agentex/scratch/');
  for (const part of codeParts(md)) {
    for (const m of part.text.matchAll(FILE_ARG)) {
      const v = readValue(part.text.slice(m.index + m[0].length));
      if (isScratch(v)) {
        if (isFlatScratch(v)) out.push({ line: part.line, rule: 'scratch-no-subfolder', text: `--${m[1]} ${v}` });
        continue;
      }
      if (isNotAValue(v) || isElided(v) || isEvidence(v)) continue;
      if (isPlaceholder(v)) {
        if (!statesRule) out.push({ line: part.line, rule: 'placeholder-without-rule', text: `--${m[1]} ${v}` });
        continue;
      }
      out.push({ line: part.line, rule: 'file-arg', text: `--${m[1]} ${v}` });
    }
  }
  if (!self && md.includes('.agentex/scratch/') && !LINKS_REFERENCE.test(md)) {
    out.push({ line: 0, rule: 'reference-not-linked', text: `names .agentex/scratch/ but does not link ${REFERENCE}` });
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ── self-test: every rule catches its form, the allowed forms pass ────────────
const SCRATCH_LINK = '\nSee ${CLAUDE_PLUGIN_ROOT}/references/project-layout.md (.agentex/scratch/).\n';
const CAUGHT = [
  ['os-temp', 'Spec files go to the OS temp dir.'],
  ['os-temp', 'write it to the os-temp folder'],
  ['temp-env-var', 'Never use $TMP for it.'],
  ['temp-env-var', 'write to %TEMP%\\x.json'],
  ['temp-env-var', 'export OUT=$TMPDIR/x'],
  ['tmpdir-call', 'use os.tmpdir() for the dump'],
  ['tmpdir-call', 'fs.mkdtemp the folder'],
  ['slash-tmp', 'write it to /tmp/cases.json'],
  ['playwright-cli-file', 'scratch (default `.playwright-cli/define-flow-draft.md`)'],
  ['temp-wording', 'Write the result to a temp file and pass its path.'],
  ['temp-wording', 'a temporary directory for the dumps'],
  ['file-arg', '`--text-file blocker.txt`'],
  ['file-arg', '```\nnode x.js screenshot --out s1-login.png\n```'],
  ['file-arg', '`list --out .agentex/cache/watchlist.json`'],
  ['file-arg', '`--spec "cases.json"`'],
  ['placeholder-without-rule', '`--out <file>` and Read the file'],
  ['reference-not-linked', 'Write it to `.agentex/scratch/cases.json`.'],
  ['scratch-no-subfolder', '`--out .agentex/scratch/<name>.json` and Read' + SCRATCH_LINK],
];
const ALLOWED = [
  // GR's test-design text, as it ships.
  'Scratch files go **only** in `.agentex/scratch/` under the project root. `--spec ".agentex/scratch/cases.json"`' + SCRATCH_LINK,
  '`create-cases.js create --spec ".agentex/scratch/cases.json"`' + SCRATCH_LINK,
  '`tracker.js comments --id 1204 --out .agentex/scratch/tracker/1204-comments.json`' + SCRATCH_LINK,
  '`--out <file>` — a file under `.agentex/scratch/tracker/`' + SCRATCH_LINK,
  '`--data <json file>`' + SCRATCH_LINK,
  '`--spec <spec>.json`' + SCRATCH_LINK,
  '`--out {{SESSION_DIR}}/screenshots/<scenario>-ui-check-baseline.png`',
  '`--out <SESSION_DIR>/screenshots/s1-login.png`',
  '`--log ./executions/ask-kb/last.log`',
  '`--path <baseline image> --out ... --log ...`',
  'the snapshot lands in `.playwright-cli/` (tool-owned)',
  'a temp file under `.agentex/scratch/swagger/`' + SCRATCH_LINK,
  'the `.agentex/cache/tracker-fields-ado.json` field cache',
];

test('self-test: each forbidden form is caught by its rule', () => {
  for (const [rule, text] of CAUGHT) {
    const hits = violations(text).map((v) => v.rule);
    assert.ok(hits.includes(rule), `${rule} missed: ${JSON.stringify(text)} (got ${hits.join(', ') || 'none'})`);
  }
});

test('self-test: the allowed forms pass (including GR\'s test-design scratch text)', () => {
  for (const text of ALLOWED) {
    const v = violations(text);
    assert.deepStrictEqual(v, [], `allowed form flagged: ${JSON.stringify(text)} → ${JSON.stringify(v)}`);
  }
});

// ── the real scan ─────────────────────────────────────────────────────────────
const FILES = SCOPE.flatMap((d) => walk(path.join(ROOT, d)));

test('the scan sees the plugin\'s prompts (skills, references, commands, agents)', () => {
  assert.ok(FILES.length > 30, `only ${FILES.length} files found`);
  for (const d of SCOPE) assert.ok(FILES.some((f) => f.startsWith(path.join(ROOT, d) + path.sep)), `${d}/ scanned`);
});

test('scratch-only: no skill, reference, command or agent names a temp location other than .agentex/scratch/', () => {
  const all = [];
  for (const f of FILES) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    for (const v of violations(fs.readFileSync(f, 'utf8'), { self: rel === REFERENCE })) all.push(`${rel}:${v.line} [${v.rule}] ${v.text}`);
  }
  assert.deepStrictEqual(all, [], `\n  ${all.join('\n  ')}`);
});

test(`the shared reference ${REFERENCE} exists and states the scratch rule`, () => {
  const md = fs.readFileSync(path.join(ROOT, REFERENCE), 'utf8');
  assert.match(md, /\.agentex\/scratch\//);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
