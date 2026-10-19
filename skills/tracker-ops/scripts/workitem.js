#!/usr/bin/env node
// workitem.js — the tracker-ops skill's ad-hoc work-item surface (design WP-6 /
// F-1, option A): show / search / create / update / transition / comment / link
// on WHICHEVER tracker the project configures (azure or jira block — resolved
// by scripts/lib/tracker/, never per-run). Everything goes through the tracker
// layer's REST adapters over Node's built-in fetch — no az, no acli, no
// process spawning, zero npm dependencies.
//
// ONE GATE (invariant 4): every write subcommand is a DRY RUN by default — it
// returns the exact request plan and writes nothing; `--execute` performs it,
// and the skill puts that flag behind ONE user approval per write batch.
// Capability flags answer unsupported ops UPFRONT (exit 2, the flag named) —
// and a `transition` ask on ADO routes to the honest equivalent, a
// System.State field update via updateWorkItem, stated to the user in the
// plan. CI (AGENTEX_CI=1) refuses --execute before any read (exit 2, ci-mode);
// reads and dry-run plans are unaffected — the adapters carry the same guard
// one level down.
//
// Usage:
//   node workitem.js show --id <id> [--expand all]
//   node workitem.js search --query "<jql|wiql>"            (the configured provider's query language)
//   node workitem.js create --type <type> --spec <file.json>            [--execute]
//   node workitem.js update --id <id> --spec <file.json>                [--execute]
//   node workitem.js transition --id <id> --to <state-name-or-id>       [--execute]
//   node workitem.js comment --id <id> --body "<text>"                  [--execute]
//   node workitem.js link --id <id> --type <linkType> --target <id> [--direction inward] [--execute]
//
// Spec shapes: create -> { fields: {...}, relations?: [{rel, targetId}] };
//              update -> { fields: {...}, addRelations?: [{rel, targetId}] }.
// Fields are provider-level (System.* on ADO, flat ids on Jira) — see
// references/tracker/{ado,jira}-boards.md.
//
// Output: ONE JSON line; exit 0 = ok/plan, 1 = tracker/write failure,
// 2 = blocked/bad usage/config (repo convention D2 / invariant 9). Credentials
// are read from .env by the adapter and sent only in the Authorization header.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveTracker, TrackerError } = require(
  path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker', 'index.js'));

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

const USAGE =
  'usage: workitem.js show --id <id> [--expand all] | search --query "<jql|wiql>" | ' +
  'create --type <type> --spec <file.json> [--execute] | update --id <id> --spec <file.json> [--execute] | ' +
  'transition --id <id> --to <name-or-id> [--execute] | comment --id <id> --body "<text>" [--execute] | ' +
  'link --id <id> --type <linkType> --target <id> [--direction inward] [--execute]';

const PLAN_NOTE =
  'nothing has been written yet — render this plan for the user and get the ONE approval, then re-run with --execute';

function bad(mode, message) {
  return { code: 2, out: { ok: false, mode, error: { message } } };
}

function trackerErrorOut(e) {
  return {
    ok: false,
    error: {
      message: e.message,
      op: e.op, status: e.status, url: e.url,
      serverMessage: e.serverMessage,
      ...(e.credentialHint ? { credentialHint: e.credentialHint } : {}),
    },
  };
}

// Provider-neutral summary — one output shape whichever tracker is configured.
function summarizeWorkItem(adapter, wi) {
  const f = (wi && wi.fields) || {};
  if (adapter.name === 'jira') {
    const key = wi.key || wi.id;
    return {
      id: key,
      type: (f.issuetype && f.issuetype.name) || null,
      title: f.summary || null,
      state: (f.status && f.status.name) || null,
      url: adapter.webUrl(key),
      fields: f,
      ...(wi.renderedFields ? { renderedFields: wi.renderedFields } : {}),
    };
  }
  return {
    id: wi.id,
    type: f['System.WorkItemType'] || null,
    title: f['System.Title'] || null,
    state: f['System.State'] || null,
    url: adapter.webUrl(wi.id),
    fields: f,
    ...(wi.relations ? { relations: wi.relations } : {}),
  };
}

function readSpec(specPath) {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

// One plan entry from an adapter dry-run descriptor.
function planEntry(step, d, extra = {}) {
  return { step, describe: `${d.method} ${d.url}`, request: d, ...extra };
}

// The whole script as a callable: returns { code, out } and prints nothing —
// the CLI tail below owns the one JSON line. opts.fetch is the offline seam.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const execute = Boolean(args.execute);
  const mode = execute ? 'executed' : 'plan';
  const WRITES = ['create', 'update', 'transition', 'comment', 'link'];
  try {
    // CI guard (invariant 4 / ci-quality-gate): CI mode performs no tracker
    // writes of any kind — refuse --execute BEFORE any read; ad-hoc tracker
    // operations stay interactive. The adapters carry the same choke-point
    // guard one level down. Reads and dry-run plans are unaffected.
    if (execute && WRITES.includes(cmd) && process.env.AGENTEX_CI === '1') {
      return {
        code: 2,
        out: { ok: false, mode, blocked: [{ reason: 'ci-mode', message: 'tracker writes are disabled in CI (AGENTEX_CI=1) — ad-hoc work-item writes stay interactive; run this from an interactive session' }] },
      };
    }

    // ── reads (free, no gating) ────────────────────────────────────────────
    if (cmd === 'show') {
      if (!args.id) return bad(mode, `--id is required. ${USAGE}`);
      const adapter = resolveTracker(cwd, { fetch });
      const wi = await adapter.getWorkItem(args.id, args.expand ? { expand: args.expand } : {});
      return { code: 0, out: { ok: true, provider: adapter.name, workItem: summarizeWorkItem(adapter, wi) } };
    }

    if (cmd === 'search') {
      if (!args.query) return bad(mode, `--query is required (the configured provider's query language). ${USAGE}`);
      const adapter = resolveTracker(cwd, { fetch });
      const res = await adapter.query(args.query);
      const results = adapter.name === 'jira'
        ? ((res && res.issues) || []).map((i) => ({
          id: i.key, title: ((i.fields || {}).summary) ?? null, url: adapter.webUrl(i.key),
        }))
        : ((res && res.workItems) || []).map((w) => ({ id: w.id, url: adapter.webUrl(w.id) }));
      return {
        code: 0,
        out: {
          ok: true, provider: adapter.name, queryLanguage: adapter.capabilities.query,
          count: results.length, results, ...(res && res.truncated ? { truncated: true } : {}),
        },
      };
    }

    // ── writes (dry-run default; --execute behind the one approval) ───────
    if (cmd === 'create') {
      if (!args.type || !args.spec) return bad(mode, `--type and --spec are required. ${USAGE}`);
      let spec;
      try { spec = readSpec(args.spec); }
      catch (e) { return bad(mode, `could not read spec: ${e.message}`); }
      const adapter = resolveTracker(cwd, { fetch });
      if (!execute) {
        const d = await adapter.createWorkItem(args.type, spec, { execute: false });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('create', d)], note: PLAN_NOTE } };
      }
      const result = await adapter.createWorkItem(args.type, spec, { execute: true });
      return { code: 0, out: { ok: true, mode, result } };
    }

    if (cmd === 'update') {
      if (!args.id || !args.spec) return bad(mode, `--id and --spec are required. ${USAGE}`);
      let spec;
      try { spec = readSpec(args.spec); }
      catch (e) { return bad(mode, `could not read spec: ${e.message}`); }
      const adapter = resolveTracker(cwd, { fetch });
      if (!execute) {
        const d = await adapter.updateWorkItem(args.id, spec, { execute: false });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('update', d)], note: PLAN_NOTE } };
      }
      const result = await adapter.updateWorkItem(args.id, spec, { execute: true });
      return { code: 0, out: { ok: true, mode, result } };
    }

    if (cmd === 'transition') {
      if (!args.id || !args.to) return bad(mode, `--id and --to are required. ${USAGE}`);
      const adapter = resolveTracker(cwd, { fetch });
      if (adapter.capabilities.transitions && typeof adapter.transition === 'function') {
        // Jira: resolved against the issue's REAL transitions (fails closed
        // listing them); the dry run performs the free read only.
        if (!execute) {
          const d = await adapter.transition(args.id, args.to, { execute: false });
          return { code: 0, out: { ok: true, mode, plan: [planEntry('transition', d, { transition: d.transition })], note: PLAN_NOTE } };
        }
        const result = await adapter.transition(args.id, args.to, { execute: true });
        return { code: 0, out: { ok: true, mode, result } };
      }
      // ADO has no transition API: the honest equivalent is a State-field
      // update (System.State) — routed through updateWorkItem and STATED to
      // the user, never dressed up as a workflow transition.
      const note = `this tracker has no transition API — the honest equivalent is a State-field update (System.State = "${args.to}") via updateWorkItem, shown below`;
      if (!execute) {
        const d = await adapter.updateWorkItem(args.id, { fields: { 'System.State': args.to } }, { execute: false });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('transition-as-state-update', d)], note: `${note}. ${PLAN_NOTE}` } };
      }
      const result = await adapter.updateWorkItem(args.id, { fields: { 'System.State': args.to } }, { execute: true });
      return { code: 0, out: { ok: true, mode, result, note } };
    }

    if (cmd === 'comment') {
      if (!args.id || !args.body) return bad(mode, `--id and --body are required. ${USAGE}`);
      const adapter = resolveTracker(cwd, { fetch });
      if (!adapter.capabilities.comments || typeof adapter.addComment !== 'function') {
        return {
          code: 2,
          out: { ok: false, mode, blocked: [{ reason: 'unsupported-op', message: `comment is not supported on this tracker (capabilities.comments: ${adapter.capabilities.comments ?? 'undefined'}) — no comment API is wired for provider "${adapter.name}"` }] },
        };
      }
      if (!execute) {
        const d = await adapter.addComment(args.id, args.body, { execute: false });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('comment', d)], note: PLAN_NOTE } };
      }
      const result = await adapter.addComment(args.id, args.body, { execute: true });
      return { code: 0, out: { ok: true, mode, result } };
    }

    if (cmd === 'link') {
      if (!args.id || !args.type || !args.target) return bad(mode, `--id, --type and --target are required. ${USAGE}`);
      const attributes = args.direction ? { direction: String(args.direction) } : undefined;
      const adapter = resolveTracker(cwd, { fetch });
      if (!execute) {
        const d = await adapter.addRelation(args.id, args.type, args.target, { execute: false, ...(attributes ? { attributes } : {}) });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('link', d)], note: PLAN_NOTE } };
      }
      const result = await adapter.addRelation(args.id, args.type, args.target, { execute: true, ...(attributes ? { attributes } : {}) });
      return { code: 0, out: { ok: true, mode, result } };
    }

    return bad(mode, USAGE);
  } catch (e) {
    if (e instanceof TrackerError) return { code: 1, out: { mode, ...trackerErrorOut(e) } };
    return { code: e.exitCode === 2 ? 2 : 1, out: { ok: false, mode, error: { message: e.message, ...(e.reason ? { reason: e.reason } : {}) } } };
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
