#!/usr/bin/env node
// create-tasks.js — the task-estimation flow's mechanics, provider-neutral:
// read the sprint's stories (or explicitly named ones), then validate
// EVERYTHING first (zero board writes) and — only behind --execute — create the
// [Testing] tasks, one atomic create per task with the parent relation inline,
// behind an exact per-write ledger.
//
// THE SPINE. Everything tracker-specific — which work item type is a story, the
// sprint read, the existing-children scan, field validation, field
// composition, the create type and parent relation, follow-up writes, describe
// text, how a ref is written in a message — lives in the configured provider's
// estimation strategy (./strategies/<provider>.js), looked up in a fail-closed
// registry (./strategies/index.js) by the resolved adapter's name. A provider
// with no registered strategy is refused (exit 2) before any request; nothing
// here falls back to another provider's behavior (invariant 10).
//
// Built on the tracker layer (scripts/lib/tracker/): REST over Node's built-in
// fetch. No CLI, no process spawning, zero npm dependencies. Credentials are
// read from .env by the adapter and sent only in the Authorization header —
// never printed, logged, or placed on a command line (invariant 5).
//
// THE ESTIMATION FILE — config/estimation.json (scripts/lib/estimation_config.js)
// is the user's: the [Testing] tasks (names, count, order, min/max hours,
// enabled) and the rating factors. This script creates it ONCE, only behind
// --execute after the one approval, with an exclusive create; it never
// rewrites it.
//
// ESTIMATION (Phase A, first — free, no board write, never writes the file):
//   node create-tasks.js estimation --out <scratch file> [--sprints <n>] [--team "<name>"] [--board "<id|name>"]
//     File present and valid → its content, ZERO requests (the tracker is not
//     even resolved). Invalid → exit 2 naming every problem, nothing read or
//     written. No file → the strategy's history read (the last N closed
//     sprints' [Testing] tasks, Original Estimate only; default N = 2) → a
//     proposal (estimation/history.js) written to --out — an OS-temp scratch
//     file, created exclusively or replacing only a previous proposal — and
//     summarized: tasks with min/max, provenance, abnormal values, or labelled
//     starter defaults with the reason.
//
// READS (free, no gating — `stories` has no --execute surface at all):
//   node create-tasks.js stories --current-sprint [--team "<name>"] [--sprint "<name>"] [--full]
//   node create-tasks.js stories --ids <ID,ID> [--full]
//     The strategy resolves the current sprint (run-only overrides such as
//     --team / --sprint never rewrite the consumer's config, invariant 11) and
//     reports a sprint read it cannot resolve as a blocked/error result.
//     Per story: the strategy's row — id/title/state/storyPoints/url, the
//     provider's placement facts, existingTestingTasks (children titled
//     [Testing]…), and with --full the description + acceptance-criteria HTML
//     for the agent's factor analysis.
//
// DRY RUN (default) — the validation gate behind the skill's ONE approval:
//   node create-tasks.js --spec <file.json> [--allow-existing] [--refresh-fields]
//     A RATINGS spec (the skill's: `estimation` key or stories[].ratings)
//     carries 0–4 factor ratings, never tasks or hours. Before any request,
//     the tasks and hours are derived (estimation/placement.js) from the file
//     — or, on a first run, from estimation.proposalFile plus the user's
//     outlierChoices / taskEdits — with run-only stories[].adjust; every
//     derivation problem blocks (exit 2, zero requests). The derived tasks
//     spec then takes the unchanged path below, and the output gains an
//     `estimation` block (content, provenance, outliers, per-story ratings /
//     score / hours, totals, `basis`); a first run's plan opens with the
//     create-file entry. A LEGACY tasks spec keeps the 0.23.0 path, but only
//     on a project without the file (tasks-not-from-file otherwise).
//     The strategy validates (reads + local checks only): each story exists and
//     IS a story (fails closed); placement is re-read from the story, never
//     trusted from the spec; existing [Testing] children block without
//     --allow-existing, and a children check that cannot complete blocks too
//     (fails CLOSED). Structural: every task title starts with "[Testing] ",
//     every estimate is a finite number > 0, the assignee comes from the spec or
//     a single configured value — never invented. Field values are checked
//     against the project's field cache (--refresh-fields rebuilds it). The
//     plan lists every intended write in order with its exact route.
//
// --execute — one WritePlan of the story-ordered task intents (each create,
//   plus the strategy's follow-up step right after it when it has one). First
//   failure stops; the ledger reports every intended write as done (id + url)
//   or not-done (reason); created IDs are in the JSON even when a later step
//   throws. No auto-retry, no cleanup writes.
//   Ratings mode: `--execute --basis <estimation.basis>` — everything is
//   recomputed and must equal the approved dry run (missing-basis /
//   basis-mismatch otherwise, zero writes). On a first run the file is
//   intent 0 of the same plan (exclusive create: a file that appeared is
//   never replaced, and no task is sent); created.file reports it.
//
// Spec JSON shapes (written by the agent to the OS temp dir):
//   ratings: { "assignee": "qa.engineer@example.com",
//              "estimation": { "proposalFile": "<the --out file>", "outlierChoices": {…}, "taskEdits": {…} },
//              "stories": [ { "id": <story id>, "ratings": { "<factor>": 0..4, … }, "adjust": { "<task>": <hours> | "skip" } } ] }
//   legacy:  { "assignee": "qa.engineer@example.com",
//              "stories": [ { "id": <story id>, "complexity": "Simple",
//                             "tasks": [ { "title": "[Testing] Requirement Review", "estimate": 1 }, … ] } ] }
//
// Output: ONE JSON line (invariant 9). Exit codes:
//   reads/dry run 0 = ok / plan ready | 2 = blocked/bad usage | 1 = unexpected
//   --execute     0 = every intended write done | 1 = partial/failed (see ledger)
//                 | 2 = refused before any write
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker');
const tracker = require(path.join(LIB, 'index.js'));
const { TrackerError } = tracker;
const { WritePlan } = require(path.join(LIB, 'ledger.js'));
const { defaultRegistry, compat } = require('./strategies/index.js');
const ec = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'estimation_config.js'));
const proposals = require('./estimation/history.js');
const placement = require('./estimation/placement.js');

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
  'usage: create-tasks.js stories --current-sprint [--team <name>] [--full] | stories --ids <id,id> [--full]' +
  ' | create-tasks.js --spec <file.json> [--allow-existing] [--refresh-fields] [--execute]';

// The estimation subcommand's own usage (USAGE above is pinned by the goldens).
const ESTIMATION_USAGE =
  'usage: create-tasks.js estimation --out <file> [--sprints <n>] [--team <name>] [--board <id|name>]';

// The --out scratch file is never anything but a proposal (invariant 11): a
// new path is created exclusively ('wx'); an existing path is re-written only
// when it already holds a previous proposal. Anything else — a project file, a
// note, a folder — is refused untouched.
//   isProposalFile(p) → true | false (never throws)
//   writeProposalFile(p, text) → null | refusal message (nothing was written)
function isProposalFile(p) {
  try { return proposals.checkProposal(JSON.parse(fs.readFileSync(p, 'utf8'))) === null; }
  catch { return false; }
}
const notAProposal = (p) => `--out ${p} already exists and is not a previous estimation proposal — ` +
  'it is never replaced; pass a new scratch path in the OS temp dir. Nothing was written.';
function writeProposalFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let fd;
  try { fd = fs.openSync(p, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!isProposalFile(p)) return notAProposal(p);
    fs.writeFileSync(p, text); // a previous proposal: this run's replaces it
    return null;
  }
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ---- estimation (Phase A, read-only on the board; never writes the file) ----
//   file present, valid   → source 'file' — ZERO requests, the tracker is not
//                           even resolved (history is read only when there is no file)
//   file present, invalid → exit 2, every problem — nothing read or written,
//                           the file is never repaired
//   no file               → the configured strategy's history read (the last N
//                           closed sprints' [Testing] tasks, Original Estimate
//                           only) → the proposal, written to the --out scratch
//                           file the agent chose (OS temp) and summarized here
async function estimationCmd(args, { cwd, fetch, registry, resolveTracker, now }) {
  const file = ec.ESTIMATION_FILE_REL;
  const loaded = ec.loadEstimationConfig(cwd);
  if (loaded.state === 'valid') {
    return {
      code: 0,
      out: {
        ok: true, mode: 'estimation', source: 'file', file, content: loaded.content, enabledTasks: loaded.enabledTasks,
        ...(args.sprints !== undefined ? {
          note: `--sprints has no effect: history is read only when there is no file, and ${file} exists. ` +
            'To rebuild it from your board, delete or move the file — the next run proposes a new one.',
        } : {}),
      },
    };
  }
  if (loaded.state === 'invalid') {
    return {
      code: 2,
      out: {
        ok: false, mode: 'estimation', source: 'invalid', file, problems: loaded.problems,
        message: `${file} is invalid — nothing was read or written. The plugin never repairs, reformats or replaces it: ` +
          'fix every problem listed by hand (or delete or move the file so the next run proposes a new one), then re-run.',
      },
    };
  }
  const usage = (why) => ({ code: 2, out: { ok: false, mode: 'estimation', error: { message: `${why} ${ESTIMATION_USAGE}` } } });
  if (typeof args.out !== 'string' || !args.out.trim()) return usage('--out <file> is required: a scratch file in the OS temp dir for the proposal.');
  let count = ec.DEFAULT_SPRINTS;
  if (args.sprints !== undefined) {
    if (typeof args.sprints !== 'string' || !/^[1-9]\d*$/.test(args.sprints.trim())) {
      return usage(`--sprints must be a positive whole number (got ${JSON.stringify(args.sprints)}).`);
    }
    count = Number(args.sprints.trim());
  }
  const outPath = path.resolve(cwd, args.out);
  if (outPath.toLowerCase() === path.resolve(cwd, ...file.split('/')).toLowerCase()) {
    return usage(`--out must be a scratch file, never ${file} — that file is written only on the user's approval.`);
  }
  // Checked before the history read, so a refusal costs no request.
  if (fs.existsSync(outPath) && !isProposalFile(outPath)) {
    return { code: 2, out: { ok: false, mode: 'estimation', error: { message: notAProposal(outPath) } } };
  }
  const adapter = resolveTracker(cwd, { fetch });
  const strategy = registry.get(adapter.name);
  const r = await strategy.pastTestingTasks(adapter, args, { count });
  if (r.stop) return r.stop;
  const proposal = proposals.propose(r.history, { createdOn: localDate(now()) });
  const refused = writeProposalFile(outPath, JSON.stringify(proposal, null, 2) + '\n');
  if (refused) return { code: 2, out: { ok: false, mode: 'estimation', error: { message: refused } } };
  const view = proposals.recompute(proposal, {});
  return {
    code: 0,
    out: {
      ok: true, mode: 'estimation', source: 'proposal', kind: proposal.kind, proposalFile: outPath, file,
      content: proposal.content, provenance: proposal.provenance, groups: view.groups, outliers: view.outliers,
      threshold: proposal.threshold,
    },
  };
}

// ---- stories (read-only; there is no --execute path here) --------------------
async function storiesCmd(args, adapter, strategy) {
  const ctx = await strategy.openStoriesRead(adapter, args);
  let refs;
  if (args.ids) {
    refs = strategy.parseIds(args.ids);
  } else if (args['current-sprint']) {
    const r = await strategy.currentSprint(adapter, args, ctx);
    if (r.stop) return r.stop;
    refs = r.refs;
  } else {
    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  }

  const stories = [];
  for (const ref of refs) {
    try {
      const story = await strategy.readStory(adapter, ref, ctx);
      let children = null; let childrenError = null;
      try { children = await strategy.testingChildren(adapter, story); }
      catch (e) { childrenError = e; }
      stories.push(strategy.storyRow(story, { ref, children, childrenError, full: Boolean(args.full) }, ctx));
    } catch (e) {
      stories.push({ id: ref, warning: `could not be read: ${e.message}` });
    }
  }
  return { code: 0, out: { ok: true, mode: 'stories', count: stories.length, stories } };
}

// The strategy's Validation must carry every key — the spine has NO defaults,
// so a gap fails the run closed (exit 1) before any write.
function assertValidation(v, provider) {
  const gaps = [];
  const has = (k) => v && Object.prototype.hasOwnProperty.call(v, k);
  if (!has('blocked') || !Array.isArray(v.blocked)) gaps.push('blocked[]');
  if (!has('validation') || !v.validation || typeof v.validation !== 'object' || !Array.isArray(v.validation.perStory)) gaps.push('validation.perStory[]');
  if (!has('cacheInfo') || (v.cacheInfo !== null && typeof v.cacheInfo !== 'object')) gaps.push('cacheInfo');
  if (!has('cacheStale') || typeof v.cacheStale !== 'boolean') gaps.push('cacheStale');
  if (!has('createType') || typeof v.createType !== 'string') gaps.push('createType');
  if (!has('parentRel') || typeof v.parentRel !== 'string') gaps.push('parentRel');
  if (!has('fieldsFor') || typeof v.fieldsFor !== 'function') gaps.push('fieldsFor');
  if (!has('describeCreate') || typeof v.describeCreate !== 'function') gaps.push('describeCreate');
  if (!has('followUp')) gaps.push('followUp');
  else if (v.followUp !== null && (typeof v.followUp !== 'object' || typeof v.followUp.step !== 'string' ||
    typeof v.followUp.fieldsFor !== 'function' || typeof v.followUp.plannedTarget !== 'string' ||
    typeof v.followUp.describe !== 'function')) gaps.push('followUp{step, fieldsFor, plannedTarget, describe}');
  if (gaps.length) {
    throw new Error(`the '${provider}' task-estimation strategy returned an incomplete validation (missing: ${gaps.join(', ')}) — refusing; nothing was written`);
  }
}

// ---- spec structural checks (before any read) ---------------------------------
function specShapeErrors(spec) {
  const blocked = [];
  if (!Array.isArray(spec.stories) || spec.stories.length === 0) {
    blocked.push({ reason: 'missing-required-field', field: 'stories', message: 'spec.stories must be a non-empty array' });
    return blocked;
  }
  spec.stories.forEach((st, i) => {
    if (!st || st.id === undefined || st.id === null || st.id === '') {
      blocked.push({ reason: 'missing-required-field', field: `stories[${i}].id`, message: `spec.stories[${i}].id is required` });
    }
    if (!Array.isArray(st.tasks) || st.tasks.length === 0) {
      blocked.push({ reason: 'missing-required-field', field: `stories[${i}].tasks`, message: `spec.stories[${i}].tasks must be a non-empty array` });
    }
  });
  return blocked;
}

// ---- the ratings spec mode ------------------------------------------------------
// A spec with an `estimation` key, or any story with `ratings`, is a ratings
// spec: the agent sends 0–4 factor ratings, never tasks or hours. The task set
// and the hours are DERIVED here — purely, before any tracker request — from
// config/estimation.json (or, on a first run, from the Phase-A proposal plus
// the user's outlier choices and gate edits), then handed to the UNCHANGED
// validate → plan → WritePlan spine below as an ordinary tasks spec.
const CREATE_FILE_DESCRIBE = `create ${ec.ESTIMATION_FILE_REL} — a new file, written only if none exists (never replaces one)`;
const PROPOSAL_KEYS = ['proposalFile', 'outlierChoices', 'taskEdits'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isRatingsSpec(spec) {
  if (!isPlainObject(spec)) return false;
  if (Object.prototype.hasOwnProperty.call(spec, 'estimation')) return true;
  return Array.isArray(spec.stories) && spec.stories.some((st) => isPlainObject(st) && st.ratings !== undefined);
}

function ratingsShapeErrors(spec) {
  const blocked = [];
  if (spec.estimation !== undefined && !isPlainObject(spec.estimation)) {
    blocked.push({ reason: 'missing-required-field', field: 'estimation', message: 'spec.estimation must be an object { proposalFile?, outlierChoices?, taskEdits? }' });
  }
  if (!Array.isArray(spec.stories) || spec.stories.length === 0) {
    blocked.push({ reason: 'missing-required-field', field: 'stories', message: 'spec.stories must be a non-empty array' });
    return blocked;
  }
  spec.stories.forEach((st, i) => {
    if (!isPlainObject(st) || st.id === undefined || st.id === null || st.id === '') {
      blocked.push({ reason: 'missing-required-field', field: `stories[${i}].id`, message: `spec.stories[${i}].id is required` });
    } else if (st.tasks !== undefined) {
      blocked.push({
        reason: 'tasks-not-from-file', story: st.id,
        message: `spec.stories[${i}] carries tasks — this project's task set comes from ${ec.ESTIMATION_FILE_REL} — send ratings, not tasks`,
      });
    }
  });
  return blocked;
}

// → { blocked } | { estimation, expanded }
function deriveEstimation(spec, cwd) {
  const file = ec.ESTIMATION_FILE_REL;
  const est = isPlainObject(spec.estimation) ? spec.estimation : {};
  const loaded = ec.loadEstimationConfig(cwd);
  let content; let source; let create; let proposalView = null;
  if (loaded.state === 'invalid') {
    return { blocked: [{
      reason: 'estimation-file-invalid', file, problems: loaded.problems,
      message: `${file} is invalid — nothing was read or written; the plugin never repairs it: fix every problem listed by hand, then re-run`,
    }] };
  }
  if (loaded.state === 'valid') {
    const stale = PROPOSAL_KEYS.filter((k) => est[k] !== undefined);
    if (stale.length) {
      return { blocked: [{
        reason: 'estimation-file-exists', file,
        message: `${file} exists, but the spec still carries a first-run proposal (${stale.join(', ')}) — ` +
          'the proposal is stale: re-run Phase A (estimation) and build the spec from the file; nothing was read or written',
      }] };
    }
    content = loaded.content; source = 'file'; create = false;
  } else {
    if (typeof est.proposalFile !== 'string' || !est.proposalFile.trim()) {
      return { blocked: [{
        reason: 'estimation-proposal-required', file,
        message: `there is no ${file} yet — run "create-tasks.js estimation --out <file>" first (Phase A) and pass that file as spec.estimation.proposalFile`,
      }] };
    }
    const proposalFile = path.resolve(cwd, est.proposalFile);
    let proposal; let bad;
    try { proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8')); bad = proposals.checkProposal(proposal); }
    catch (e) { bad = e.message; }
    if (bad) {
      return { blocked: [{
        reason: 'proposal-unreadable', proposalFile,
        message: `the proposal ${proposalFile} could not be used (${bad}) — re-run Phase A (estimation --out <file>)`,
      }] };
    }
    proposalView = proposals.recompute(proposal, { outlierChoices: est.outlierChoices, taskEdits: est.taskEdits });
    if (proposalView.problems.length) return { blocked: proposalView.problems };
    content = proposalView.content; source = proposal.kind; create = true;
    proposalView.provenance = proposal.provenance;
  }
  const derived = placement.deriveStories(content, spec.stories);
  if (derived.problems.length) return { blocked: derived.problems };
  // What is written must equal what was shown: the basis covers the file
  // content to write or use and every story's derived titles and hours.
  const basis = crypto.createHash('sha256').update(JSON.stringify({
    file: ec.serializeEstimationConfig(content),
    stories: derived.perStory.map((st) => ({ id: st.id, tasks: st.tasks.map((t) => [t.title, t.hours]) })),
  })).digest('hex');
  return {
    estimation: {
      source, file, create, content,
      ...(proposalView ? {
        provenance: proposalView.provenance, groups: proposalView.groups,
        outliers: proposalView.outliers, threshold: proposalView.threshold,
      } : {}),
      perStory: derived.perStory, total: derived.total, basis,
    },
    expanded: {
      ...(spec.assignee !== undefined ? { assignee: spec.assignee } : {}),
      stories: derived.perStory.map((st) => ({ id: st.id, tasks: st.tasks.map((t) => ({ title: t.title, estimate: t.hours })) })),
    },
  };
}

// ---- main ---------------------------------------------------------------------
// Returns { code, out }; prints nothing. opts.fetch is the offline-test seam;
// opts.registry / opts.resolveTracker are the same kind of seam for the
// registry and the tracker resolution, and opts.now the clock seam for a
// proposal's createdOn (tests inject them; the CLI never does).
async function run(argv, { cwd = process.cwd(), fetch, registry = defaultRegistry, resolveTracker = tracker.resolveTracker, now = () => new Date() } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const mode = cmd === 'estimation' ? 'estimation' : args.execute ? 'executed' : 'plan';
  try {
    if (cmd === 'estimation') return await estimationCmd(args, { cwd, fetch, registry, resolveTracker, now });

    if (cmd === 'stories') {
      const adapter = resolveTracker(cwd, { fetch });
      return await storiesCmd(args, adapter, registry.get(adapter.name));
    }

    if (!args.spec) return { code: 2, out: { ok: false, mode, error: { message: `--spec <file.json> is required. ${USAGE}` } } };
    let spec;
    try { spec = JSON.parse(fs.readFileSync(args.spec, 'utf8')); }
    catch (e) { return { code: 2, out: { ok: false, mode, error: { message: `could not read spec: ${e.message}` } } }; }

    // Ratings mode: derive the tasks and hours first — pure, zero requests.
    let estimation = null;
    if (isRatingsSpec(spec)) {
      const shape = ratingsShapeErrors(spec);
      if (shape.length) return { code: 2, out: { ok: false, mode, blocked: shape } };
      const d = deriveEstimation(spec, cwd);
      if (d.blocked) return { code: 2, out: { ok: false, mode, blocked: d.blocked } };
      ({ estimation } = d);
      spec = d.expanded;
      if (args.execute) {
        // What is written must equal what the user approved: --execute carries
        // the dry run's basis, recomputed here — before any request.
        const basis = typeof args.basis === 'string' ? args.basis.trim() : '';
        if (!basis) {
          return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'missing-basis',
            message: '--execute in ratings mode needs --basis <estimation.basis from the approved dry run> — nothing was written' }] } };
        }
        if (basis !== estimation.basis) {
          return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'basis-mismatch',
            message: 'the file, the proposal or the ratings changed since the approved dry run (the basis differs) — ' +
              're-run the dry run and show the new screen; nothing was written' }] } };
        }
        if (estimation.create && fs.existsSync(path.join(cwd, ...ec.ESTIMATION_FILE_REL.split('/')))) {
          return { code: 2, out: { ok: false, mode, blocked: [{ reason: 'estimation-file-exists', file: ec.ESTIMATION_FILE_REL,
            message: `${ec.ESTIMATION_FILE_REL} appeared after the approved dry run — it is never replaced; re-run Phase A; nothing was written` }] } };
        }
      }
    } else {
      // Legacy tasks specs keep the 0.23.0 path — but only on a project without
      // the file: with it, the task set comes from the file, never the spec.
      const loaded = ec.loadEstimationConfig(cwd);
      if (loaded.state !== 'missing') {
        return { code: 2, out: { ok: false, mode, blocked: [loaded.state === 'valid' ? {
          reason: 'tasks-not-from-file',
          message: `this project's task set comes from ${ec.ESTIMATION_FILE_REL} — send ratings, not tasks`,
        } : {
          reason: 'estimation-file-invalid', file: ec.ESTIMATION_FILE_REL, problems: loaded.problems,
          message: `${ec.ESTIMATION_FILE_REL} is invalid — nothing was read or written; the plugin never repairs it: fix every problem listed by hand, then re-run`,
        }] } };
      }
      const shapeErrors = specShapeErrors(spec);
      if (shapeErrors.length) return { code: 2, out: { ok: false, mode, blocked: shapeErrors } };
    }
    const withEstimation = (out) => (estimation ? { ...out, estimation } : out);

    const adapter = resolveTracker(cwd, { fetch });
    const strategy = registry.get(adapter.name);
    // The validation/gate/ledger spine is shared; the strategy supplies every
    // provider value — field composition, create type, parent relation,
    // describe text, and any follow-up step. No defaults here.
    const v = await strategy.validate(adapter, spec, args, cwd);
    assertValidation(v, strategy.provider);
    const { blocked, validation, fieldsFor, cacheInfo, cacheStale, createType, parentRel, describeCreate, followUp } = v;
    const cacheOut = cacheInfo
      ? { file: cacheInfo.file, rebuilt: cacheInfo.rebuilt, builtAt: cacheInfo.cache.builtAt, ...(cacheInfo.reason ? { reason: cacheInfo.reason } : {}) }
      : null;

    if (blocked.length) {
      return { code: 2, out: withEstimation({ ok: false, mode, blocked, validation, ...(cacheOut ? { cache: cacheOut } : {}), ...(cacheStale ? { cacheStale: true } : {}) }) };
    }

    // The story-ordered flat task list — the same order plans and executes.
    const entryById = new Map(validation.perStory.map((e) => [e.id, e]));
    const flat = [];
    for (const st of spec.stories) {
      for (const task of st.tasks) flat.push({ storyId: st.id, entry: entryById.get(st.id), task });
    }

    if (!args.execute) {
      // The PLAN: every intended create, in order, with its exact route —
      // rendered by the agent on the consolidated screen. Nothing has been written.
      const plan = [];
      if (estimation && estimation.create) {
        plan.push({ step: 'create-file', path: ec.ESTIMATION_FILE_REL, describe: CREATE_FILE_DESCRIBE });
      }
      for (const { storyId, entry, task } of flat) {
        const d = await adapter.createWorkItem(createType, {
          fields: fieldsFor(entry, task),
          relations: [{ rel: parentRel, targetId: storyId }],
        }, { execute: false });
        plan.push({
          step: 'create-task', story: storyId, title: task.title,
          describe: `${d.method} ${d.url} (${parentRel} -> ${typeof storyId === 'number' ? `#${storyId}` : storyId} inline — atomic)`,
          request: d,
        });
        if (followUp) {
          const u = await adapter.updateWorkItem(followUp.plannedTarget, { fields: followUp.fieldsFor(entry, task) }, { execute: false });
          plan.push({ step: followUp.step, story: storyId, title: task.title, describe: `${u.method} ${u.url} — right after the create above`, request: u });
        }
      }
      return { code: 0, out: withEstimation({ ok: true, mode: 'plan', validation, plan, cache: cacheOut }) };
    }

    // ---- WRITE PHASE (only past explicit --execute, i.e. past the user's one approval)
    const createdTasks = [];
    const intents = flat.flatMap(({ storyId, entry, task }) => {
      let createdId = null;
      const create = {
        step: 'create-task',
        describe: describeCreate(task, storyId),
        run: async () => {
          const r = await adapter.createWorkItem(createType, {
            fields: fieldsFor(entry, task),
            relations: [{ rel: parentRel, targetId: storyId }],
          }, { execute: true });
          createdId = r.id;
          createdTasks.push({ id: r.id, url: r.url, storyId, title: task.title });
          return { id: r.id, url: r.url };
        },
      };
      if (!followUp) return [create];
      const fields = followUp.fieldsFor(entry, task);
      return [create, {
        step: followUp.step,
        describe: followUp.describe(task),
        run: async () => adapter.updateWorkItem(createdId, { fields }, { execute: true }),
      }];
    });

    // Ratings mode, first run: the file is intent 0 of the SAME plan — the
    // cheapest write, the likeliest to fail (a race, local permissions), and
    // the one with no board side effect, so a failed file write stops the run
    // before any task exists. An exclusive create: it never replaces a file.
    let fileCreated = false;
    if (estimation && estimation.create) {
      intents.unshift({
        step: 'create-file',
        describe: CREATE_FILE_DESCRIBE,
        run: async () => {
          ec.createEstimationFileExclusive(cwd, estimation.content);
          fileCreated = true;
          return {}; // no id: ids stay tracker ids, so a ledger never mistakes the file for a board item
        },
      });
    }

    const ledger = await new WritePlan(intents).execute();
    const allDone = ledger.every((l) => l.status === 'done');
    return {
      code: allDone ? 0 : 1,
      out: {
        ok: allDone,
        mode: 'executed',
        ledger,
        // Created IDs are ALWAYS surfaced, even when a later step threw.
        created: { tasks: createdTasks, ...(estimation ? { file: fileCreated ? ec.ESTIMATION_FILE_REL : null } : {}) },
        ...(cacheOut ? { cache: cacheOut } : {}),
      },
    };
  } catch (e) {
    if (e instanceof TrackerError) {
      return { code: 1, out: { ok: false, mode, error: { message: e.message, op: e.op, status: e.status, serverMessage: e.serverMessage, ...(e.credentialHint ? { credentialHint: e.credentialHint } : {}) } } };
    }
    return { code: e.exitCode === 2 ? 2 : 1, out: { ok: false, mode, error: { message: e.message } } };
  }
}

module.exports = {
  run,
  // Pinned compat names, owned by the strategies (create-tasks.test.js pins them).
  currentIterationWiql: compat.currentIterationWiql,
  currentSprintJql: compat.currentSprintJql,
  PARENT_LINK: compat.PARENT_LINK,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    // After a fetch, force-exiting crashes libuv on Windows (open undici handles).
    // Print, set the exit code, and let the event loop drain instead.
    process.exitCode = code;
  });
}
