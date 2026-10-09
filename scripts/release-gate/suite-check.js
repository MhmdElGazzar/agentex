'use strict';
// Release-gate suite-membership check (skill-consolidation-foundation R9).
//
// Proves the 0.22.1 add-to-suite fix at the gate: a REAL add of at least one
// pooled test case that is NOT a member beforehand, then an INDEPENDENT
// re-read of the suite. Maintainer-only; never invoked by consumer flows.
//
//   1. Membership read via listSuiteCases (the testplan route — a different
//      endpoint from the legacy route addCaseToSuite re-reads internally).
//   2. Choose --count (default 1) pool cases that are not members. If every
//      pool case is already a member, FAIL naming them — residue of an
//      earlier failed teardown — so the idempotent skip can never mask a
//      broken add.
//   3. Write-ahead: each chosen id is recorded in the gate ledger as
//      { step: 'suite-add', kind: 'associated', type: 'suite-entry', id, planId, suiteId }
//      BEFORE the add request, so teardown owes it an association removal
//      whatever happens next.
//   4. adapter.addCaseToSuite(plan, suite, ids, { execute: true }) — the
//      0.22.1 code.
//   5. Independent re-read; any requested id missing FAILS, naming the ids.
//
// The plan, suite and pool come from the untracked gate pool file
// (.claude/release-gate/testcase-pool.json, bound like the Test Case pool);
// no plan or suite is ever created here. Teardown removes the entries.
//
// `plan` (sentinel) sends NOTHING: it returns the add descriptor
// (execute:false) and the planned re-read, and ledgers the chosen ids as
// descriptor-only / not-attempted. `run --execute` is the live check.
//
// Usage:
//   node suite-check.js plan --project <dir> --ledger <ledger.json> --plan <id> --suite <id> --pool <id,id,…> [--count n]
//   node suite-check.js run  --project <dir> --ledger <ledger.json> --plan <id> --suite <id> --pool <id,id,…> [--count n] --execute
// Output: one JSON line with `line` — the lane report's suite-membership line.
// Exit: 0 PASS (or plan) · 1 FAIL · 2 usage.
const path = require('node:path');
const gl = require('./gate-ledger.js');

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

const memberIds = (rows) => new Set((rows || []).map((e) => Number((e.workItem || e).id)));

async function runSuiteCheck({ cmd, plan, suite, pool, count = 1, execute = false, ledgerFile, adapter } = {}) {
  if (cmd !== 'plan' && cmd !== 'run') throw usageError('usage: suite-check.js <plan|run> --project <dir> --ledger <file> --plan <id> --suite <id> --pool <id,…> [--count n] [--execute]');
  if (cmd === 'run' && !execute) throw usageError('run sends a real add to the suite — pass --execute (use `plan` for the sentinel dry run)');
  if (!plan || !suite) throw usageError('--plan and --suite are required (from the gate pool\'s suite block)');
  const ids = [].concat(pool || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw usageError('--pool needs at least one test case id (from the gate pool)');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw usageError('--count must be a whole number ≥ 1');
  if (!ledgerFile) throw usageError('--ledger is required — every suite entry is ledgered before it is added');
  if (!adapter) throw usageError('no tracker adapter');
  const planId = Number(plan); const suiteId = Number(suite);
  const route = `_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase`;
  const record = (id) => gl.recordEntry(ledgerFile, {
    step: 'suite-add', describe: `add pooled test case ${id} to the gate suite (association only)`,
    kind: 'associated', type: 'suite-entry', id, planId, suiteId,
  });

  if (cmd === 'plan') {
    // Sentinel: nothing is read or sent; membership cannot be proven offline.
    const chosen = ids.slice(0, n);
    const d = await adapter.addCaseToSuite(planId, suiteId, chosen, { execute: false });
    for (const id of chosen) record(id);
    return {
      ok: true, exitCode: 0, mode: 'plan', planId, suiteId, chosen,
      plan: [
        { step: 'suite-add', describe: `${d.method} ${d.url}`, request: d },
        { step: 'membership-reread', method: 'GET', route, describe: `GET ${route} — independent re-read; every added id must be a member` },
      ],
      line: `suite-membership: PLAN — add ${chosen.length}, re-read planned; nothing sent`,
    };
  }

  const before = memberIds(await adapter.listSuiteCases(planId, suiteId));
  const candidates = ids.filter((id) => !before.has(id));
  if (!candidates.length) {
    return {
      ok: false, exitCode: 1, mode: 'run', planId, suiteId, residue: ids,
      line: `suite-membership: FAIL — every pool case is already a member (${ids.join(', ')}): residue from an earlier failed teardown; remove those associations before the gate can prove an add`,
    };
  }
  const chosen = candidates.slice(0, n);
  for (const id of chosen) record(id); // write-ahead, before the add request
  try {
    await adapter.addCaseToSuite(planId, suiteId, chosen, { execute: true });
  } catch (e) {
    return {
      ok: false, exitCode: 1, mode: 'run', planId, suiteId, chosen, error: e.message,
      line: `suite-membership: FAIL — the add of ${chosen.join(', ')} failed (ledgered; teardown removes any association that landed)`,
    };
  }
  const after = memberIds(await adapter.listSuiteCases(planId, suiteId));
  const missing = chosen.filter((id) => !after.has(id));
  if (missing.length) {
    return {
      ok: false, exitCode: 1, mode: 'run', planId, suiteId, added: chosen, missing,
      line: `suite-membership: FAIL — re-read ${chosen.length - missing.length}/${chosen.length} members; missing ${missing.join(', ')}`,
    };
  }
  return {
    ok: true, exitCode: 0, mode: 'run', planId, suiteId, added: chosen, missing: [],
    line: `suite-membership: PASS — added ${chosen.length}, re-read ${chosen.length}/${chosen.length} members, removed at teardown`,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      const [cmd, ...rest] = process.argv.slice(2);
      const flags = {};
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('--')) throw usageError(`unexpected argument ${a}`);
        if (a === '--execute') { flags.execute = true; continue; }
        if (rest[i + 1] === undefined) throw usageError(`${a} needs a value`);
        flags[a.slice(2)] = rest[++i];
      }
      if (!flags.project) throw usageError('--project <throwaway project dir> is required (the tracker config and .env live there)');
      const { createAdapter } = require(path.join(__dirname, '..', 'lib', 'tracker', 'adapters', 'ado.js'));
      const result = await runSuiteCheck({
        cmd, plan: flags.plan, suite: flags.suite,
        pool: String(flags.pool || '').split(',').map((s) => s.trim()).filter(Boolean),
        count: flags.count === undefined ? 1 : flags.count,
        execute: Boolean(flags.execute), ledgerFile: flags.ledger,
        adapter: createAdapter({ cwd: flags.project }),
      });
      console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exitCode = e.exitCode || 1;
    }
  })();
}

module.exports = { runSuiteCheck };
