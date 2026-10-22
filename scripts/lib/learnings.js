'use strict';
// AgenTeX plugin-learnings file — the grammar, the append under a lock, the one-line
// absorbed mark (field-feedback-loop S-1; spec appendix A1).
//
//   <project>/.agentex/plugin-learnings.md   committed, created lazily by the first append
//
//   <!-- agentex:plugin-learnings schemaVersion=1 -->
//   - [ ] PL-<UTC yyyymmddTHHMMSSZ>-<4 hex> · <YYYY-MM-DD> · <trigger> · <affected> · v<version>
//     problem: …            (two-space indent; continuation lines take four)
//     workaround: …
//   - [x] … · v<version> · absorbed in v<x.y.z>
//
// Entries are only ever appended. Marking one absorbed replaces exactly its entry line;
// every other byte stays identical. Parsing works on the file's BYTES read as latin1, so
// offsets are byte offsets: a BOM, invalid UTF-8 or CRLF survive any rewrite. Field text
// is decoded back to UTF-8 when it is read out.
//
// The lock is a copy of scripts/qa-records.js's routine (B4: that script exports none):
// `wx`, ~2.5 s wait, a lock older than 60 s is broken loudly. It lives in ignored scratch.
// No process spawning, no network, zero npm dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const FILE_REL = '.agentex/plugin-learnings.md';
const LOCK_REL = '.agentex/scratch/field-feedback/.locks/plugin-learnings.lock';
const TRIGGERS = ['workaround', 'repeated-correction', 'self-written-script', 'forked-skill'];
const MODES = ['sequential', 'parallel', 'ci'];
const FIELD_ORDER = ['problem', 'workaround', 'mode', 'session', 'script', 'fork', 'rule'];
const REQUIRED = ['problem', 'workaround'];
const SINGLE_LINE = ['mode', 'session', 'script', 'fork', 'rule'];
const TRUNCATED = '…[truncated]';
const LIMITS = { field: 2000, entryBytes: 8192 };   // tunable defaults (Q8)
const SEP = ' · ';

class Refusal extends Error {
  constructor(message, { reason, code = 2 } = {}) { super(message); this.reason = reason; this.code = code; }
}

const HEADER_LINES = [
  `<!-- agentex:plugin-learnings schemaVersion=${SCHEMA_VERSION} -->`,
  '# AgenTeX plugin learnings',
  '',
  'Gaps in the AgenTeX plugin that were worked around in this project, recorded by the agent.',
  'Entries are only ever appended; you may edit or delete them. `/update-agentex` proposes',
  'marking entries the installed plugin now covers. Nothing here leaves this machine unless you',
  'export it (`/update-agentex feedback`) and send it yourself.',
  '',
];
const headerText = (eol = '\n') => HEADER_LINES.join(eol) + eol;

// ---- parsing ------------------------------------------------------------------------------
// The file as a latin1 string: one char per byte. ASCII-only structure matches as usual;
// the one non-ASCII separator is spelled the same way.
const latin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');
const decode = (s) => Buffer.from(s, 'latin1').toString('utf8');
const SEP_L = latin1(SEP);
const HEADER_RE = /^<!-- agentex:plugin-learnings schemaVersion=(\d+) -->$/;
const ENTRY_RE = new RegExp(`^- \\[( |x)\\] (\\S+)${SEP_L}(\\d{4}-\\d{2}-\\d{2})${SEP_L}(\\S+)${SEP_L}(\\S+)${SEP_L}v(\\S+?)(?:${SEP_L}absorbed in v(\\S+))?$`);
const FIELD_RE = /^ {2}([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/;
const BOM_L = latin1('\uFEFF');

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

const lineShaOf = (decodedLine) => crypto.createHash('sha256').update(decodedLine, 'utf8').digest('hex').slice(0, 16);

// parse(Buffer|string) -> { schemaVersion, hasHeader, entries, unparsed, eol }
//   entry: { id, date, trigger, affected, version, status:'open'|'absorbed', absorbedIn,
//            fields:{problem,workaround,…}, lineStart, lineEnd (byte offsets), lineText, lineSha }
// `unparsed` counts column-0 non-blank lines after the first entry that are not entry
// lines (a hand-typed note, a malformed entry line); they are never touched.
function parse(input) {
  const text = Buffer.isBuffer(input) ? input.toString('latin1') : latin1(String(input));
  const lines = splitLines(text);
  let schemaVersion = SCHEMA_VERSION; let hasHeader = false;
  const first = lines.find((l) => l.content.replace(BOM_L, '').trim() !== '');
  if (first) {
    const h = HEADER_RE.exec(first.content.replace(BOM_L, '').trim());
    if (h) { hasHeader = true; schemaVersion = parseInt(h[1], 10); }
  }
  const eol = lines.length && lines[0].eol ? lines[0].eol : '\n';
  const entries = []; let unparsed = 0; let cur = null; let field = null;
  const close = () => { cur = null; field = null; };
  for (const line of lines) {
    const m = ENTRY_RE.exec(line.content);
    if (m) {
      const lineText = decode(line.content);
      cur = {
        id: m[2], date: m[3], trigger: m[4], affected: m[5], version: m[6],
        status: m[1] === 'x' ? 'absorbed' : 'open', absorbedIn: m[7] || null,
        fields: {}, lineStart: line.start, lineEnd: line.start + line.content.length, lineText, lineSha: lineShaOf(lineText),
      };
      entries.push(cur); field = null;
      continue;
    }
    if (line.content === '') continue;
    if (line.content[0] !== ' ') {
      if (entries.length) unparsed++;
      close();
      continue;
    }
    if (!cur) continue;
    if (/^ {4}/.test(line.content)) {
      if (field !== null) cur.fields[field] += `\n${decode(line.content.slice(4))}`;
      continue;
    }
    const f = FIELD_RE.exec(line.content);
    if (f) { field = f[1]; cur.fields[field] = decode(f[2] || ''); } else field = null; // an unknown indented line: kept in the file, ignored here
  }
  return { schemaVersion, hasHeader, entries, unparsed, eol };
}

// ---- values, rendering ----------------------------------------------------------------------
function cut(s, max) {
  if (s.length <= max) return s;
  let t = s.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return t + TRUNCATED;
}
function cleanValue(v, key) {
  let s = String(v === undefined || v === null ? '' : v).replace(/^\uFEFF/, '')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\t/g, '  ');
  s = s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  if (SINGLE_LINE.includes(key)) s = s.replace(/\s*\n\s*/g, ' ');
  return cut(s, LIMITS.field);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function newId(now, randomHex) {
  const d = now;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `PL-${stamp}-${String(randomHex()).toLowerCase()}`;
}

function entryLine({ id, date, trigger, affected, version }) {
  return `- [ ] ${id}${SEP}${date}${SEP}${trigger}${SEP}${affected}${SEP}v${version}`;
}
function fieldLines(key, value) {
  const [first, ...rest] = value.split('\n');
  return [`  ${key}: ${first}`, ...rest.map((l) => `    ${l}`)];
}
function renderEntry(e, eol = '\n') {
  const out = [entryLine(e)];
  for (const key of FIELD_ORDER) if (e.fields[key] !== undefined) out.push(...fieldLines(key, e.fields[key]));
  return out.map((l) => l + eol).join('');
}

// Clean every field; refuse an empty required one; shrink the longest fields until the
// whole entry fits the per-entry cap.
function prepareFields(raw) {
  const fields = {};
  for (const key of FIELD_ORDER) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const v = cleanValue(raw[key], key);
    if (v !== '') fields[key] = v;
  }
  for (const key of REQUIRED) {
    if (fields[key] === undefined) throw new Refusal(`the learning needs a non-empty ${key}.`, { reason: 'usage' });
  }
  return fields;
}
function fit(meta, fields) {
  for (let guard = 0; guard < 200; guard++) {
    const size = Buffer.byteLength(renderEntry({ ...meta, fields }, '\n'), 'utf8');
    if (size <= LIMITS.entryBytes) return fields;
    const longest = Object.keys(fields).sort((a, b) => fields[b].length - fields[a].length)[0];
    const whole = fields[longest];
    const body = whole.endsWith(TRUNCATED) ? whole.slice(0, -TRUNCATED.length) : whole;
    const next = Math.max(16, body.length - Math.max(16, Math.ceil((size - LIMITS.entryBytes) / 2)));
    fields = { ...fields, [longest]: cut(body.slice(0, next + 1), next) };
  }
  throw new Refusal('the learning does not fit the entry size limit.', { reason: 'usage' });
}

// ---- the lock (a copy of qa-records' routine, B4) -------------------------------------------------
async function withLock(cwd, o, fn) {
  const lock = path.join(cwd, LOCK_REL);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); }
  catch (e) { throw new Refusal(`could not create the lock folder: ${e.message}`, { reason: 'io', code: 1 }); }
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + o.lockWaitMs;
  let brokeStaleLock = false;
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: o.now().toISOString(), token }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new Refusal(`could not create the lock: ${e.message}`, { reason: 'io', code: 1 });
    }
    let age = 0;
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      const at = Date.parse(held.at);
      age = Number.isNaN(at) ? o.now().getTime() - fs.statSync(lock).mtimeMs : o.now().getTime() - at;
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      try { age = o.now().getTime() - fs.statSync(lock).mtimeMs; } catch { continue; }
    }
    if (age > o.staleLockMs) {
      try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw new Refusal(`could not break the stale lock: ${e.message}`, { reason: 'io', code: 1 }); }
      brokeStaleLock = true;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Refusal(`the learnings lock is held by another run (waited ${o.lockWaitMs} ms) — retry when it finishes; if no run is active it is broken automatically once older than ${Math.round(o.staleLockMs / 1000)} s.`, { reason: 'lock-busy', code: 1 });
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

function withDefaults(opts = {}) {
  return {
    now: () => new Date(),
    randomHex: () => crypto.randomBytes(2).toString('hex'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    lockWaitMs: 2500,
    lockRetryMs: 50,
    staleLockMs: 60_000,
    ...opts,
  };
}

function readLearnings(cwd) {
  const abs = path.join(cwd, FILE_REL);
  try {
    const buf = fs.readFileSync(abs);
    return { exists: true, abs, buf, parsed: parse(buf) };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, abs, buf: Buffer.alloc(0), parsed: parse('') };
    throw new Refusal(`could not read ${FILE_REL}: ${e.message}`, { reason: 'io', code: 1 });
  }
}

function refuseNewer(parsed) {
  if (parsed.schemaVersion > SCHEMA_VERSION) {
    throw new Refusal(`${FILE_REL} is schemaVersion ${parsed.schemaVersion}; this AgenTeX writes ${SCHEMA_VERSION} — update the plugin first.`, { reason: 'newer-schema' });
  }
}

// appendEntry(cwd, { trigger, affected, version, fields }, opts) -> { id, file, created, [brokeStaleLock] }
// ONE appendFileSync under the lock; the header goes in with `wx` only when the file is absent.
async function appendEntry(cwd, e, opts) {
  const o = withDefaults(opts);
  const fields = prepareFields(e.fields || {});
  const abs = path.join(cwd, FILE_REL);
  return withLock(cwd, o, async () => {
    const cur = readLearnings(cwd);
    refuseNewer(cur.parsed);
    const taken = new Set(cur.parsed.entries.map((x) => x.id));
    const now = o.now();
    let id;
    for (let i = 0; i < 16 && (!id || taken.has(id)); i++) id = newId(now, o.randomHex);
    if (taken.has(id)) throw new Refusal('could not draw a fresh id — retry', { reason: 'io', code: 1 });
    const meta = { id, date: now.toISOString().slice(0, 10), trigger: e.trigger, affected: e.affected, version: e.version };
    const sized = fit(meta, fields);
    let created = false;
    let eol = cur.parsed.eol;
    try {
      if (!cur.exists) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        try { fs.writeFileSync(abs, headerText('\n'), { flag: 'wx' }); created = true; eol = '\n'; }
        catch (err) { if (err.code !== 'EEXIST') throw err; }
      }
      let chunk = renderEntry({ ...meta, fields: sized }, eol);
      const last = cur.buf.length ? cur.buf[cur.buf.length - 1] : 0x0a;
      if (cur.exists && last !== 0x0a && last !== 0x0d) chunk = eol + chunk; // never merge into a last line
      fs.appendFileSync(abs, chunk, 'utf8');
    } catch (err) {
      if (err instanceof Refusal) throw err;
      throw new Refusal(`could not write ${FILE_REL}: ${err.message}`, { reason: 'io', code: 1 });
    }
    const back = readLearnings(cwd).parsed.entries.find((x) => x.id === id);
    if (!back || back.fields.problem !== sized.problem || back.fields.workaround !== sized.workaround) {
      throw new Refusal(`the new entry did not read back from ${FILE_REL}.`, { reason: 'verify-failed', code: 1 });
    }
    return { id, file: FILE_REL, created };
  });
}

// markAbsorbed(Buffer, [{id, version}]) -> Buffer. Pure. Replaces exactly each entry line.
function markAbsorbed(buf, targets) {
  const text = buf.toString('latin1');
  const entries = parse(buf).entries;
  const edits = [];
  for (const t of targets) {
    const e = entries.find((x) => x.id === t.id);
    if (!e) throw new Refusal(`no learning with id ${t.id}.`, { reason: 'unknown-id' });
    if (e.status !== 'open') throw new Refusal(`learning ${t.id} is already absorbed.`, { reason: 'already-absorbed' });
    const line = text.slice(e.lineStart, e.lineEnd);
    edits.push({ start: e.lineStart, end: e.lineEnd, text: line.replace('- [ ] ', '- [x] ') + latin1(`${SEP}absorbed in v${t.version}`) });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const ed of edits) out = out.slice(0, ed.start) + ed.text + out.slice(ed.end);
  return Buffer.from(out, 'latin1');
}

module.exports = {
  SCHEMA_VERSION, FILE_REL, LOCK_REL, TRIGGERS, MODES, LIMITS, SEP, Refusal,
  headerText, parse, renderEntry, newId, appendEntry, markAbsorbed, readLearnings, withLock, withDefaults, cleanValue,
  refuseNewer, lineShaOf,
};
