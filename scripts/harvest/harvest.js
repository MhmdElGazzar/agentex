#!/usr/bin/env node
// harvest.js — the maintainer's read-only harvest of the field-feedback signals that
// consumer projects leave behind (field-feedback-loop S-4; spec appendix A5).
//
//   node scripts/harvest/harvest.js (--root <dir>)… [--roots-file <file>] [--out <dir>]
//                                   [--label basename|index]
//
// Maintainer tooling: never shipped by any host (build_host COMMON_EXCLUDES), never named
// by a command, skill or agent. It reads the projects named by the maintainer and writes
// two files, report.md and report.json, to a folder OUTSIDE the plugin repo, the planning
// repo and every root.
//
// Roots: the union of every --root, the --roots-file (one path per line, # comments) and
// AGENTEX_HARVEST_ROOTS (the OS path delimiter). There is no default. No root at all is
// exit 2 with nothing written. A roots file inside the plugin repo is refused.
//
// Read-only by construction: only readdir, lstat and readFile on matched paths. No git
// command, no process, no network module. It never descends into .git, node_modules,
// executions, .auth (so test/.auth), .playwright-cli, never follows a symlink, and never
// opens a file whose basename starts with .env.
//
// Signals per root (a signal's own text is reported only for learnings and promotions;
// scripts, probes and notes are reported by name, size and counts, never by content):
//   learning         .agentex/plugin-learnings.md (the learnings.js parser)
//   fork             a project copy of a plugin skill (plugin_inventory.js#detectForks)
//   promotion        [agentex:promote], or "candidate for promotion to AgenTeX" and
//                    "promote|upstream … to (the) AgenTeX (plugin)" in CLAUDE.md,
//                    .claude/CLAUDE.md or CLAUDE.local.md, outside the AgenTeX block
//   helper-script    .agentex/scripts/** and .agentex/*.{js,mjs,cjs,ts,py,sh,ps1}, depth <= 3
//   port-checklist   .agentex/**/*.md and root *notes*.md with a "port to the plugin" /
//                    "pending changes" / "upstream" line: the unchecked items
//   root-probe       probe-*, explore-*, recon-* scripts, *-out.txt and *_dump*.json at the root
//   adhoc-watchlist  watchlist / pending-questions / open-questions files that are not a
//                    configured qaRecords path
//
// Stdout: ONE JSON line {tool, schemaVersion, result: OK|PARTIAL|ERROR, roots, scanned,
// unreadable, signals:{kind: n}, out}. Exit 0 OK · 1 PARTIAL (a root was unreadable, named
// by label) · 2 usage or refused (nothing written).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const learnings = require('../lib/learnings.js');
const inventory = require('../lib/plugin_inventory.js');
const { STRUCTURED_DEFAULTS } = require('../lib/project_config.js');

const TOOL = 'agentex-field-harvest';
const SCHEMA_VERSION = 1;
const KINDS = ['learning', 'fork', 'promotion', 'helper-script', 'port-checklist', 'root-probe', 'adhoc-watchlist'];
const NEVER_DESCEND = new Set(['.git', 'node_modules', 'executions', '.auth', '.playwright-cli']);
const MAX_READ_BYTES = 2 * 1024 * 1024;          // tunable (Q8): a bigger file is listed, not read
const MAX_ITEMS = 50;                            // unchecked items kept per checklist
const MAX_ENTRIES_PER_ROOT = 50_000;
const REPORT_BANNER = 'Contains consumer specifics. Never commit to the plugin repo or the planning repo; generalize before filing.';
const USAGE = 'usage: harvest.js (--root <dir>)… [--roots-file <file>] [--out <dir>] [--label basename|index]';

const SCRIPT_EXT = /\.(?:js|mjs|cjs|ts|py|sh|ps1)$/i;
const PROMOTE_TAG = /\[agentex:promote\]/i;
const PROMOTE_PHRASES = [
  /candidate for promotion to (?:the )?agentex(?: plugin)?/i,
  /\b(?:promote|upstream)\b.*\bto (?:the )?agentex(?: plugin)?\b/i,
];
const PORT_LINE = /port(?:ed)? to (?:the )?(?:plugin|repo)|pending changes|upstream/i;
const UNCHECKED = /^\s*[-*+]\s+\[ \]\s+(.*\S)\s*$/;
const PROBE_FILE = /^(?:probe|explore|recon)[-_].*\.(?:m?js|cjs|ts|py|sh|ps1)$/i;
const OUT_FILE = /-out\.txt$/i;
const DUMP_FILE = /_dump.*\.json$/i;
const WATCHLIST_NAME = /(?:watch-?list|pending[-_ ]?(?:questions|analysis)|open[-_]questions)/i;
const TEXT_FILE = /\.(?:md|txt|jsonl|json|csv)$/i;

class Refusal extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

// ---- args ------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { roots: [], rootsFile: null, out: null, label: 'basename' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]; let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const value = () => {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined || (inline === null && String(v).startsWith('--'))) throw new Refusal(`${a} needs a value. ${USAGE}`, 'usage');
      return String(v);
    };
    if (a === '--root') o.roots.push(value());
    else if (a === '--roots-file') o.rootsFile = value();
    else if (a === '--out') o.out = value();
    else if (a === '--label') {
      o.label = value();
      if (o.label !== 'basename' && o.label !== 'index') throw new Refusal(`--label must be basename or index. ${USAGE}`, 'usage');
    } else throw new Refusal(`unknown argument ${JSON.stringify(a.slice(0, 40))}. ${USAGE}`, 'usage');
  }
  return o;
}

// ---- paths -----------------------------------------------------------------------------------
// realpath of the nearest existing ancestor, plus the not-yet-existing rest.
function realpathLoose(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* climb */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur)); cur = parent;
  }
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const posix = (p) => p.split(path.sep).join('/');

function readRootsFile(file, o) {
  const abs = realpathLoose(path.resolve(file));
  if (inside(abs, o.pluginRepo)) throw new Refusal('the roots file is inside the plugin repo — keep it outside (it names consumer projects).', 'roots-file-in-plugin-repo');
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { throw new Refusal('the roots file could not be read.', 'usage'); }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// ---- reading helpers (readdir, lstat, readFile only) ---------------------------------------------
function listDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => !e.name.startsWith('.env') && !e.isSymbolicLink()).sort((a, b) => (a.name < b.name ? -1 : 1));
}
// Calls fn(relPosix, abs, dirent) for every regular file under root/rel up to maxDepth folders deep.
function walkFiles(root, rel, maxDepth, fn, budget) {
  const visit = (relDir, depth) => {
    for (const e of listDir(path.join(root, relDir))) {
      if (budget.left-- <= 0) return;
      const r = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!NEVER_DESCEND.has(e.name) && depth < maxDepth) visit(r, depth + 1); }
      else if (e.isFile()) fn(r, path.join(root, r), e);
    }
  };
  visit(rel, 0);
}
function readText(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}
const countLines = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// ---- the signals ---------------------------------------------------------------------------------
function learningSignals(root) {
  const abs = path.join(root, learnings.FILE_REL);
  let buf;
  try { const st = fs.lstatSync(abs); if (!st.isFile() || st.size > MAX_READ_BYTES) return []; buf = fs.readFileSync(abs); } catch { return []; }
  return learnings.parse(buf).entries.map((e) => ({
    kind: 'learning', id: e.id, date: e.date, trigger: e.trigger, affected: e.affected, version: e.version, status: e.status,
    ...(e.absorbedIn ? { absorbedIn: e.absorbedIn } : {}), problem: e.fields.problem || '', workaround: e.fields.workaround || '',
  }));
}

function promotionSignals(root) {
  const out = [];
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
    const text = readText(path.join(root, rel));
    if (text === null) continue;
    let inBlock = false;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^<!-- agentex:begin /.test(line)) { inBlock = true; return; }
      if (/^<!-- agentex:end /.test(line)) { inBlock = false; return; }
      if (inBlock) return;
      if (PROMOTE_TAG.test(line) || PROMOTE_PHRASES.some((re) => re.test(line))) out.push({ kind: 'promotion', file: rel, line: i + 1, text: line.trim().slice(0, 400) });
    });
  }
  return out;
}

function helperScriptSignals(root) {
  const found = new Map();
  const add = (rel, abs) => {
    if (found.has(rel)) return;
    let size = null; let lines = null;
    try { size = fs.lstatSync(abs).size; } catch { return; }
    const text = size <= MAX_READ_BYTES ? readText(abs) : null;
    if (text !== null) lines = countLines(text);
    found.set(rel, { kind: 'helper-script', path: rel, size, lines });
  };
  walkFiles(root, '.agentex/scripts', 3, add, { left: MAX_ENTRIES_PER_ROOT });
  for (const e of listDir(path.join(root, '.agentex'))) if (e.isFile() && SCRIPT_EXT.test(e.name)) add(`.agentex/${e.name}`, path.join(root, '.agentex', e.name));
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function portChecklistSignals(root) {
  const files = [];
  walkFiles(root, '.agentex', 6, (rel) => { if (/\.md$/i.test(rel) && rel !== learnings.FILE_REL) files.push(rel); }, { left: MAX_ENTRIES_PER_ROOT });
  for (const e of listDir(root)) if (e.isFile() && /notes/i.test(e.name) && /\.md$/i.test(e.name)) files.push(e.name);
  const out = [];
  for (const rel of [...new Set(files)].sort()) {
    const text = readText(path.join(root, rel));
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    if (!lines.some((l) => PORT_LINE.test(l))) continue;
    const items = lines.map((l) => UNCHECKED.exec(l)).filter(Boolean).map((m) => m[1].slice(0, 200));
    if (items.length) out.push({ kind: 'port-checklist', file: rel, unchecked: items.length, items: items.slice(0, MAX_ITEMS) });
  }
  return out;
}

function rootProbeSignals(root) {
  const out = [];
  for (const e of listDir(root)) {
    if (!e.isFile()) continue;
    const pattern = PROBE_FILE.test(e.name) ? 'probe' : OUT_FILE.test(e.name) ? 'out-file' : DUMP_FILE.test(e.name) ? 'dump' : null;
    if (pattern) out.push({ kind: 'root-probe', name: e.name, pattern });   // named, counted, never opened
  }
  return out;
}

// The qaRecords files this project configured (or the defaults): they are not "ad hoc".
function configuredQaPaths(root) {
  const paths = { ...STRUCTURED_DEFAULTS.qaRecords };
  const text = readText(path.join(root, 'config', 'project.json'));
  if (text !== null) {
    try {
      const q = JSON.parse(text.replace(/^﻿/, '')).qaRecords;
      if (q && typeof q === 'object') for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && k in paths) paths[k] = v;
    } catch { /* not JSON: defaults */ }
  }
  return new Set(Object.values(paths).map((p) => posix(path.normalize(p))));
}
function adhocWatchlistSignals(root) {
  const configured = configuredQaPaths(root);
  const out = [];
  walkFiles(root, '', 4, (rel, abs, e) => {
    if (!WATCHLIST_NAME.test(e.name) || !TEXT_FILE.test(e.name) || configured.has(rel)) return;
    const text = readText(abs);
    out.push({ kind: 'adhoc-watchlist', path: rel, lines: text === null ? null : countLines(text) });
  }, { left: MAX_ENTRIES_PER_ROOT });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function scanRoot(root, inv) {
  let st;
  try { st = fs.lstatSync(root); } catch { return null; }
  if (!st.isDirectory()) return null;
  try { fs.readdirSync(root); } catch { return null; }
  return [
    ...learningSignals(root),
    ...inventory.detectForks(root, inv).map((f) => ({ kind: 'fork', plugin: f.plugin, rule: f.rule, path: f.path })),
    ...promotionSignals(root),
    ...helperScriptSignals(root),
    ...portChecklistSignals(root),
    ...rootProbeSignals(root),
    ...adhocWatchlistSignals(root),
  ];
}

// ---- the report ----------------------------------------------------------------------------------
const skillOf = (s) => (s.kind === 'learning' ? s.affected || 'unknown' : s.kind === 'fork' ? s.plugin : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function describe(s) {
  const tag = `[${s.project}]`;
  switch (s.kind) {
    case 'learning': return [`- ${tag} ${s.id} · ${s.date} · ${s.trigger} · v${s.version}${s.status === 'absorbed' ? ` · absorbed in v${s.absorbedIn || '?'}` : ''}`, `  problem: ${s.problem.replace(/\n/g, ' ')}`, `  workaround: ${s.workaround.replace(/\n/g, ' ')}`];
    case 'fork': return [`- ${tag} ${s.rule} — ${s.path}`];
    case 'promotion': return [`- ${tag} ${s.file}:${s.line} — ${s.text}`];
    case 'helper-script': return [`- ${tag} ${s.path} — ${s.size} bytes, ${s.lines === null ? '?' : s.lines} lines`];
    case 'port-checklist': return [`- ${tag} ${s.file} — ${plural(s.unchecked, 'unchecked item')}`, ...s.items.map((t) => `  - ${t}`)];
    case 'root-probe': return [`- ${tag} ${s.name} (${s.pattern})`];
    default: return [`- ${tag} ${s.path} — ${s.lines === null ? '?' : s.lines} lines`];
  }
}
function kindSections(signals, level) {
  const out = [];
  for (const kind of KINDS) {
    const list = signals.filter((s) => s.kind === kind);
    if (!list.length) continue;
    out.push(`${'#'.repeat(level)} ${kind} (${list.length})`);
    for (const s of list) out.push(...describe(s));
    out.push('');
  }
  return out;
}
const projectsOf = (list) => new Set(list.map((s) => s.project)).size;

function buildReport(roots, signals, now) {
  const open = signals.filter((s) => !(s.kind === 'learning' && s.status === 'absorbed'));
  const absorbed = signals.filter((s) => s.kind === 'learning' && s.status === 'absorbed');
  const skills = [...new Set(open.map(skillOf).filter(Boolean))].sort();
  const bySkill = {};
  for (const sk of skills) {
    const list = open.filter((s) => skillOf(s) === sk);
    bySkill[sk] = { signals: list.length, projects: projectsOf(list), ...Object.fromEntries(KINDS.map((k) => [k, list.filter((s) => s.kind === k).length]).filter(([, n]) => n > 0)) };
  }
  const md = [REPORT_BANNER, '', '# AgenTeX field harvest', '',
    `Generated ${now.toISOString()} · ${plural(roots.length, 'root')} (${roots.filter((r) => r.status === 'ok').length} scanned, ${roots.filter((r) => r.status !== 'ok').length} unreadable)`,
    ...(roots.some((r) => r.status !== 'ok') ? [`Unreadable: ${roots.filter((r) => r.status !== 'ok').map((r) => r.label).join(', ')}`] : []), '',
    '## By affected plugin skill', ''];
  if (!skills.length) md.push('Nothing attributed to a plugin skill.', '');
  for (const sk of skills) {
    const list = open.filter((s) => skillOf(s) === sk);
    md.push(`### ${sk} — ${plural(list.length, 'signal')} across ${plural(projectsOf(list), 'project')}`, '', ...kindSections(list, 4));
  }
  const rest = open.filter((s) => !skillOf(s));
  md.push('## Not tied to a plugin skill', '');
  if (!rest.length) md.push('None.', '');
  else md.push(...kindSections(rest, 3));
  md.push('## Absorbed learnings (already covered by a release)', '');
  if (!absorbed.length) md.push('None.', '');
  for (const sk of [...new Set(absorbed.map(skillOf))].sort()) {
    const list = absorbed.filter((s) => skillOf(s) === sk);
    md.push(`### ${sk} — ${plural(list.length, 'entry')} across ${plural(projectsOf(list), 'project')}`, '');
    for (const s of list) md.push(...describe(s));
    md.push('');
  }
  const json = {
    tool: TOOL, schemaVersion: SCHEMA_VERSION, generatedAt: now.toISOString(),
    roots: roots.map((r) => ({ label: r.label, status: r.status, signals: r.signals })),
    summary: Object.fromEntries(KINDS.map((k) => [k, signals.filter((s) => s.kind === k).length])),
    bySkill, signals,
  };
  return { md: `${md.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`, json };
}

// The ONLY place that writes: the two report files, into the resolved out folder.
function writeOutputs(out, md, json) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.md'), md, 'utf8');
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

// ---- run -------------------------------------------------------------------------------------------
function resolveRoots(o, opts) {
  const raw = [...o.roots];
  if (o.rootsFile) raw.push(...readRootsFile(o.rootsFile, opts));
  const envRoots = (opts.env.AGENTEX_HARVEST_ROOTS || '').split(path.delimiter).map((x) => x.trim()).filter(Boolean);
  raw.push(...envRoots);
  const seen = new Set(); const roots = [];
  for (const r of raw) {
    const abs = realpathLoose(path.resolve(r));
    if (seen.has(abs)) continue;
    seen.add(abs); roots.push(abs);
  }
  return roots;
}
function labelRoots(roots, mode) {
  const used = new Map();
  return roots.map((abs, i) => {
    if (mode === 'index') return `project-${i + 1}`;
    const base = path.basename(abs) || `project-${i + 1}`;
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

// run(argv, { env, now, tmpdir, pluginRepo }): the seams are for tests; the CLI passes none.
async function run(argv, opts = {}) {
  const env = opts.env || process.env;
  const now = (opts.now || (() => new Date()))();
  const pluginRepo = realpathLoose(opts.pluginRepo || path.resolve(__dirname, '..', '..'));
  const line = (result, extra) => ({ tool: TOOL, schemaVersion: SCHEMA_VERSION, result, ...extra });
  try {
    const o = parseArgs(argv);
    const roots = resolveRoots(o, { env, pluginRepo });
    if (!roots.length) throw new Refusal('no root: pass --root <dir>, --roots-file <file> or set AGENTEX_HARVEST_ROOTS. There is no default. ' + USAGE, 'no-roots');
    const outBase = o.out ? path.resolve(o.out) : path.join(opts.tmpdir || os.tmpdir(), `agentex-harvest-${utcStamp(now)}`);
    const out = realpathLoose(outBase);
    if (inside(out, pluginRepo)) throw new Refusal('the destination is inside the plugin repo (or the planning repo nested in it) — the report holds consumer specifics; choose a folder outside.', 'destination-in-plugin-repo');
    if (roots.some((r) => inside(out, r))) throw new Refusal('the destination is inside a root — a harvest never writes into a project it reads.', 'destination-in-root');

    const inv = inventory.loadInventory(pluginRepo);
    const labels = labelRoots(roots, o.label);
    const signals = []; const report = [];
    roots.forEach((root, i) => {
      const found = scanRoot(root, inv);
      if (found === null) { report.push({ label: labels[i], status: 'unreadable', signals: 0 }); return; }
      for (const s of found) signals.push({ project: labels[i], ...s });
      report.push({ label: labels[i], status: 'ok', signals: found.length });
    });
    const { md, json } = buildReport(report, signals, now);
    writeOutputs(out, md, json);
    const unreadable = report.filter((r) => r.status !== 'ok');
    const counts = Object.fromEntries(KINDS.map((k) => [k, signals.filter((s) => s.kind === k).length]));
    return {
      code: unreadable.length ? 1 : 0,
      out: line(unreadable.length ? 'PARTIAL' : 'OK', { roots: roots.length, scanned: roots.length - unreadable.length, unreadable: unreadable.length, ...(unreadable.length ? { unreadableRoots: unreadable.map((r) => r.label) } : {}), signals: counts, out }),
    };
  } catch (e) {
    if (e instanceof Refusal) return { code: 2, out: line('ERROR', { reason: e.reason, error: { message: e.message } }) };
    return { code: 2, out: line('ERROR', { reason: 'io', error: { message: 'an unexpected I/O error occurred' } }) };
  }
}

module.exports = { run, KINDS, USAGE };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    process.exitCode = code;   // print, set the exit code, let the event loop drain
  });
}
