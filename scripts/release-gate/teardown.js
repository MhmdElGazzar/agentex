'use strict';
// Release-gate teardown orchestrator (design: release-e2e-gate, decision 3/4).
//
// Reads the gate ledger from the throwaway project and settles every created
// entry into a terminal disposition:
//   - Test Cases are NEVER delete-attempted: ADO offers no standard
//     (recycle-bin) delete for test artifacts — they are classified
//     `undeletable-standard` and always surfaced as a waivable finding.
//   - live mode: every other created id goes through the tracker lib's
//     deleteWorkItem(id, {execute:true}) — standard delete → Recycle Bin,
//     recoverable, structurally incapable of permanent destroy. A failed
//     delete keeps the entry non-terminal (pending + reason) → gate FAIL.
//   - sentinel mode: delete descriptors are composed (execute:false, zero
//     network) where a fixture id exists and asserted destroy-free; entries
//     stay `not-attempted`, which is terminal for descriptor-only writes.
//
// Then, in this order: the ledger (+ gate log) is finalized to the surviving
// runs dir, the secret scan runs over the surviving artifacts, and ONLY THEN
// is the throwaway folder removed. On any FAIL (exit 1) the folder is KEPT as
// evidence — a failed gate must stay inspectable.
//
// Usage: node teardown.js <throwaway-dir> [--runs-dir <dir>] [--env-from <plugin-repo-root>]
// Output: one JSON line. Exit: 0 all deleted · 3 undeletable-standard present
// (waivable) · 1 any non-terminal id or scan hit (FAIL) · 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const gl = require('./gate-ledger.js');
const { scanSecrets } = require('./scan-secrets.js');
const { createAdapter } = require(path.join(__dirname, '..', 'lib', 'tracker', 'adapters', 'ado.js'));

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

const TEST_CASE_REASON =
  'ADO has no standard (recycle-bin) delete for test artifacts — left in place, ' +
  'surfaced as a waivable finding at the owner confirmation gate; never destroyed';

async function runTeardown({ dir, adapter, runsDir, envFromDir } = {}) {
  if (!dir) throw usageError('a throwaway project dir is required');
  const ledgerFile = path.join(dir, '.agentex', 'release-gate', 'ledger.json');
  if (!fs.existsSync(ledgerFile)) throw usageError(`no gate ledger at ${ledgerFile} — nothing to account for, refusing to delete anything`);
  const ledger = gl.readLedger(ledgerFile);
  const mode = ledger.mode;
  const a = adapter || createAdapter({ cwd: dir });

  for (const entry of ledger.entries.filter((e) => e.kind === 'created')) {
    if (entry.disposition === 'deleted' || entry.disposition === 'undeletable-standard') continue;
    if (entry.type === 'Test Case') {
      gl.setDisposition(ledgerFile, { step: entry.step, disposition: 'undeletable-standard', reason: TEST_CASE_REASON });
      continue;
    }
    if (mode === 'live') {
      if (entry.status === 'done' && entry.id !== undefined && entry.id !== null) {
        try {
          await a.deleteWorkItem(entry.id, { execute: true });
          gl.setDisposition(ledgerFile, { step: entry.step, disposition: 'deleted' });
        } catch (e) {
          gl.setDisposition(ledgerFile, { step: entry.step, disposition: 'pending', reason: `delete failed: ${e.message}` });
        }
      }
      // status 'failed' with no id: nothing reached the board — terminal per the check.
    } else if (entry.id !== undefined && entry.id !== null) {
      // Sentinel: prove the delete request composes, send nothing.
      const d = await a.deleteWorkItem(entry.id, { execute: false });
      if (String(d.url).toLowerCase().includes('destroy')) {
        throw new Error(`composed delete URL for id ${entry.id} contains a destroy parameter — structurally forbidden`);
      }
    }
  }

  const check = gl.checkLedger(ledgerFile);
  const { dest } = gl.finalizeLedger(ledgerFile, { runsDir });
  let scan;
  try {
    scan = scanSecrets({ targets: [dest], envFromDir });
  } catch (e) {
    scan = { ok: false, scannedFiles: 0, hits: [], error: e.message };
  }

  const exitCode = !scan.ok ? 1 : check.exitCode;
  let projectRemoved = false;
  if (exitCode !== 1) {
    fs.rmSync(dir, { recursive: true, force: true });
    projectRemoved = true;
  }
  return {
    ok: exitCode !== 1,
    exitCode,
    mode,
    check,
    survivingDir: dest,
    scan: { ok: scan.ok, scannedFiles: scan.scannedFiles, hits: scan.hits, ...(scan.error ? { error: scan.error } : {}) },
    projectRemoved,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      const argv = process.argv.slice(2);
      const dir = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null;
      const flags = {};
      for (let i = 0; i < argv.length; i += 2) {
        if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw usageError(`bad flag pair near ${argv[i]}`);
        flags[argv[i].slice(2)] = argv[i + 1];
      }
      const result = await runTeardown({ dir, runsDir: flags['runs-dir'], envFromDir: flags['env-from'] });
      console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exitCode = e.exitCode || 1;
    }
  })();
}

module.exports = { runTeardown };
