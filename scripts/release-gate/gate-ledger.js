'use strict';
// Release-gate teardown ledger — the gate's audit trail of everything it created
// on the tracker and what happened to it (design: release-e2e-gate, decision 4).
//
// Format (JSON, WritePlan-compatible entry shape plus kind/type/disposition):
//   { run: "<ISO timestamp>", mode: "live"|"sentinel", entries: [
//       { step, describe, kind: "created", type, id?, status, disposition, reason? } ] }
//
// status: 'done' | 'failed' | 'not-attempted' (WritePlan) plus 'descriptor-only'
// for sentinel-mode writes that stopped at the execute:false descriptor — chosen
// over "done + not-attempted" so an entry is self-describing: nothing with
// status 'descriptor-only' ever existed on the board, so no deletion is owed.
// disposition: 'deleted' | 'undeletable-standard' | 'pending' | 'not-attempted'.
//
// TERMINAL-DISPOSITION RULE (decision 4): every kind:'created' entry must end
// 'deleted' or 'undeletable-standard' — except entries that never put anything
// on the board ('descriptor-only', or 'failed' with no id), whose
// 'not-attempted' is terminal. 'undeletable-standard' is always surfaced as a
// waivable finding (exit 3), never silent. Anything else non-terminal = FAIL.
//
// NEVER-NAME RULE: every stored entry is stripped of url fields, however deep —
// ADO URLs embed the org name. IDs and work-item types only.
//
// Exit codes (check): 0 all terminal, none undeletable · 3 terminal but
// undeletable-standard present (waivable) · 1 any non-terminal (FAIL) · 2 usage.
const fs = require('node:fs');
const path = require('node:path');

// Deep-strip every field named url (any casing) — never-name rule.
function sanitizeEntry(value) {
  if (Array.isArray(value)) return value.map(sanitizeEntry);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === 'url') continue;
      out[k] = sanitizeEntry(v);
    }
    return out;
  }
  return value;
}

function readLedger(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeLedger(file, ledger) {
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

function openLedger(file, mode) {
  if (mode !== 'live' && mode !== 'sentinel') throw usageError(`mode must be live or sentinel (got ${JSON.stringify(mode)})`);
  if (fs.existsSync(file)) throw usageError(`ledger already exists at ${file} — refusing to overwrite an audit trail`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ledger = { run: new Date().toISOString(), mode, entries: [] };
  writeLedger(file, ledger);
  return ledger;
}

// Append one entry. Defaults follow the ledger's mode: live → status 'done' +
// disposition 'pending' (a deletion is owed); sentinel → 'descriptor-only' +
// 'not-attempted' (nothing reached the board).
function recordEntry(file, entry) {
  const ledger = readLedger(file);
  if (!entry || typeof entry.step !== 'string' || typeof entry.describe !== 'string') {
    throw usageError('an entry needs at least {step, describe}');
  }
  const sentinel = ledger.mode === 'sentinel';
  const e = sanitizeEntry({
    kind: 'created',
    status: sentinel ? 'descriptor-only' : 'done',
    disposition: sentinel ? 'not-attempted' : 'pending',
    ...entry,
  });
  if (e.id !== undefined && e.id !== null && String(e.id).trim() !== '' && !Number.isNaN(Number(e.id))) e.id = Number(e.id);
  // Stable field order for human diffing of surviving ledgers.
  const ordered = { step: e.step, describe: e.describe, kind: e.kind };
  for (const k of ['type', 'id', 'status', 'disposition', 'reason']) if (e[k] !== undefined) ordered[k] = e[k];
  for (const k of Object.keys(e)) if (!(k in ordered)) ordered[k] = e[k];
  ledger.entries.push(ordered);
  writeLedger(file, ledger);
  return ordered;
}

// Set the (usually terminal) disposition of one entry, addressed by id or step.
function setDisposition(file, { id, step, disposition, reason }) {
  const allowed = ['deleted', 'undeletable-standard', 'pending', 'not-attempted'];
  if (!allowed.includes(disposition)) throw usageError(`disposition must be one of ${allowed.join('|')}`);
  const ledger = readLedger(file);
  const entry = ledger.entries.find((e) =>
    (id !== undefined && id !== null && e.id === Number(id)) || (step !== undefined && e.step === step));
  if (!entry) throw usageError(`no ledger entry matches ${id !== undefined && id !== null ? `id ${id}` : `step ${step}`}`);
  entry.disposition = disposition;
  if (reason !== undefined) entry.reason = reason;
  writeLedger(file, ledger);
  return entry;
}

// Is this created entry allowed to rest where it is? (terminal-disposition rule)
function isTerminal(entry) {
  if (entry.disposition === 'deleted' || entry.disposition === 'undeletable-standard') return true;
  // Nothing ever reached the board — no deletion owed:
  if (entry.status === 'descriptor-only' && entry.disposition === 'not-attempted') return true;
  if (entry.status === 'failed' && (entry.id === undefined || entry.id === null)) return true;
  return false;
}

function checkLedger(ledgerOrFile) {
  const ledger = typeof ledgerOrFile === 'string' ? readLedger(ledgerOrFile) : ledgerOrFile;
  const created = ledger.entries.filter((e) => e.kind === 'created');
  const nonTerminal = created.filter((e) => !isTerminal(e))
    .map((e) => ({ step: e.step, type: e.type, id: e.id, status: e.status, disposition: e.disposition }));
  const undeletableStandard = created.filter((e) => e.disposition === 'undeletable-standard')
    .map((e) => ({ step: e.step, type: e.type, id: e.id }));
  const exitCode = nonTerminal.length ? 1 : (undeletableStandard.length ? 3 : 0);
  return {
    ok: exitCode !== 1,
    exitCode,
    mode: ledger.mode,
    created: created.length,
    deleted: created.filter((e) => e.disposition === 'deleted').length,
    undeletableStandard,
    nonTerminal,
  };
}

// The surviving home for run artifacts — under the PLUGIN REPO root (resolved
// at runtime from this file's location: scripts/release-gate/ → repo root),
// in the untracked .claude/ dev area. Never committed.
function defaultRunsDir() {
  return path.join(path.resolve(__dirname, '..', '..'), '.claude', 'release-gate', 'runs');
}

// Copy the ledger's whole directory (ledger.json + gate log + any evidence the
// persona parked beside it) to <runsDir>/<ts>/ BEFORE the throwaway project is
// deleted — the owner's confirmation gate reads the ledger from there.
function finalizeLedger(file, { runsDir } = {}) {
  const ledger = readLedger(file); // validates the file parses
  const ts = String(ledger.run).replace(/:/g, '-'); // Windows-safe dir name
  const dest = path.join(runsDir || defaultRunsDir(), ts);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.dirname(file), dest, { recursive: true });
  return { dest, copied: fs.readdirSync(dest) };
}

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// node gate-ledger.js open <ledger> --mode live|sentinel
// node gate-ledger.js record <ledger> --step s --describe d [--type t] [--id n] [--status s] [--disposition d] [--reason r]
// node gate-ledger.js disposition <ledger> (--id n | --step s) --disposition d [--reason r]
// node gate-ledger.js check <ledger>
// node gate-ledger.js finalize <ledger> [--runs-dir dir]
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw usageError(`bad flag pair near ${argv[i]}`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) throw usageError('usage: gate-ledger.js <open|record|disposition|check|finalize> <ledger-path> [flags]');
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'open':
      return { ok: true, opened: file, mode: openLedger(file, flags.mode).mode };
    case 'record':
      return { ok: true, recorded: recordEntry(file, flags) };
    case 'disposition':
      return { ok: true, entry: setDisposition(file, flags) };
    case 'check':
      return checkLedger(file);
    case 'finalize':
      return { ok: true, ...finalizeLedger(file, { runsDir: flags['runs-dir'] }) };
    default:
      throw usageError(`unknown command "${cmd}"`);
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = {
  openLedger, readLedger, recordEntry, setDisposition, checkLedger, finalizeLedger,
  defaultRunsDir, sanitizeEntry,
};
