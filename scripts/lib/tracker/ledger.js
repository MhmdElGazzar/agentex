'use strict';
// WritePlan — the tracker layer's per-write ledger (invariant 4 in code form).
//
// Consumers declare EVERY intended board write up front as an intent
// {step, describe, run}, then call execute(). Intents run sequentially in the
// declared order; the FIRST failure stops the plan — no retries, no cleanup
// writes, ever ("callers decide what a partial write means; nothing is
// auto-retried" — pattern credit: plugin PR #16's ledger messages).
//
// execute() never throws: its return value is the exact ledger the user is owed —
// one entry per intended write, {step, describe, status: 'done'|'failed'|
// 'not-attempted', id?, url?, reason?}. IDs and URLs captured by completed steps
// are in the ledger regardless of a later throw, so a partial failure can always
// name what now exists on the board (the structural fix for the old create-bug.js
// printing BUG_ID= only after the last step).
class WritePlan {
  // intents: [{step: string, describe: string, run: async () => ({id?, url?})}]
  constructor(intents) {
    if (!Array.isArray(intents)) throw new Error('WritePlan expects an array of intents');
    for (const it of intents) {
      if (!it || typeof it.step !== 'string' || typeof it.describe !== 'string' || typeof it.run !== 'function') {
        throw new Error('each intent needs {step, describe, run}');
      }
    }
    this.intents = intents;
  }

  // The write plan as data (for the consolidated pre-approval screen) — runs nothing.
  plan() {
    return this.intents.map((i) => ({ step: i.step, describe: i.describe }));
  }

  // Run the plan. Stops at the first failure; later intents stay 'not-attempted'.
  async execute() {
    const ledger = this.intents.map((i) => ({ step: i.step, describe: i.describe, status: 'not-attempted' }));
    for (let i = 0; i < this.intents.length; i++) {
      const entry = ledger[i];
      try {
        const res = (await this.intents[i].run()) || {};
        entry.status = 'done';
        if (res.id !== undefined && res.id !== null) entry.id = res.id;
        if (res.url !== undefined && res.url !== null) entry.url = res.url;
      } catch (e) {
        entry.status = 'failed';
        entry.reason = e && e.message ? e.message : String(e);
        break; // fail closed: no retry, no cleanup, nothing after the failure
      }
    }
    return ledger;
  }
}

module.exports = { WritePlan };
