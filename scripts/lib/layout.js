'use strict';
// AgenTeX project layout contract — ONE known place for everything the agent writes in a
// consumer project, as data, plus the mechanics that carry it:
//
//   - the plugin-managed block in the consumer's CLAUDE.md (render / parse / byte-level
//     splice), which /init-test (scaffold.js) and migration 13 write;
//   - knowledge/INDEX.md line appends (the stray mover's knowledge picks);
//   - the path sets the stray-files check (strays.js) classifies against: protected,
//     plugin-defined, the user-owned root allowlist, litter patterns.
//
// The block sits between two ASCII marker lines. The begin marker carries
// hash=<sha256/12 of the LF-normalized body>, so a body that still matches its own hash
// is pristine (the plugin may refresh it) and anything else is a user edit (flagged,
// never overwritten — invariant #11). Every byte outside the markers is preserved:
// splicing works on Buffers, never on a decoded string, so a BOM, invalid UTF-8 or CRLF
// line endings survive untouched.
//
// Extension point: a later feature appends one ROUTES entry (and optionally one RULES
// entry). Every pristine block becomes `stale` on that release and migration 13
// refreshes it; the entry's `owns` paths become plugin-defined for the stray check; the
// docs-table test forces docs/project-layout.md to match.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ── The routing table ("if you are about to write X, put it here") ───────────
// `owns`: project paths this route defines (a trailing / = a folder). They are never
// stray-check candidates.
const ROUTES = [
  {
    id: 'knowledge',
    write: 'A settled fact about the application, confirmed by a BA/PO answer, by the user, or by the application\'s own documentation',
    to: '`knowledge/`: `app-map.md` (pages, flows, personas), `business-rules.md` (settled business rules), `gotchas.md` (recurring tool or environment problems and their workaround)',
    owns: ['knowledge/'],
  },
  {
    id: 'watchlist',
    write: 'An open item with a trigger: a question awaiting an answer, a retest, an environment blocker, a deferred condition',
    to: 'The QA watchlist, only through AgenTeX\'s `qa-records.js` helper; each kind\'s file is set in `config/project.json` → `qaRecords`',
    owns: [], // the files come from config/project.json qaRecords at check time
  },
  {
    id: 'specs',
    write: 'A test spec or test data',
    to: '`test/<suite>/`, `test/test-data/`',
    owns: ['test/'],
  },
  {
    id: 'config',
    write: 'Project settings, environments, API/DB catalog entries',
    to: '`config/`, `environments/`, `integration/`, through the AgenTeX flows that own them',
    owns: ['config/', 'environments/', 'integration/'],
  },
  {
    id: 'runs',
    write: 'Run output: reports, screenshots, logs',
    to: '`executions/`',
    owns: ['executions/'],
  },
  {
    id: 'scratch',
    write: 'Any temp, probe, exploration, dump or intermediate file, including every `--out`, `--spec` and `--*-file` argument and your own helper scripts',
    to: '`.agentex/scratch/`, one subfolder per task, and nowhere else',
    owns: ['.agentex/scratch/'],
  },
  {
    id: 'rules',
    write: 'A rule about how you should work in this project',
    to: '`CLAUDE.md`, outside this block',
    owns: ['CLAUDE.md'],
  },
  // Owner amendment 2026-10-22: Claude Code's auto-memory lives per machine, outside the
  // repo, so a lesson saved there never reaches a teammate who pulls. This row closes
  // that leak. Routing only — nothing on disk to own.
  {
    id: 'memory',
    write: 'Anything about this project or its application you want to remember next session',
    to: 'The matching row above (usually `knowledge/`), never your personal memory: no teammate ever sees it. Personal memory is only for the user\'s own preferences',
    owns: [],
  },
];

// The numbered rules under the table (the lifecycle).
const RULES = [
  {
    id: 'settled-vs-open',
    text: 'Settled facts go to `knowledge/`; open items with a trigger go to the QA watchlist. A one-off observation is not settled.',
  },
  {
    id: 'knowledge-entries',
    text: 'Every `knowledge/` entry is a list item followed by a `Source: <who or what confirmed it> · <YYYY-MM-DD>` line. Add entries freely and tell the user in one line what you recorded and where. Never rewrite or remove an existing entry without the user\'s explicit yes for that change. When you create a `knowledge/` file, add its one-line description to `knowledge/INDEX.md` in the same step.',
  },
  {
    id: 'watchlist-close',
    text: 'When a watchlist item closes with a settled answer, resolve it through `qa-records.js` (its history is kept) and add the answer to the matching `knowledge/` file with its source and date. A closure with no lasting fact, such as a retest that passed or a blocker that simply cleared, adds nothing.',
  },
];

const HEADING = '## AgenTeX: where things go in this project';
const PREAMBLE = 'Maintained by the AgenTeX plugin; `/update-agentex` refreshes it. Keep your own rules outside this block: if you edit inside it, AgenTeX stops refreshing it and tells you so.';
const INDEX_FIRST = '**Read `knowledge/INDEX.md` first** (when it exists) before planning a run, designing tests, analysing a story or answering a question about the application, then open only the files it lists that matter for the task. No `knowledge/` folder is normal: carry on, and never create empty files just to read them.';
const TABLE_HEAD = ['| If you are about to write… | …put it here |', '|---|---|'];

const BEGIN_PREFIX = '<!-- agentex:begin project-layout ';
const END_MARKER = '<!-- agentex:end project-layout -->';
const BEGIN_RE = /^<!-- agentex:begin project-layout v1 hash=([0-9a-f]{12}) -->\r?$/;
const WRAP = 92;

const EDITED_FLAG = 'CLAUDE.md: the AgenTeX block was edited by hand, so it was not refreshed — move your own lines outside the block, delete the block (both marker lines too), then re-run /update-agentex to get the current one (docs/project-layout.md#the-agentex-block-in-claudemd)';
const MALFORMED_FLAG = 'duplicate or broken AgenTeX block markers in CLAUDE.md — keep one begin/end pair, then re-run /update-agentex (docs/project-layout.md#the-agentex-block-in-claudemd)';
const danglingFlag = (target) => `CLAUDE.md is a symlink to ${target}, which does not exist, so the AgenTeX block was not written — create the target file (or replace the link with a file), then re-run /update-agentex (docs/project-layout.md#the-agentex-block-in-claudemd)`;

// Greedy word wrap; continuation lines carry `indent`.
function wrap(text, { first = '', indent = '' } = {}) {
  const lines = [];
  let line = first;
  let bare = true;
  for (const word of text.split(' ')) {
    if (!bare && line.length + 1 + word.length > WRAP) { lines.push(line); line = indent + word; }
    else line += (bare ? '' : ' ') + word;
    bare = false;
  }
  lines.push(line);
  return lines;
}

// The block body (between the marker lines), LF line endings, ending with one LF.
function renderBody({ routes = ROUTES, rules = RULES } = {}) {
  const lines = [
    HEADING, '',
    ...wrap(PREAMBLE), '',
    ...wrap(INDEX_FIRST), '',
    ...TABLE_HEAD,
    ...routes.map((r) => `| ${r.write} | ${r.to} |`), '',
    ...rules.flatMap((r, i) => wrap(r.text, { first: `${i + 1}. `, indent: '   ' })),
  ];
  return `${lines.join('\n')}\n`;
}

const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

// The whole block — begin line, body, end marker — with no EOL after the end marker.
function renderBlock({ eol = '\n', routes, rules } = {}) {
  const body = renderBody({ routes, rules });
  const begin = `${BEGIN_PREFIX}v1 hash=${sha12(Buffer.from(body, 'utf8'))} -->`;
  return [begin, ...body.slice(0, -1).split('\n'), END_MARKER].join(eol);
}

// LF-normalized bytes (latin1 round trip is byte-exact).
const lfBytes = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

// Offsets of a marker that starts a line.
function lineStarts(buf, marker) {
  const out = [];
  for (let i = buf.indexOf(marker); i !== -1; i = buf.indexOf(marker, i + 1)) {
    if (i === 0 || buf[i - 1] === 0x0a) out.push(i);
  }
  return out;
}

// parseBlock(buf) → { state, beginStart?, endEnd?, eol? }
//   absent    no begin marker (and no stray end marker)
//   current   one balanced pair; the LF body equals the render
//   stale     balanced; hash matches the body; body differs from the render
//   edited    balanced; hash missing/garbled/mismatched; body differs from the render
//   malformed two begins, two ends, an end without a begin, a begin without an end,
//             or an end before a begin
function parseBlock(buf, { routes, rules } = {}) {
  const begins = lineStarts(buf, BEGIN_PREFIX);
  const ends = lineStarts(buf, END_MARKER);
  if (!begins.length && !ends.length) return { state: 'absent' };
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { state: 'malformed' };
  const beginStart = begins[0];
  const nl = buf.indexOf(0x0a, beginStart);
  if (nl === -1 || nl > ends[0]) return { state: 'malformed' };
  const eol = buf[nl - 1] === 0x0d ? '\r\n' : '\n';
  const beginLine = buf.subarray(beginStart, nl).toString('latin1');
  const body = lfBytes(buf.subarray(nl + 1, ends[0]));
  const out = { beginStart, endEnd: ends[0] + END_MARKER.length, eol };
  if (body.equals(Buffer.from(renderBody({ routes, rules }), 'utf8'))) return { ...out, state: 'current' };
  const m = beginLine.match(BEGIN_RE);
  return { ...out, state: m && m[1] === sha12(body) ? 'stale' : 'edited' };
}

// The text with a balanced block's byte range removed (absent/malformed: unchanged).
// Accepts and returns a string or a Buffer.
function stripManagedBlock(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const p = parseBlock(buf);
  if (p.beginStart === undefined) return content;
  const out = Buffer.concat([buf.subarray(0, p.beginStart), buf.subarray(p.endEnd)]);
  return Buffer.isBuffer(content) ? out : out.toString('utf8');
}

// tmp + rename against the real file: a CLAUDE.md that is a symlink (to AGENTS.md, say)
// stays a link and its target gets the bytes; the tmp sits next to the target (same
// filesystem, so the rename is atomic) and takes the target's mode. `file` must exist.
function writeAtomic(file, buf) {
  const real = fs.realpathSync(file);
  const mode = fs.statSync(real).mode & 0o7777;
  const tmp = `${real}.tmp`;
  try {
    fs.writeFileSync(tmp, buf, { mode });
    fs.chmodSync(tmp, mode); // writeFileSync's mode is masked by the umask
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

// The separator before an appended block (R1.4): a blank-line ending → nothing; one EOL
// → one more; no trailing EOL → two.
function separator(buf, eol) {
  if (!buf.length) return '';
  if (buf[buf.length - 1] !== 0x0a) return eol + eol;
  const cut = buf.length >= 2 && buf[buf.length - 2] === 0x0d ? 2 : 1;
  return buf.length > cut && buf[buf.length - cut - 1] === 0x0a ? '' : eol;
}

// Insert, refresh or leave the block; never writes outside the markers.
// Returns { kind: 'created'|'skipped'|'flag', state, path, note, message? }.
function ensureLayoutBlock(projectRoot, { dryRun = false, routes, rules } = {}) {
  const file = path.join(projectRoot, 'CLAUDE.md');
  const base = { path: 'CLAUDE.md' };
  let link = null;
  try { if (fs.lstatSync(file).isSymbolicLink()) link = fs.readlinkSync(file); } catch { /* no CLAUDE.md */ }
  const existed = fs.existsSync(file); // follows a link: false for a dangling one
  // A dangling link is never replaced by a file, and its target is never created (it may
  // point anywhere, even outside the project): flagged, zero writes.
  if (link !== null && !existed) return { ...base, kind: 'flag', state: 'dangling', note: 'CLAUDE.md is a dangling symlink, not written', message: danglingFlag(link) };
  const buf = existed ? fs.readFileSync(file) : Buffer.alloc(0);
  const p = parseBlock(buf, { routes, rules });
  if (p.state === 'current') return { ...base, kind: 'skipped', state: 'current', note: 'AgenTeX layout block already current' };
  if (p.state === 'edited') return { ...base, kind: 'flag', state: 'edited', note: 'AgenTeX block edited by hand, not refreshed', message: EDITED_FLAG };
  if (p.state === 'malformed') return { ...base, kind: 'flag', state: 'malformed', note: 'AgenTeX block markers broken, not refreshed', message: MALFORMED_FLAG };
  if (p.state === 'stale') {
    if (!dryRun) {
      const block = Buffer.from(renderBlock({ eol: p.eol, routes, rules }), 'utf8');
      writeAtomic(file, Buffer.concat([buf.subarray(0, p.beginStart), block, buf.subarray(p.endEnd)]));
    }
    return { ...base, kind: 'created', state: 'refreshed', note: 'AgenTeX layout block refreshed' };
  }
  // absent → append
  const firstNl = buf.indexOf(0x0a);
  const eol = firstNl > 0 && buf[firstNl - 1] === 0x0d ? '\r\n' : '\n';
  if (!dryRun) {
    const add = `${separator(buf, eol)}${renderBlock({ eol, routes, rules })}${eol}`;
    if (existed) writeAtomic(file, Buffer.concat([buf, Buffer.from(add, 'utf8')]));
    else fs.writeFileSync(file, add, { flag: 'wx' }); // no CLAUDE.md at all (not a link): created
  }
  return { ...base, kind: 'created', state: 'created', note: existed ? 'AgenTeX layout block appended' : 'created with the AgenTeX layout block' };
}

// ── knowledge/ ───────────────────────────────────────────────────────────────
const KNOWLEDGE_DIR = 'knowledge';
const INDEX_FILE = 'INDEX.md';
const INDEX_HEADER = '# Knowledge index\n\nSettled facts about the application under test. Read this first; open only the files that matter for the task.\n\n';
// The fixed files and the line the agent copies into INDEX.md when it creates one.
const KNOWLEDGE_FILES = {
  'app-map.md': 'Pages, flows and personas of the application under test',
  'business-rules.md': 'Settled business rules: confirmed BA/PO answers',
  'gotchas.md': 'Recurring tool and environment problems, with their workaround',
};

// Append `- [file](file) — description` to knowledge/INDEX.md: creates the file with its
// header when absent, a no-op when a line already links that file, never rewrites a byte.
function appendIndexLine(projectRoot, file, description) {
  const index = path.join(projectRoot, KNOWLEDGE_DIR, INDEX_FILE);
  const rel = `${KNOWLEDGE_DIR}/${INDEX_FILE}`;
  const existed = fs.existsSync(index);
  const buf = existed ? fs.readFileSync(index) : Buffer.alloc(0);
  if (buf.toString('utf8').includes(`](${file})`)) return { kind: 'skipped', path: rel, note: `${file} already listed` };
  const firstNl = buf.indexOf(0x0a);
  const eol = firstNl > 0 && buf[firstNl - 1] === 0x0d ? '\r\n' : '\n';
  const lead = !existed ? INDEX_HEADER : buf.length && buf[buf.length - 1] !== 0x0a ? eol : '';
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.appendFileSync(index, Buffer.from(`${lead}- [${file}](${file}) — ${description}${eol}`, 'utf8'));
  return { kind: 'created', path: rel, note: `${file} listed` };
}

// ── Path sets for the stray-files check (tunable data, Q8) ───────────────────
// Never scanned, never listed (a trailing / = the whole subtree).
const PROTECTED = ['.git/', '.claude/', 'test/', 'config/', 'environments/', 'integration/',
  'executions/', 'knowledge/', 'node_modules/', '.playwright-cli/', '.env'];
const PROTECTED_RE = [/^\.env\.[^/]+$/]; // .env.local, .env.qc, …
// Plugin-defined files and folders beyond ROUTES[].owns.
const PLUGIN_DEFINED = ['.agentex/version.json', '.agentex/test-template.md', '.agentex/cache/',
  '.agentex/scratch/', '.agentex/release-gate/', '.gitignore', 'CLAUDE.md',
  // legacy plugin files the migrations move (m01, m02) — run 1 of a legacy project never
  // reports what the pipeline is about to handle
  'agentex.config.json', 'integrations/'];
// OS metadata: never listed anywhere.
const OS_METADATA = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
// User-owned root files: never reported. Checked after the litter names (strays.js), so a
// probe-*, tmp-* or *.tmp file is litter even when it is shaped like tool config.
const ROOT_ALLOWLIST = [
  // docs and repository meta
  /^README/i, /^LICEN[CS]E/i, /^CHANGELOG/i, /^CONTRIBUTING/i, /^CODE_OF_CONDUCT/i, /^SECURITY\.md$/i, /^NOTICE/i,
  /^CODEOWNERS$/, /^CLAUDE\.local\.md$/, /^AGENTS\.md$/,
  /^\.gitattributes$/, /^\.gitmodules$/, /^\.mailmap$/, /^\.editorconfig$/, /^\.env\.example$/,
  /^\.node-version$/, /^\.python-version$/, /^\.ruby-version$/, /^\.tool-versions$/, /^\.mcp\.json$/,
  // tool configuration by shape: *.config.*, *.conf.*, .*rc / .*rc.*, .*ignore
  /\.config\.[^.]+(\.[^.]+)*$/i, /\.conf\.[^.]+$/i, /^\.[^.]+rc$/, /^\.[^.]+rc\.[^.]+$/, /^\.[^.]+ignore$/,
  /^tsconfig.*\.json$/, /^jsconfig.*\.json$/, /^\.eslintrc/, /^\.prettierrc/,
  /^global-(setup|teardown)\.[^.]+$/, /^\.pre-commit-config\.ya?ml$/, /^renovate\.json5?$/, /^biome\.jsonc?$/,
  /^(cspell|\.cspell)\.json$/, /^\.browserslistrc$/, /^nuget\.config$/i, /^sonar-project\.properties$/,
  // manifests and lockfiles
  /^package\.json$/, /^package-lock\.json$/, /^npm-shrinkwrap\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/, /^bun\.lockb?$/, /^bunfig\.toml$/, /^deno\.jsonc?$/, /^deno\.lock$/,
  /^lerna\.json$/, /^nx\.json$/, /^turbo\.json$/, /^vercel\.json$/, /^netlify\.toml$/,
  /^requirements.*\.txt$/, /^constraints.*\.txt$/, /^pyproject\.toml$/, /^setup\.cfg$/, /^setup\.py$/, /^tox\.ini$/,
  /^pytest\.ini$/, /^conftest\.py$/, /^Pipfile(\.lock)?$/, /^poetry\.lock$/, /^uv\.lock$/,
  /^Gemfile(\.lock)?$/, /^go\.(mod|sum|work)$/, /^Cargo\.(toml|lock)$/, /^composer\.(json|lock)$/,
  /^pom\.xml$/, /^(build|settings)\.gradle(\.kts)?$/, /^gradle\.properties$/, /^gradlew(\.bat)?$/, /^mvnw(\.cmd)?$/,
  /\.sln$/i, /\.(cs|fs|vb)proj$/i, /^global\.json$/, /^Directory\.(Build|Packages)\.(props|targets)$/,
  // build, containers, CI
  /^Makefile$/, /^Procfile$/, /^Jenkinsfile/, /^Dockerfile/, /^Containerfile/,
  /^docker-compose.*\.ya?ml$/, /^compose.*\.ya?ml$/,
  /^azure-pipelines.*\.ya?ml$/, /^\.gitlab-ci\.ya?ml$/, /^bitbucket-pipelines\.ya?ml$/, /^\.travis\.ya?ml$/,
  /^appveyor\.ya?ml$/, /^\.?codecov\.ya?ml$/,
];
// Litter: agent leftovers by name, anywhere outside protected subtrees.
const LITTER_NAMES = [/^probe-/, /^explore-/, /^recon-/, /^scratch-/, /^tmp-/, /^temp-/, /^\.tmp-/,
  /^\.scratch_/, /^\.scratch-/, /-out\.txt$/, /\.out\.txt$/, /\.tmp$/];
const LITTER_DIRS = ['.tmp', 'tmp', 'temp', '.temp', '.scratch', 'scratch'];
// Root-level file sub-classes.
const ROOT_DUMP = /\.(json|jsonl|txt|log|csv|html|xml)$/i;
const ROOT_SCRIPT = /\.(mjs|cjs|js|ts|py|ps1|sh)$/i;

// Every plugin-defined path for this project: ROUTES[].owns + PLUGIN_DEFINED + the
// configured qaRecords files + the estimation file. An invalid qaRecords block falls back to
// the defaults and adds one note (the check still runs).
function definedPaths(projectRoot, { routes = ROUTES } = {}) {
  const { STRUCTURED_DEFAULTS, getStructured } = require('./project_config.js');
  const { ESTIMATION_FILE_REL } = require('./estimation_config.js');
  const notes = [];
  let qa;
  try { qa = getStructured(projectRoot, 'qaRecords'); }
  catch (e) {
    qa = { ...STRUCTURED_DEFAULTS.qaRecords };
    notes.push(`config/project.json → qaRecords could not be read (${e.message}) — the default QA watchlist paths were used for this check`);
  }
  const paths = new Set([...routes.flatMap((r) => r.owns || []), ...PLUGIN_DEFINED, ESTIMATION_FILE_REL,
    ...Object.values(qa).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))]);
  return { paths: [...paths].sort(), notes, qaRecords: qa };
}

module.exports = {
  ROUTES, RULES, BEGIN_PREFIX, END_MARKER, EDITED_FLAG, MALFORMED_FLAG,
  renderBody, renderBlock, parseBlock, stripManagedBlock, ensureLayoutBlock,
  KNOWLEDGE_DIR, INDEX_HEADER, KNOWLEDGE_FILES, appendIndexLine,
  PROTECTED, PROTECTED_RE, PLUGIN_DEFINED, OS_METADATA, ROOT_ALLOWLIST, LITTER_NAMES, LITTER_DIRS,
  ROOT_DUMP, ROOT_SCRIPT, definedPaths,
};
