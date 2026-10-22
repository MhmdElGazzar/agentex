#!/usr/bin/env node
// qa-records.js — the QA watchlist helper (skill-consolidation-foundation R8 /
// WP-10): append, list and resolve the project's local QA records. Judgment
// (what to record, when a reply is decisive) stays in
// references/tracker/qa-records.md; this script carries the mechanics —
// file format, ids, locking, the exactly-one-line resolve, UTF-8.
//
// The four kinds are the `qaRecords` config keys:
//   pendingQuestions    a question posted to a story, awaiting a decisive reply
//   pendingRechecks     an item to re-verify after a fix or deploy
//   envIssues           an environment problem that blocked or skewed testing
//   deferredConditions  a test condition consciously deferred, with the reason
// Each kind's file path comes ONLY from getStructured(cwd, 'qaRecords')
// (scripts/lib/project_config.js), relative to the project root. By default the
// four files sit in the QA watchlist folder at the project root; a team may
// point any kind elsewhere.
//
// LAZY: nothing exists until a kind's first `append`, which creates the folder
// and that one file. `list` and `resolve` never create anything. The files are
// user decisions — commit them, never gitignore them.
//
// Format follows the configured path's extension:
//   .md     header `<!-- agentex:qa-records kind=<k> schemaVersion=1 -->`,
//           `# <title>`, a blank line (headerFor(kind)); then per entry a
//           column-0 line `- [ ] <id> · <createdAt> · <ref|—>` followed by the
//           text, EVERY text line indented two spaces (text can never forge an
//           entry line). Resolving rewrites only that first line:
//           `- [x] <id> · <createdAt> · <ref|—> · resolved <ISO>: <resolution>`.
//           --data is refused for a .md path (no structured slot there).
//   .jsonl  one object per line, no header:
//           {"schemaVersion":1,"id","kind","status":"open","createdAt","ref","text","data"}
//           Resolving replaces that one line with the same object plus
//           "status":"resolved","resolvedAt","resolution".
// Either way a resolve changes exactly ONE line; every other byte is kept.
// History is never deleted or rewritten.
//
// Usage:
//   node qa-records.js append  --kind <k> (--text "<t>" | --text-file <f>) [--ref <work item id>] [--data <json file>]
//   node qa-records.js list    [--kind <k>|all] [--status open|resolved|all] [--ref <id>] [--out <file>]
//   node qa-records.js resolve --kind <k> --id <id> (--resolution "<t>" | --resolution-file <f>)
// Defaults: list --kind all --status open. Ids: <kind-prefix>-<UTC yyyymmddHHMMss>-<4 hex>.
//
// Concurrency: every mutation holds <file>.lock (created exclusively, holding
// pid + timestamp), retried for a bounded wait (~2.5 s). A lock older than
// 60 s is broken loudly (brokeStaleLock: true); a live lock past the wait is
// exit 1 lock-busy naming the lock file. append is ONE appendFileSync under the
// lock; resolve writes <file>.tmp and renames it into place under the lock.
//
// Output: ONE JSON line; exit 0 = ok, 1 = I/O failure (incl. lock-busy),
// 2 = bad usage / unknown kind / unknown id / already resolved / config error
// (invariant 9). No process spawning, no network, zero npm dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getStructured, STRUCTURED_DEFAULTS } = require(path.join(__dirname, 'lib', 'project_config.js'));

const KINDS = Object.keys(STRUCTURED_DEFAULTS.qaRecords);
const KIND_META = {
  pendingQuestions: { prefix: 'question', title: 'QA watchlist — Awaiting answers' },
  pendingRechecks: { prefix: 'retest', title: 'QA watchlist — Awaiting retest' },
  envIssues: { prefix: 'blocker', title: 'QA watchlist — Environment blockers' },
  deferredConditions: { prefix: 'deferred', title: 'QA watchlist — Deferred conditions' },
};
const STATUSES = ['open', 'resolved', 'all'];
const SEP = ' · ';
const NO_REF = '—';
const SCHEMA_VERSION = 1;

const USAGE = 'usage: qa-records.js append --kind <k> (--text "<t>" | --text-file <f>) [--ref <id>] [--data <json file>] | ' +
  'list [--kind <k>|all] [--status open|resolved|all] [--ref <id>] [--out <file>] | ' +
  `resolve --kind <k> --id <id> (--resolution "<t>" | --resolution-file <f>) — kinds: ${KINDS.join(', ')}`;

// The Markdown header a .md record file starts with (also the shape an eager
// scaffold would use, should that ever be chosen — design assumption A-2).
function headerFor(kind) {
  if (!KIND_META[kind]) throw new Error(`unknown QA-record kind ${JSON.stringify(kind)} — the kinds are: ${KINDS.join(', ')}`);
  return `<!-- agentex:qa-records kind=${kind} schemaVersion=${SCHEMA_VERSION} -->\n# ${KIND_META[kind].title}\n\n`;
}

// ---- CLI arg parser: --key value / --key=value / --flag ----------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else out._.push(a);
  }
  return out;
}

class Refusal extends Error {
  constructor(message, { reason, code = 2 } = {}) { super(message); this.reason = reason; this.code = code; }
}
const usage = (msg) => { throw new Refusal(`${msg} ${USAGE}`, { reason: 'usage' }); };

const isJsonl = (rel) => rel.toLowerCase().endsWith('.jsonl');
const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
const singleLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
const normalizeText = (s) => String(s).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');

// --x "<t>" | --x-file <f> -> the text, or a usage refusal.
function textArg(args, cwd, name, required) {
  const inline = args[name]; const file = args[`${name}-file`];
  if (inline === undefined && file === undefined) {
    if (required) usage(`--${name} or --${name}-file is required.`);
    return null;
  }
  if (inline !== undefined && file !== undefined) usage(`pass --${name} or --${name}-file, not both.`);
  if (inline === true || file === true) usage(`--${inline === true ? name : `${name}-file`} needs a value.`);
  let text;
  if (inline !== undefined) text = String(inline);
  else {
    try { text = fs.readFileSync(path.resolve(cwd, String(file)), 'utf8'); }
    catch (e) { usage(`could not read --${name}-file: ${e.message}.`); }
  }
  text = normalizeText(text);
  if (text.trim() === '') usage(`--${name} is empty.`);
  return text;
}

function kindArg(args, { allowAll } = {}) {
  const k = args.kind;
  if (k === undefined) {
    if (allowAll) return 'all';
    usage('--kind is required.');
  }
  if (allowAll && k === 'all') return 'all';
  if (!KINDS.includes(k)) {
    throw new Refusal(`unknown kind ${JSON.stringify(k === true ? '' : k)} — the kinds are: ${KINDS.join(', ')}${allowAll ? ', all' : ''}. ${USAGE}`, { reason: 'unknown-kind' });
  }
  return k;
}

// A work-item reference: one token (an id or key), no whitespace, no separator.
function refArg(args) {
  if (args.ref === undefined) return null;
  const r = String(args.ref);
  if (args.ref === true || !/^[^\s·]+$/.test(r) || r === NO_REF) usage(`--ref must be one work item id or key (got ${JSON.stringify(args.ref === true ? '' : r)}).`);
  return r;
}

// ---- parsing a record file ----------------------------------------------------
// Lines with their endings kept, so a resolve can rewrite one line in place.
function splitLines(text) {
  const out = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '' && m.index >= text.length) break;
    out.push({ start: m.index, content: m[1], eol: m[2] });
    if (m[2] === '') break;
  }
  return out;
}

const MD_ENTRY = /^- \[( |x)\] (\S+) · (\S+) · (\S+)(?: · resolved (\S+): (.*))?$/;

function parseMd(text, kind, file) {
  const entries = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    while (cur.textLines.length && cur.textLines[cur.textLines.length - 1] === '') cur.textLines.pop();
    const e = { kind, id: cur.id, status: cur.status, createdAt: cur.createdAt, ref: cur.ref, text: cur.textLines.join('\n') };
    if (cur.status === 'resolved') { e.resolvedAt = cur.resolvedAt; e.resolution = cur.resolution; }
    e.file = file;
    entries.push(Object.assign(e, { _line: cur.line }));
    cur = null;
  };
  for (const line of splitLines(text)) {
    const m = MD_ENTRY.exec(line.content);
    if (m) {
      close();
      cur = {
        line, id: m[2], status: m[1] === 'x' ? 'resolved' : 'open', createdAt: m[3],
        ref: m[4] === NO_REF ? null : m[4], resolvedAt: m[5], resolution: m[6], textLines: [],
      };
    } else if (cur && line.content.startsWith('  ')) cur.textLines.push(line.content.slice(2));
    else if (cur && line.content === '') cur.textLines.push('');
    else close();
  }
  close();
  return entries;
}

function parseJsonl(text, kind, file) {
  const entries = [];
  splitLines(text).forEach((line, i) => {
    if (line.content.trim() === '') return;
    let obj;
    try { obj = JSON.parse(line.content); } catch (e) {
      throw new Refusal(`${file}:${i + 1} is not a JSON line (${e.message}) — fix or remove that line by hand.`, { reason: 'unreadable-record', code: 1 });
    }
    entries.push(Object.assign({ ...obj, file }, { _line: line }));
  });
  return entries;
}

function readEntries(cwd, kind, rel) {
  const abs = path.join(cwd, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '', entries: [] };
    throw new Refusal(`could not read ${rel}: ${e.message}`, { reason: 'io', code: 1 });
  }
  return { exists: true, text, entries: isJsonl(rel) ? parseJsonl(text, kind, rel) : parseMd(text, kind, rel) };
}
const publicEntry = (e) => { const { _line, ...rest } = e; return rest; };

// ---- the lock -------------------------------------------------------------------
async function withLock(absFile, rel, o, fn) {
  const lock = `${absFile}.lock`;
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + o.lockWaitMs;
  let brokeStaleLock = false;
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: o.now().toISOString(), token }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new Refusal(`could not create the lock ${rel}.lock: ${e.message}`, { reason: 'io', code: 1 });
    }
    // Held by someone: stale (older than staleLockMs) -> break it loudly; live -> wait.
    let age = 0;
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      const at = Date.parse(held.at);
      age = Number.isNaN(at) ? o.now().getTime() - fs.statSync(lock).mtimeMs : o.now().getTime() - at;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // released between our attempt and the read
      try { age = o.now().getTime() - fs.statSync(lock).mtimeMs; } catch { continue; }
    }
    if (age > o.staleLockMs) {
      try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw new Refusal(`could not break the stale lock ${rel}.lock: ${e.message}`, { reason: 'io', code: 1 }); }
      brokeStaleLock = true;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Refusal(`${rel}.lock is held by another run (waited ${o.lockWaitMs} ms) — retry when it finishes; if no run is active, the lock is broken automatically once it is older than ${Math.round(o.staleLockMs / 1000)} s.`, { reason: 'lock-busy', code: 1 });
    }
    await o.sleep(o.lockRetryMs);
  }
  try {
    const out = await fn();
    return brokeStaleLock ? { ...out, brokeStaleLock: true } : out;
  } finally {
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (held.token === token) fs.unlinkSync(lock);
    } catch { /* already gone */ }
  }
}

// ---- subcommands ----------------------------------------------------------------
async function append(args, o) {
  const kind = kindArg(args);
  const text = textArg(args, o.cwd, 'text', true);
  const ref = refArg(args);
  const rel = getStructured(o.cwd, 'qaRecords')[kind];
  let data = null;
  if (args.data !== undefined) {
    if (args.data === true) usage('--data needs a JSON file path.');
    if (!isJsonl(rel)) {
      throw new Refusal(`--data needs a .jsonl record file; ${kind} is ${rel} (Markdown has no structured slot) — put the details in the text, or point qaRecords.${kind} at a .jsonl path.`, { reason: 'data-needs-jsonl' });
    }
    try { data = JSON.parse(fs.readFileSync(path.resolve(o.cwd, String(args.data)), 'utf8')); }
    catch (e) { usage(`could not read --data as JSON: ${e.message}.`); }
  }
  const abs = path.join(o.cwd, rel);
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); }
  catch (e) { throw new Refusal(`could not create the folder for ${rel}: ${e.message}`, { reason: 'io', code: 1 }); }
  return withLock(abs, rel, o, async () => {
    const cur = readEntries(o.cwd, kind, rel);
    const taken = new Set(cur.entries.map((e) => e.id));
    const now = o.now();
    let id;
    for (let i = 0; i < 16 && (!id || taken.has(id)); i++) id = `${KIND_META[kind].prefix}-${stamp(now)}-${String(o.randomHex()).toLowerCase()}`;
    if (taken.has(id)) throw new Refusal(`could not draw a fresh id for ${rel} — retry`, { reason: 'io', code: 1 });
    const createdAt = now.toISOString();
    let chunk;
    if (isJsonl(rel)) {
      chunk = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, id, kind, status: 'open', createdAt, ref, text, data })}\n`;
    } else {
      chunk = `- [ ] ${id}${SEP}${createdAt}${SEP}${ref === null ? NO_REF : ref}\n${text.split('\n').map((l) => `  ${l}\n`).join('')}`;
      if (cur.text === '') chunk = headerFor(kind) + chunk;
    }
    if (cur.text !== '' && !/[\r\n]$/.test(cur.text)) chunk = `\n${chunk}`; // never merge into a last line
    try { fs.appendFileSync(abs, chunk, 'utf8'); }
    catch (e) { throw new Refusal(`could not append to ${rel}: ${e.message}`, { reason: 'io', code: 1 }); }
    return { ok: true, kind, file: rel, id, createdAt, created: !cur.exists };
  });
}

async function list(args, o) {
  const kind = kindArg(args, { allowAll: true });
  const status = args.status === undefined ? 'open' : args.status;
  if (!STATUSES.includes(status)) usage(`--status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(status === true ? '' : status)}).`);
  const ref = refArg(args);
  if (args.out === true) usage('--out needs a file path.');
  const paths = getStructured(o.cwd, 'qaRecords');
  const kinds = kind === 'all' ? KINDS : [kind];
  const entries = [];
  for (const k of kinds) {
    for (const e of readEntries(o.cwd, k, paths[k]).entries) {
      if (status !== 'all' && e.status !== status) continue;
      if (ref !== null && e.ref !== ref) continue;
      entries.push(publicEntry(e));
    }
  }
  const payload = { ok: true, kind, status, ...(ref !== null ? { ref } : {}), count: entries.length, entries };
  if (args.out === undefined) return payload;
  const abs = path.resolve(o.cwd, String(args.out));
  const body = JSON.stringify(payload, null, 2);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(`${abs}.tmp`, body, 'utf8');
    fs.renameSync(`${abs}.tmp`, abs);
  } catch (e) { throw new Refusal(`could not write --out ${abs}: ${e.message}`, { reason: 'io', code: 1 }); }
  return { ok: true, out: abs, bytes: Buffer.byteLength(body, 'utf8'), count: entries.length };
}

async function resolve(args, o) {
  const kind = kindArg(args);
  if (args.id === undefined || args.id === true) usage('--id is required.');
  const id = String(args.id);
  const resolution = textArg(args, o.cwd, 'resolution', true);
  const rel = getStructured(o.cwd, 'qaRecords')[kind];
  const abs = path.join(o.cwd, rel);
  const unknown = () => new Refusal(`no ${kind} entry with id ${id} in ${rel}.`, { reason: 'unknown-id' });
  if (!fs.existsSync(abs)) throw unknown(); // never create anything on a resolve
  return withLock(abs, rel, o, async () => {
    const cur = readEntries(o.cwd, kind, rel);
    const e = cur.entries.find((x) => x.id === id);
    if (!e) throw unknown();
    if (e.status === 'resolved') {
      throw new Refusal(`${kind} entry ${id} is already resolved (${e.resolvedAt}) — history is never rewritten.`, { reason: 'already-resolved' });
    }
    const resolvedAt = o.now().toISOString();
    let replacement;
    if (isJsonl(rel)) {
      const { _line, file, ...obj } = e;
      replacement = JSON.stringify({ ...obj, status: 'resolved', resolvedAt, resolution });
    } else {
      replacement = `- [x] ${e.id}${SEP}${e.createdAt}${SEP}${e.ref === null ? NO_REF : e.ref}${SEP}resolved ${resolvedAt}: ${singleLine(resolution)}`;
    }
    const { start, content } = e._line;
    const next = cur.text.slice(0, start) + replacement + cur.text.slice(start + content.length);
    try {
      fs.writeFileSync(`${abs}.tmp`, next, 'utf8');
      fs.renameSync(`${abs}.tmp`, abs);
    } catch (err) { throw new Refusal(`could not rewrite ${rel}: ${err.message}`, { reason: 'io', code: 1 }); }
    return { ok: true, kind, file: rel, id, status: 'resolved', resolvedAt };
  });
}

// run(argv, { cwd, now, randomHex, sleep, lockWaitMs, lockRetryMs, staleLockMs }):
// the seams are for tests; the CLI passes none of them.
async function run(argv, opts = {}) {
  const o = {
    cwd: process.cwd(),
    now: () => new Date(),
    randomHex: () => crypto.randomBytes(2).toString('hex'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    lockWaitMs: 2500,
    lockRetryMs: 50,
    staleLockMs: 60_000,
    ...opts,
  };
  const args = parseArgs(argv);
  const sub = args._[0];
  try {
    if (sub === 'append') return { code: 0, out: await append(args, o) };
    if (sub === 'list') return { code: 0, out: await list(args, o) };
    if (sub === 'resolve') return { code: 0, out: await resolve(args, o) };
    return { code: 2, out: { ok: false, reason: 'usage', error: { message: USAGE } } };
  } catch (e) {
    if (e instanceof Refusal) return { code: e.code, out: { ok: false, reason: e.reason, error: { message: e.message } } };
    if (e && e.name === 'ConfigError') return { code: 2, out: { ok: false, reason: 'config', error: { message: e.message } } };
    return { code: 1, out: { ok: false, reason: 'io', error: { message: e && e.message ? e.message : String(e) } } };
  }
}

module.exports = { run, headerFor, KINDS, USAGE };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // Print, set the exit code, and let the event loop drain (never force-exit).
    process.exitCode = code;
  });
}
