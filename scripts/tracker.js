#!/usr/bin/env node
// tracker.js — the plugin's ONE tracker CLI (moved from skills/tracker-ops/scripts/
// in skill-consolidation-foundation WP-2; tracker-ops and later skills call it
// via ${CLAUDE_PLUGIN_ROOT}/scripts/tracker.js): show / search / create / update /
// transition / comment / link on WHICHEVER tracker the project configures
// (azure or jira block — resolved by scripts/lib/tracker/, never per-run).
// Everything goes through the tracker layer's REST adapters over Node's
// built-in fetch — no az, no acli, no process spawning, zero npm dependencies.
//
// SPINE vs. STRATEGY: this file is the provider-neutral spine — arg parsing,
// USAGE, the CI guard, capability checks, plan entries, error mapping and the
// CLI tail. Every provider-shaped mapping (summaries, result shapes, the
// transition route, refused fields) lives in a per-provider TrackerOpsStrategy
// under scripts/lib/tracker/ops/, looked up through a fail-closed registry: a
// provider with an adapter but no strategy is refused (exit 2) before any
// request — never a fallback to another provider's behavior (invariant 10).
//
// ONE GATE (invariant 4): every write subcommand is a DRY RUN by default — it
// returns the exact request plan and writes nothing; `--execute` performs it,
// and the skill puts that flag behind ONE user approval per write batch.
// Capability flags answer unsupported ops UPFRONT (exit 2, the flag named).
// CI (AGENTEX_CI=1) refuses --execute before any read (exit 2, ci-mode);
// reads and dry-run plans are unaffected — the adapters carry the same guard
// one level down.
//
// Usage (reads are free; every write is a dry run unless --execute):
//   node tracker.js show --id <id> [--expand all] [--fields f1,f2] [--out <file>]
//   node tracker.js search --query "<jql|wiql>" [--fields f1,f2] [--top n] [--out <file>]
//   node tracker.js batch (--ids a,b,… | --ids-file <file>) --fields f1,f2 [--out <file>]
//   node tracker.js comments --id <id> [--out <file>]
//   node tracker.js relations --id <id>[,<id>…] [--kind parent|child|tested-by|related|link|all] [--fields f1,f2] [--out <file>]
//   node tracker.js iterations [--team <name> | --board <id|name>] [--timeframe current|future|past|all] [--out <file>]
//   node tracker.js create --type <type> --spec <file.json>                                  [--execute]
//   node tracker.js update --id <id> [--spec <file.json>] [--discussion "<text>" | --discussion-file <file>] [--mention <who>] [--execute]
//   node tracker.js transition --id <id> --to <state-name-or-id>                             [--execute]
//   node tracker.js comment --id <id> (--body "<text>" | --body-file <file>) [--mention <who>] [--execute]
//   node tracker.js link --id <id> --type <linkType> --target <id> [--direction inward]      [--execute]
//
// --out <file>: the result is written as UTF-8 JSON to that file and stdout
// carries only the path, the byte count and counts/flags — text you will
// analyse never travels through a pipe (which can drop non-ASCII).
// --mention <who>: createdBy | assignedTo | an email | a display name —
// resolved to the tracker's real mention form, or refused (exit 2) with the
// candidates; never posted as a bare "@text".
//
// Spec shapes: create -> { fields: {...}, relations?: [{rel, targetId}] };
//              update -> { fields: {...}, addRelations?: [{rel, targetId}] }.
// Fields are provider-level field ids — see references/tracker/{ado,jira}-boards.md.
//
// Output: ONE JSON line; exit 0 = ok/plan, 1 = tracker/write failure,
// 2 = blocked/bad usage/config (repo convention D2 / invariant 9). Credentials
// are read from .env by the adapter and sent only in the Authorization header.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const trackerLib = require(path.join(__dirname, 'lib', 'tracker', 'index.js'));
const { defaultRegistry } = require(path.join(__dirname, 'lib', 'tracker', 'ops', 'index.js'));
const { WritePlan } = require(path.join(__dirname, 'lib', 'tracker', 'ledger.js'));

const { TrackerError } = trackerLib;

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
  'usage: tracker.js show --id <id> [--expand all] [--fields f1,f2] [--out <file>] | ' +
  'search --query "<jql|wiql>" [--fields f1,f2] [--top n] [--out <file>] | ' +
  'batch (--ids a,b,… | --ids-file <file>) --fields f1,f2 [--out <file>] | comments --id <id> [--out <file>] | ' +
  'relations --id <id>[,<id>…] [--kind parent|child|tested-by|related|link|all] [--fields f1,f2] [--out <file>] | ' +
  'iterations [--team <name> | --board <id|name>] [--timeframe current|future|past|all] [--out <file>] | ' +
  'create --type <type> --spec <file.json> [--execute] | ' +
  'update --id <id> [--spec <file.json>] [--discussion "<text>" | --discussion-file <file>] [--mention <who>] [--execute] | ' +
  'transition --id <id> --to <name-or-id> [--execute] | ' +
  'comment --id <id> (--body "<text>" | --body-file <file>) [--mention <who>] [--execute] | ' +
  'link --id <id> --type <linkType> --target <id> [--direction inward] [--execute]';

const PLAN_NOTE =
  'nothing has been written yet — render this plan for the user and get the ONE approval, then re-run with --execute';

const WRITES = ['create', 'update', 'transition', 'comment', 'link'];

// Neutral relation kinds and the capability flag that gates each (link: none).
const RELATION_KINDS = { parent: 'parent', child: 'child', 'tested-by': 'testedBy', related: 'related', link: null };
const TIMEFRAMES = ['current', 'future', 'past', 'all'];

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

function readSpec(specPath) {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

// "a,b , c" -> ['a', 'b', 'c']; undefined/true -> null.
function list(v) {
  if (v === undefined || v === true) return null;
  const items = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

// A capability refusal: exit 2, the flag named, before any request.
function unsupported(mode, op, flag, adapter) {
  const value = flag.split('.').reduce((o, k) => (o == null ? undefined : o[k]), adapter.capabilities);
  return {
    code: 2,
    out: { ok: false, mode, blocked: [{ reason: 'unsupported-op', flag, message: `${op} is not supported on this tracker (capabilities.${flag}: ${value ?? 'undefined'}) — refused before any request; nothing was read or written` }] },
  };
}

// THE one discussion path shared by `comment` and `update --discussion`:
// resolve the mention (free reads) -> render the provider's exact body ->
// one addComment. The dry run and --execute run this same code, so the plan
// shows exactly the body that is written. An unresolvable or ambiguous
// mention returns { blocked } — nothing is written and a bare "@text" is
// never posted in its place.
async function postDiscussion(adapter, strategy, id, text, who) {
  let mention = null;
  if (who !== undefined) {
    const r = await strategy.resolveMention(adapter, id, String(who));
    if (r.blocked) return { blocked: r.blocked };
    mention = r.mention;
  }
  const body = strategy.renderDiscussion(text, mention);
  return { mention, body, send: (execute) => adapter.addComment(id, body, { execute }) };
}

// The --out emitter (non-ASCII never travels through a pipe): the payload is
// written as UTF-8 JSON to <file>.tmp and renamed into place (parent folders
// created); the stdout line carries the absolute path, the byte count and
// counts/flags only — never a body field.
function emitToFile(cwd, outArg, payload, { count, missing, truncated } = {}) {
  const abs = path.resolve(cwd, String(outArg));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = JSON.stringify(payload, null, 2);
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, abs);
  return {
    ok: true, provider: payload.provider, out: abs, bytes: Buffer.byteLength(body, 'utf8'),
    ...(count !== undefined ? { count } : {}),
    ...(missing !== undefined ? { missing } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// One plan entry from an adapter dry-run descriptor.
function planEntry(step, d, extra = {}) {
  return { step, describe: `${d.method} ${d.url}`, request: d, ...extra };
}

// The whole script as a callable: returns { code, out } and prints nothing —
// the CLI tail below owns the one JSON line. Seams (tests inject them; the CLI
// passes none): fetch (offline transport), registry (ops strategies),
// resolveTracker (the adapter).
async function run(argv, { cwd = process.cwd(), fetch, registry = defaultRegistry, resolveTracker = trackerLib.resolveTracker } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const execute = Boolean(args.execute);
  const mode = execute ? 'executed' : 'plan';
  // The configured adapter and its strategy — resolved together, fail-closed:
  // resolveTracker sends nothing (auth is lazy), registry.get refuses an
  // unregistered provider before any adapter method runs.
  const open = () => {
    const adapter = resolveTracker(cwd, { fetch });
    return { adapter, strategy: registry.get(adapter.name) };
  };
  // A read's result: the payload on stdout, or written to --out with a
  // counts-only stdout line.
  // --<name> "<text>" or --<name>-file <path> (UTF-8): { text } | { error } | null.
  const textArg = (name) => {
    const inline = args[name]; const file = args[`${name}-file`];
    if (inline === undefined && file === undefined) return null;
    if (inline !== undefined && file !== undefined) return { error: `pass --${name} or --${name}-file, not both. ${USAGE}` };
    if (inline === true || file === true) return { error: `--${inline === true ? name : `${name}-file`} needs a value. ${USAGE}` };
    if (inline !== undefined) return { text: String(inline) };
    try { return { text: fs.readFileSync(path.resolve(cwd, String(file)), 'utf8') }; }
    catch (e) { return { error: `could not read --${name}-file: ${e.message}` }; }
  };
  const deliver = (payload, counts) => {
    if (args.out === undefined) return { code: 0, out: payload };
    return { code: 0, out: emitToFile(cwd, args.out, payload, counts) };
  };
  try {
    if (args.out === true) return bad(mode, `--out needs a file path. ${USAGE}`);

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
      const fields = list(args.fields);
      const { adapter, strategy } = open();
      const wi = await adapter.getWorkItem(args.id, { ...(args.expand ? { expand: args.expand } : {}), ...(fields ? { fields } : {}) });
      return deliver({ ok: true, provider: adapter.name, workItem: strategy.summarize(adapter, wi, { fields }) });
    }

    if (cmd === 'search') {
      if (!args.query) return bad(mode, `--query is required (the configured provider's query language). ${USAGE}`);
      const fields = list(args.fields);
      const { adapter, strategy } = open();
      let top;
      const { max } = strategy.searchOptions({});
      if (args.top !== undefined) {
        top = Number(args.top);
        if (!Number.isInteger(top) || top < 1 || top > max) return bad(mode, `--top must be a whole number from 1 to ${max} on this tracker (got ${JSON.stringify(args.top)}). ${USAGE}`);
      }
      const { options } = strategy.searchOptions({ top, fields });
      const res = await adapter.query(strategy.scopeQuery(adapter, args.query), options);
      const { results, truncated } = await strategy.searchResults(adapter, res, { top, fields });
      return deliver({
        ok: true, provider: adapter.name, queryLanguage: adapter.capabilities.query,
        count: results.length, results, ...(truncated ? { truncated: true } : {}),
      }, { count: results.length, truncated });
    }

    if (cmd === 'batch') {
      const fields = list(args.fields);
      if ((args.ids === undefined) === (args['ids-file'] === undefined) || !fields) {
        return bad(mode, `batch needs exactly one of --ids a,b,… / --ids-file <file>, and --fields f1,f2. ${USAGE}`);
      }
      let ids;
      if (args.ids !== undefined) ids = list(args.ids);
      else {
        try { ids = fs.readFileSync(path.resolve(cwd, String(args['ids-file'])), 'utf8').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean); }
        catch (e) { return bad(mode, `could not read --ids-file: ${e.message}`); }
      }
      if (!ids || !ids.length) return bad(mode, `no ids given. ${USAGE}`);
      const { adapter, strategy } = open();
      if (!adapter.capabilities.batchRead) return unsupported(mode, 'batch', 'batchRead', adapter);
      const r = await strategy.batchRead(adapter, ids, fields);
      return deliver({
        ok: true, provider: adapter.name, count: r.items.length, items: r.items, missing: r.missing,
        ...(r.moved && r.moved.length ? { moved: r.moved } : {}),
      }, { count: r.items.length, missing: r.missing.length });
    }

    if (cmd === 'comments') {
      if (!args.id) return bad(mode, `--id is required. ${USAGE}`);
      const { adapter, strategy } = open();
      if (!adapter.capabilities.comments) return unsupported(mode, 'comments', 'comments', adapter);
      const thread = await strategy.comments(adapter, args.id);
      return deliver({ ok: true, provider: adapter.name, id: args.id, count: thread.length, comments: thread }, { count: thread.length });
    }

    if (cmd === 'relations') {
      const ids = list(args.id);
      if (!ids) return bad(mode, `--id is required (one id, or a comma list). ${USAGE}`);
      const asked = list(args.kind) || ['all'];
      const unknown = asked.filter((k) => k !== 'all' && !Object.prototype.hasOwnProperty.call(RELATION_KINDS, k));
      if (unknown.length) return bad(mode, `unknown --kind ${unknown.join(', ')} — accepted: ${Object.keys(RELATION_KINDS).join(', ')}, all. ${USAGE}`);
      const fields = list(args.fields) || [];
      const { adapter, strategy } = open();
      const rel = adapter.capabilities.relations || {};
      const supported = (k) => RELATION_KINDS[k] === null || Boolean(rel[RELATION_KINDS[k]]);
      let kinds; const skipped = [];
      if (asked.includes('all')) {
        kinds = Object.keys(RELATION_KINDS).filter(supported);
        for (const k of Object.keys(RELATION_KINDS)) if (!supported(k)) skipped.push({ kind: k, flag: `relations.${RELATION_KINDS[k]}` });
      } else {
        const refused = asked.find((k) => !supported(k));
        if (refused) return unsupported(mode, `relations --kind ${refused}`, `relations.${RELATION_KINDS[refused]}`, adapter);
        kinds = [...new Set(asked)];
      }
      const r = await strategy.relations(adapter, ids, kinds, fields);
      const total = r.items.reduce((n, i) => n + i.relations.length, 0);
      return deliver({ ok: true, provider: adapter.name, kinds, items: r.items, ...(skipped.length ? { skipped } : {}) }, { count: total });
    }

    if (cmd === 'iterations') {
      const timeframe = args.timeframe === undefined ? 'all' : String(args.timeframe);
      if (!TIMEFRAMES.includes(timeframe)) return bad(mode, `--timeframe must be one of ${TIMEFRAMES.join(', ')}. ${USAGE}`);
      if (args.team === true || args.board === true) return bad(mode, `--team / --board need a value. ${USAGE}`);
      const { adapter, strategy } = open();
      if (!adapter.capabilities.sprints) return unsupported(mode, 'iterations', 'sprints', adapter);
      const rows = await strategy.iterations(adapter, {
        ...(args.team !== undefined ? { team: String(args.team) } : {}),
        ...(args.board !== undefined ? { board: String(args.board) } : {}),
        timeframe,
      });
      return deliver({ ok: true, provider: adapter.name, timeframe, count: rows.length, iterations: rows }, { count: rows.length });
    }

    // ── writes (dry-run default; --execute behind the one approval) ───────
    if (cmd === 'create') {
      if (!args.type || !args.spec) return bad(mode, `--type and --spec are required. ${USAGE}`);
      let spec;
      try { spec = readSpec(args.spec); }
      catch (e) { return bad(mode, `could not read spec: ${e.message}`); }
      const { adapter } = open();
      if (!execute) {
        const d = await adapter.createWorkItem(args.type, spec, { execute: false });
        return { code: 0, out: { ok: true, mode, plan: [planEntry('create', d)], note: PLAN_NOTE } };
      }
      const result = await adapter.createWorkItem(args.type, spec, { execute: true });
      return { code: 0, out: { ok: true, mode, result } };
    }

    if (cmd === 'update') {
      const disc = textArg('discussion');
      if (!args.id || (!args.spec && !disc)) return bad(mode, `--id and --spec are required. ${USAGE}`);
      if (disc && disc.error) return bad(mode, disc.error);
      if (args.mention !== undefined && !disc) return bad(mode, `--mention goes with --discussion / --discussion-file. ${USAGE}`);
      if (args.mention === true) return bad(mode, `--mention needs a value (createdBy, assignedTo, an email, or a display name). ${USAGE}`);
      let spec = null;
      if (args.spec) {
        try { spec = readSpec(args.spec); }
        catch (e) { return bad(mode, `could not read spec: ${e.message}`); }
      }
      const { adapter, strategy } = open();
      if (spec) {
        const blocked = strategy.refusedUpdateFields(spec);
        if (blocked.length) return { code: 2, out: { ok: false, mode, blocked } };
      }
      if (!disc) {
        if (!execute) {
          const d = await adapter.updateWorkItem(args.id, spec, { execute: false });
          return { code: 0, out: { ok: true, mode, plan: [planEntry('update', d)], note: PLAN_NOTE } };
        }
        const result = await adapter.updateWorkItem(args.id, spec, { execute: true });
        return { code: 0, out: { ok: true, mode, result } };
      }
      if (!adapter.capabilities.comments || typeof adapter.addComment !== 'function') return unsupported(mode, 'update --discussion', 'comments', adapter);
      if (args.mention !== undefined && !adapter.capabilities.mentions) return unsupported(mode, '--mention', 'mentions', adapter);
      const post = await postDiscussion(adapter, strategy, args.id, disc.text, args.mention);
      if (post.blocked) return { code: 2, out: { ok: false, mode, blocked: [post.blocked] } };
      const withMention = post.mention ? { mention: post.mention } : {};
      if (!execute) {
        const plan = [];
        if (spec) plan.push(planEntry('update-fields', await adapter.updateWorkItem(args.id, spec, { execute: false })));
        plan.push(planEntry('post-discussion', await post.send(false)));
        return { code: 0, out: { ok: true, mode, plan, ...withMention, note: PLAN_NOTE } };
      }
      const intents = [];
      if (spec) {
        intents.push({
          step: 'update-fields', describe: `update the fields of ${args.id} (the request shown in the plan)`,
          run: async () => { const r = await adapter.updateWorkItem(args.id, spec, { execute: true }); return { id: r.id, url: r.url }; },
        });
      }
      intents.push({
        step: 'post-discussion', describe: `post the discussion comment on ${args.id} (the exact body shown in the plan)`,
        run: async () => { const r = await post.send(true); return { id: r && r.id }; },
      });
      const ledger = await new WritePlan(intents).execute();
      const allDone = ledger.every((l) => l.status === 'done');
      return { code: allDone ? 0 : 1, out: { ok: allDone, mode, ledger, ...withMention } };
    }

    if (cmd === 'transition') {
      if (!args.id || !args.to) return bad(mode, `--id and --to are required. ${USAGE}`);
      const { adapter, strategy } = open();
      const t = await strategy.transition(adapter, args.id, args.to, { execute });
      if (!execute) {
        return {
          code: 0,
          out: { ok: true, mode, plan: [planEntry(t.step, t.request, t.extra)], note: t.note ? `${t.note}. ${PLAN_NOTE}` : PLAN_NOTE },
        };
      }
      return { code: 0, out: { ok: true, mode, result: t.result, ...(t.note ? { note: t.note } : {}) } };
    }

    if (cmd === 'comment') {
      const disc = textArg('body');
      if (!args.id || !disc) return bad(mode, `--id and --body are required. ${USAGE}`);
      if (disc.error) return bad(mode, disc.error);
      if (args.mention === true) return bad(mode, `--mention needs a value (createdBy, assignedTo, an email, or a display name). ${USAGE}`);
      const { adapter, strategy } = open();
      if (!adapter.capabilities.comments || typeof adapter.addComment !== 'function') return unsupported(mode, 'comment', 'comments', adapter);
      if (args.mention !== undefined && !adapter.capabilities.mentions) return unsupported(mode, '--mention', 'mentions', adapter);
      const post = await postDiscussion(adapter, strategy, args.id, disc.text, args.mention);
      if (post.blocked) return { code: 2, out: { ok: false, mode, blocked: [post.blocked] } };
      const withMention = post.mention ? { mention: post.mention } : {};
      if (!execute) {
        return { code: 0, out: { ok: true, mode, plan: [planEntry('comment', await post.send(false))], ...withMention, note: PLAN_NOTE } };
      }
      const result = await post.send(true);
      return { code: 0, out: { ok: true, mode, result, ...withMention } };
    }

    if (cmd === 'link') {
      if (!args.id || !args.type || !args.target) return bad(mode, `--id, --type and --target are required. ${USAGE}`);
      const attributes = args.direction ? { direction: String(args.direction) } : undefined;
      const { adapter } = open();
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

module.exports = { run, USAGE };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
