#!/usr/bin/env node
// field_feedback.js — the consumer CLI behind the `field-feedback` skill and the
// /update-agentex absorption step (field-feedback-loop; spec appendix A2). Judgment (is
// this a plugin gap? is this item covered?) stays in the prompts; this script carries the
// mechanics: the entry grammar, redaction, locking, byte-exact marks.
//
// Verbs (each prints ONE JSON line and exits 0 ok, 1 I/O failure, 2 usage / refused):
//   capture --trigger <t> --affected <name|unknown> [--mode m] [--session s] [--script p]
//           [--fork p] [--rule CLAUDE.md]     stdin: {"problem","workaround"}
//     Appends ONE entry to .agentex/plugin-learnings.md (created with its header when
//     absent). Secret values never reach the file: .env values, short values after a
//     password label and credential shapes are replaced first. Runs under AGENTEX_CI=1
//     as mode ci. A failed capture never needs more than one line from the caller.
//   forks     lists the project's copies of plugin skills (names, rule, local path).
//
// Result line: {"tool":"agentex-field-feedback","schemaVersion":1,"verb":…,"result":
// "OK"|"BLOCKED"(exit 2)|"ERROR"(exit 1), …}. Never a secret, a stripped value or raw
// input on stdout or stderr. Under AGENTEX_CI=1 every verb except capture refuses
// (exit 2, reason ci-mode). Project = the current directory. No network, zero npm
// dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const learnings = require('./lib/learnings.js');
const inventory = require('./lib/plugin_inventory.js');
const sanitize = require('./lib/feedback_sanitize.js');

const TOOL = 'agentex-field-feedback';
const SCHEMA_VERSION = 1;
const { Refusal } = learnings;
const USAGE = 'usage: field_feedback.js capture --trigger <workaround|repeated-correction|self-written-script|forked-skill> --affected <skill|command|unknown> ' +
  '[--mode sequential|parallel|ci] [--session <s>] [--script <path>] [--fork <path>] [--rule CLAUDE.md] (stdin: {"problem","workaround"}) | forks';

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

const usage = (msg) => { throw new Refusal(`${msg} ${USAGE}`, { reason: 'usage' }); };
const line = (verb, result, extra = {}) => ({ tool: TOOL, schemaVersion: SCHEMA_VERSION, verb, result, ...extra });

function stringArg(args, name, { required = false } = {}) {
  const v = args[name];
  if (v === undefined) { if (required) usage(`--${name} is required.`); return null; }
  if (v === true || String(v).trim() === '') usage(`--${name} needs a value.`);
  return String(v);
}
// A project-relative path, forward slashes, no `..`.
function relPathArg(args, name) {
  const v = stringArg(args, name);
  if (v === null) return null;
  const p = v.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) usage(`--${name} must be a project-relative path.`);
  return p;
}

function readStdin(o) {
  if (o.stdin !== undefined) return String(o.stdin);
  try { if (process.stdin.isTTY) return ''; return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function readPayload(o) {
  let doc;
  try { doc = JSON.parse(readStdin(o).replace(/^﻿/, '')); } catch { usage('stdin must be JSON: {"problem": "...", "workaround": "..."}.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) usage('stdin must be a JSON object with "problem" and "workaround".');
  for (const k of ['problem', 'workaround']) {
    if (typeof doc[k] !== 'string' || doc[k].trim() === '') usage(`stdin needs a non-empty string "${k}".`);
  }
  return { problem: doc.problem, workaround: doc.workaround };
}

// ---- capture ---------------------------------------------------------------------------------
async function capture(args, o) {
  // 1. trigger (and the other flags) before anything is read or written
  const trigger = stringArg(args, 'trigger', { required: true });
  if (!learnings.TRIGGERS.includes(trigger)) usage(`--trigger must be one of ${learnings.TRIGGERS.join(', ')}.`);
  const affectedArg = stringArg(args, 'affected', { required: true });
  const modeArg = stringArg(args, 'mode');
  if (modeArg !== null && !learnings.MODES.includes(modeArg)) usage(`--mode must be one of ${learnings.MODES.join(', ')}.`);
  const session = stringArg(args, 'session');
  const script = relPathArg(args, 'script');
  const fork = relPathArg(args, 'fork');
  const rule = stringArg(args, 'rule');
  if (rule !== null && rule !== 'CLAUDE.md') usage('--rule must be CLAUDE.md.');
  const text = readPayload(o);
  const ci = o.env.AGENTEX_CI === '1';          // B8: a CI run is always mode ci

  // 2. affected against the inventory
  const inv = inventory.loadInventory(o.pluginRoot);
  const name = affectedArg.trim().replace(/^agentex:/i, '');
  const known = name === 'unknown' || inv.names.has(name);
  const affected = known ? name : 'unknown';

  // 3. version
  let version;
  try { version = inventory.readManifest(o.pluginRoot).version; }
  catch (e) { throw new Refusal(e.message, { reason: 'io', code: 1 }); }

  // 4. redact values
  const ctx = sanitize.loadSecretContext(o.cwd, { pluginRoot: o.pluginRoot, env: o.env });
  if (!ctx) throw new Refusal('the secret-scan core could not be loaded, so nothing was written — reinstall the plugin.', { reason: 'core-unavailable' });
  let redacted = 0;
  const clean = (v) => { if (v === null) return null; const r = sanitize.redactSecrets(v, ctx, { named: true }); redacted += r.count; return r.text; };
  const fields = {
    problem: clean(text.problem), workaround: clean(text.workaround),
    mode: ci ? 'ci' : (modeArg || 'sequential'),
    session: clean(session), script: clean(script), fork: clean(fork), rule,
  };

  // 5-7. lock, append, read back
  const r = await learnings.appendEntry(o.cwd, { trigger, affected, version, fields }, o.learn);
  return line('capture', 'OK', {
    id: r.id, file: r.file, created: r.created, redacted, affectedCoerced: !known, valueCheck: ctx.valueCheck,
    ...(r.brokeStaleLock ? { brokeStaleLock: true } : {}),
  });
}

// ---- forks -----------------------------------------------------------------------------------
async function forks(args, o) {
  const list = inventory.detectForks(o.cwd, inventory.loadInventory(o.pluginRoot));
  return line('forks', 'OK', { forks: list });
}

const VERBS = { capture, forks };

// run(argv, { cwd, pluginRoot, env, stdin, now, randomHex, sleep, lockWaitMs, lockRetryMs, staleLockMs }):
// the seams are for tests; the CLI passes none of them.
async function run(argv, opts = {}) {
  const { cwd, pluginRoot, env, stdin, ...learn } = opts;
  const o = {
    cwd: cwd || process.cwd(),
    pluginRoot: pluginRoot || inventory.defaultPluginRoot(),
    env: env || process.env,
    stdin,
    learn,
  };
  const args = parseArgs(argv);
  const verb = args._[0];
  try {
    if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) usage(verb === undefined ? 'a verb is required.' : `unknown verb ${JSON.stringify(String(verb).slice(0, 40))}.`);
    if (verb !== 'capture' && o.env.AGENTEX_CI === '1') {
      throw new Refusal(`${verb} is not available in a CI run (AGENTEX_CI=1): only capture is.`, { reason: 'ci-mode' });
    }
    return { code: 0, out: await VERBS[verb](args, o) };
  } catch (e) {
    const v = verb === undefined || !Object.prototype.hasOwnProperty.call(VERBS, verb) ? null : verb;
    if (e instanceof Refusal) {
      return { code: e.code, out: line(v, e.code === 2 ? 'BLOCKED' : 'ERROR', { reason: e.reason, error: { message: e.message } }) };
    }
    return { code: 1, out: line(v, 'ERROR', { reason: 'io', error: { message: 'an unexpected I/O error occurred' } }) };
  }
}

module.exports = { run, USAGE };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    process.exitCode = code;   // print, set the exit code, let the event loop drain
  });
}
