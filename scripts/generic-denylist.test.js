'use strict';
// The plugin stays generic (invariant 7; skill-consolidation-foundation AC C /
// WP-15 / gate note G-2): no organization, project, team, person, host, id or
// custom workflow state from a consumer's private skill forks may appear in the
// tracked plugin tree.
//
// The denylist is compiled IN MEMORY, at test time, from a source folder that is
// never committed:
//   - $AGENTEX_DENYLIST_SRC when set, else
//   - <repo root>/non-consolidated-skills.
// When that folder is absent (a fresh clone, a feature worktree) the check
// SKIPS with a note — a skip means "not verified", never "clean".
//
// Extraction (generic patterns only — this file names no term of its own):
//   hosts in URLs and bare dotted host names; the <org> of dev.azure.com/<org> and
//   <org>.visualstudio.com; quoted project / team / area / iteration / org values;
//   email addresses; @mentions; ids of 6+ digits; quoted state names in workflow
//   examples; plus an optional local supplement file inside the source folder
//   (SUPPLEMENT_FILE: one term per line, '#' comments).
// Common words, product names and the plugin's own neutral placeholders are
// dropped (GENERIC_* below), so only identifying terms remain.
//
// Scan: every tracked file (git ls-files) of this repo, minus .git, .planning,
// .claude, graphify-out and the source folder itself; binary files are skipped.
// A hit prints ONLY file:line and the masked term (first 2 characters + length) —
// the denylist itself is never printed.
//
// Run: AGENTEX_DENYLIST_SRC=<folder> node scripts/generic-denylist.test.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUPPLEMENT_FILE = 'denylist-supplement.txt';
const EXCLUDED_PREFIXES = ['.git/', '.planning/', '.claude/', 'graphify-out/', 'non-consolidated-skills/'];
const MIN_TERM = 4;

// Hosts that are public services or documentation, never a consumer's own.
const GENERIC_HOSTS = [
  'dev.azure.com', 'vssps.dev.azure.com', 'visualstudio.com', 'azure.com', 'microsoft.com',
  'atlassian.net', 'atlassian.com', 'github.com', 'githubusercontent.com', 'anthropic.com',
  'claude.ai', 'claude.com', 'npmjs.com', 'nodejs.org', 'figma.com', 'playwright.dev',
  'example.com', 'example.org', 'example.net', 'example.test', 'localhost', 'jsonplaceholder.typicode.com',
  'schema.org', 'w3.org', 'json-schema.org', 'mozilla.org', 'google.com', 'wikipedia.org',
];
// File names and code identifiers that look like dotted host names.
const NOT_A_HOST = /\.(js|mjs|cjs|json|jsonl|md|ts|txt|yml|yaml|html|png|jpg|jpeg|sql|sh|ps1|env|lock|log|csv|xlsx|docx|pdf)$/i;
const TLD = /\.(com|net|org|io|co|sa|ae|eg|app|dev|cloud|ai|biz|info|gov|edu|uk|us|de|local|internal|corp)$/i;
// Standard tracker states (ADO process templates, Jira defaults) and the plugin's
// own neutral placeholders — words, not identifiers.
const GENERIC_WORDS = new Set([
  'new', 'active', 'resolved', 'closed', 'removed', 'done', 'to do', 'todo', 'in progress', 'doing',
  'committed', 'approved', 'design', 'ready', 'proposed', 'open', 'reopened', 'in review', 'review',
  'testing', 'in test', 'qa', 'blocked', 'completed', 'cancelled', 'canceled', 'backlog', 'selected for development',
  'inactive', 'not started', 'passed', 'failed', 'notapplicable', 'not applicable', 'inprogress',
  'awaiting-reply', 'awaiting reply',
  'exampleorg', 'sample project', 'proj', 'example', 'qa team', 'my-project', 'my project', 'team',
  'project', 'org', 'organization', 'area', 'iteration', 'default', 'none', 'true', 'false', 'null',
]);
const GENERIC_MENTIONS = new Set(['project', 'currentiteration', 'me', 'today', 'startofday', 'startofmonth',
  'startofweek', 'startofyear', 'teamareas', 'follows', 'recentprojectactivity', 'myrecentactivity',
  'recentmentions', 'param', 'returns', 'type', 'example', 'see', 'deprecated', 'throws', 'link',
  'agentex', 'anthropic', 'playwright', 'types', 'import', 'media', 'keyframes', 'font', 'supports']);
const GENERIC_EMAIL_DOMAIN = /@(example\.(com|org|net|test)|test\.com|domain\.com|company\.com|anthropic\.com|users\.noreply\.github\.com)$/i;
// 6+ digit numbers that are not ids: date stamps (yyyymm, yyyymmdd, yyyymmddHHMMss),
// round or placeholder numbers.
const NOT_AN_ID = /^(?:(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:\d{2}(?:\d{6})?)?|10+|9{6,}|123456\d*|0\d*)$/;
// A dotted name whose first label is a config block or a code object is a key
// path (azure.org, jira.site, opts.team), not a host.
const KEY_PATH = /^(?:azure|jira|kb|figma|login|ci|config|cfg|process|env|args|opts|options|this|data|res|req|ctx|out|payload|project|module|exports)\./i;

const STATE_KEYS = /(state|states|status|devDone|devActive|inTest|qa[A-Z]?\w*|terminal|closeOut)/i;
const LITERAL_KEYS = /^(?:project|projectName|team|teamName|areaPath|area|iterationPath|iteration|org|organization|tenant|site|board|assignee|owner|AZURE_PROJECT|AZURE_TEAM|AZURE_URL|AZURE_AREA_PATH|AZURE_ITERATION_PATH)$/i;

function addTerm(set, raw) {
  const t = String(raw || '').trim().replace(/^[\s'"`]+|[\s'"`.,;:)\]]+$/g, '');
  if (t.length < MIN_TERM) return;
  if (GENERIC_WORDS.has(t.toLowerCase())) return;
  if (/^[\d.]+$/.test(t) && !/^\d{6,}$/.test(t)) return;
  if (/[<>{}$*|\\]/.test(t) && !/\\/.test(t)) return; // placeholders like <org>, ${X}
  set.add(t);
}

function hostOf(h) {
  const host = h.toLowerCase().replace(/:\d+$/, '');
  if (GENERIC_HOSTS.some((g) => host === g || host.endsWith(`.${g}`))) {
    // A tenant sub-domain of a generic service IS identifying: <tenant>.atlassian.net, <org>.visualstudio.com.
    const m = host.match(/^([a-z0-9-]+)\.(atlassian\.net|visualstudio\.com)$/);
    return m ? [host, m[1]] : [];
  }
  return [host];
}

function extractTerms(text) {
  const terms = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+(?::\d+)?)(\/[^\s'"`)<>\]]*)?/gi)) {
    for (const h of hostOf(m[1])) addTerm(terms, h);
    const az = /^dev\.azure\.com$/i.test(m[1]) && m[2] ? m[2].split('/')[1] : null;
    if (az) addTerm(terms, decodeURIComponent(az));
  }
  for (const m of text.matchAll(/(?<![\w@/.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w/-])/gi)) {
    if (TLD.test(m[1]) && !NOT_A_HOST.test(m[1]) && !KEY_PATH.test(m[1])) for (const h of hostOf(m[1])) addTerm(terms, h);
  }
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g)) {
    if (!GENERIC_EMAIL_DOMAIN.test(m[0])) addTerm(terms, m[0]);
  }
  for (const m of text.matchAll(/(?<![\w@.\/])@([A-Za-z][\w.-]{2,}(?: [A-Z][\w-]+)?)/g)) {
    if (!GENERIC_MENTIONS.has(m[1].toLowerCase().split(/[ .]/)[0])) addTerm(terms, m[1]);
  }
  for (const m of text.matchAll(/(?<![\w.#-])(\d{6,})(?![\w.-])/g)) {
    if (!NOT_AN_ID.test(m[1])) addTerm(terms, m[1]);
  }
  // "key": "value" / key: 'value' / key = 'value' for project/team/area/... keys.
  for (const m of text.matchAll(/["']?([A-Za-z_]+)["']?\s*[:=]\s*["'`]([^"'`\n]{3,80})["'`]/g)) {
    if (LITERAL_KEYS.test(m[1])) addTerm(terms, m[2]);
    if (STATE_KEYS.test(m[1])) addTerm(terms, m[2]);
  }
  // WIQL literals: [System.TeamProject] = 'X', [System.AreaPath] UNDER 'X\Y', [System.State] = 'X'.
  for (const m of text.matchAll(/\[System\.(TeamProject|AreaPath|IterationPath|State|AssignedTo|CreatedBy)\]\s*(?:=|<>|UNDER|IN\s*\()\s*'([^']{3,80})'/gi)) {
    addTerm(terms, m[2]);
    if (/path/i.test(m[1])) for (const seg of m[2].split('\\')) addTerm(terms, seg);
  }
  // Quoted state names in workflow examples: arrays under a *State(s) key.
  for (const m of text.matchAll(/["']?(\w*[Ss]tates?)["']?\s*:\s*\[([^\]]{1,400})\]/g)) {
    for (const s of m[2].matchAll(/["'`]([^"'`]{3,60})["'`]/g)) addTerm(terms, s[1]);
  }
  return terms;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function compileDenylist(srcDir) {
  const terms = new Set();
  for (const file of walk(srcDir)) {
    const base = path.basename(file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    if (base === SUPPLEMENT_FILE) {
      for (const line of text.split(/\r?\n/)) {
        const t = line.replace(/#.*$/, '').trim();
        if (t) terms.add(t);
      }
      continue;
    }
    for (const t of extractTerms(text)) terms.add(t);
  }
  return [...terms].sort();
}

function trackedFiles(root) {
  let list;
  try {
    const { execFileSync } = require('node:child_process'); // test-side only
    list = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0').filter(Boolean);
  } catch {
    list = walk(root).map((p) => path.relative(root, p).split(path.sep).join('/'));
  }
  return list.filter((rel) => !EXCLUDED_PREFIXES.some((x) => rel === x.slice(0, -1) || rel.startsWith(x)));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mask = (t) => `${t.slice(0, 2)}…(${t.length})`;

function scan(root, terms) {
  if (!terms.length) return [];
  // Word-bounded, case-insensitive; one alternation per chunk keeps it fast.
  const res = [];
  for (let i = 0; i < terms.length; i += 200) {
    const chunk = terms.slice(i, i + 200);
    res.push({ chunk, re: new RegExp(`(?<![A-Za-z0-9_])(?:${chunk.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi') });
  }
  const lower = new Map(terms.map((t) => [t.toLowerCase(), t]));
  const hits = [];
  for (const rel of trackedFiles(root)) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const { re } of res) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const term = lower.get(m[0].toLowerCase()) || m[0];
          hits.push({ file: rel, line: idx + 1, masked: mask(term) });
        }
      }
    });
  }
  return hits;
}

module.exports = { extractTerms, compileDenylist, scan, mask, trackedFiles };

if (require.main === module) {
  let passed = 0; const failures = [];
  const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
  };

  // Self-checks on synthetic, neutral input (no real term anywhere in this file).
  test('extraction: hosts, the dev.azure.com org, emails, mentions, long ids, quoted project/team/area and state literals', () => {
    const sample = [
      'GET https://dev.azure.com/acmewidgets/_apis/wit and https://portal.acme-widgets.io/login',
      'site: https://acmewidgets.atlassian.net ; mail jane.doe@acme-widgets.io ; cc qa.engineer@example.com',
      'ping @JaneDoe about #4711 and 98765432; "project": "Widget Factory", team: \'Rocket Squad\'',
      "WHERE [System.AreaPath] UNDER 'Widget Factory\\Mobile Crew' AND [System.State] = 'Ready For QA'",
      '"devDoneStates": ["Dev Complete", "Active"], inTestState: "Under QA Review"',
      'set azure.org; run state InProgress; stamp 20261009',
    ].join('\n');
    const t = extractTerms(sample);
    for (const want of ['acmewidgets', 'portal.acme-widgets.io', 'acmewidgets.atlassian.net', 'jane.doe@acme-widgets.io',
      'JaneDoe', '98765432', 'Widget Factory', 'Rocket Squad', 'Mobile Crew', 'Ready For QA', 'Dev Complete', 'Under QA Review']) {
      assert(t.has(want), `extracts ${mask(want)}`);
    }
    for (const generic of ['dev.azure.com', 'qa.engineer@example.com', 'Active', '4711', 'azure.org', 'InProgress', '20261009']) {
      assert(!t.has(generic), `drops the generic ${generic}`);
    }
  });

  test('masking prints only the first two characters and the length', () => {
    assert(mask('Widget Factory') === 'Wi…(14)');
  });

  // The real check.
  const src = process.env.AGENTEX_DENYLIST_SRC
    ? path.resolve(process.env.AGENTEX_DENYLIST_SRC)
    : path.join(ROOT, 'non-consolidated-skills');
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    console.log(`  skip - generic check: no denylist source folder (${process.env.AGENTEX_DENYLIST_SRC ? 'AGENTEX_DENYLIST_SRC' : '<repo root>/non-consolidated-skills'} absent) — NOT verified; set AGENTEX_DENYLIST_SRC to run it`);
  } else {
    test('generic check: no denylisted identifier in any tracked plugin file', () => {
      const terms = compileDenylist(src);
      assert(terms.length > 0, 'the source folder yielded no terms — the extraction or the folder is wrong');
      const hits = scan(ROOT, terms);
      console.log(`    (denylist: ${terms.length} terms compiled in memory; ${trackedFiles(ROOT).length} tracked files scanned)`);
      if (hits.length) {
        throw new Error(`${hits.length} hit(s):\n${hits.map((h) => `      ${h.file}:${h.line}  ${h.masked}`).join('\n')}`);
      }
    });
  }

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
