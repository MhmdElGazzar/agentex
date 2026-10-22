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
//   export    writes ONE sanitized file, .agentex/scratch/field-feedback/export-<UTC ts>.md,
//             of the open entries (plus the names of forked plugin skills) for the user to
//             review and send BY HAND. Nothing is sent. Best-effort sanitizer, four layers
//             (lib/feedback_sanitize.js); any residue, an unparseable config, a newer
//             schema, a missing secret layer or an un-ignored target stops with exit 2 and
//             no file. Zero open entries: result NOTHING_TO_EXPORT, no file.
//   absorb-candidates                    open entries older than the installed plugin + forks, each
//                                        with CHANGELOG evidence; blockedBy lists uncommitted paths
//   absorb-preview --plan <file>         validates the agent's plan, renders the one message
//   absorb-apply --plan <file> --expect-sha <sha>
//                                        all checks first (exit 2, nothing applied), then marks
//                                        the entry lines and moves the listed forks into scratch
//
// Result line: {"tool":"agentex-field-feedback","schemaVersion":1,"verb":…,"result":
// "OK"|"BLOCKED"(exit 2)|"ERROR"(exit 1), …}. Never a secret, a stripped value or raw
// input on stdout or stderr. Under AGENTEX_CI=1 every verb except capture refuses
// (exit 2, reason ci-mode). Project = the current directory. No network, zero npm
// dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const learnings = require('./lib/learnings.js');
const inventory = require('./lib/plugin_inventory.js');
const { compareVersions } = require('./lib/version.js');
const sanitize = require('./lib/feedback_sanitize.js');

const TOOL = 'agentex-field-feedback';
const SCHEMA_VERSION = 1;
const { Refusal } = learnings;
const USAGE = 'usage: field_feedback.js capture --trigger <workaround|repeated-correction|self-written-script|forked-skill> --affected <skill|command|unknown> ' +
  '[--mode sequential|parallel|ci] [--session <s>] [--script <path>] [--fork <path>] [--rule CLAUDE.md] (stdin: {"problem","workaround"}) | forks | export | absorb-candidates | absorb-preview --plan <file> | absorb-apply --plan <file> --expect-sha <sha>';

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

// ---- export ----------------------------------------------------------------------------------
const EXPORT_DIR = '.agentex/scratch/field-feedback';
const pad2 = (n) => String(n).padStart(2, '0');
const utcStamp = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;

// true / false inside a git work tree, null when there is no repository (or no git): the
// ignore check only applies inside one.
function gitIgnores(cwd, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
  if (r.error || r.status === null) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

async function exportVerb(args, o) {
  const cur = learnings.readLearnings(o.cwd);
  learnings.refuseNewer(cur.parsed);
  const open = cur.parsed.entries.filter((e) => e.status === 'open');
  if (!open.length) return line('export', 'NOTHING_TO_EXPORT', { entries: 0, forkedSkills: 0 });

  const ctx = sanitize.buildContext(o.cwd, { pluginRoot: o.pluginRoot, env: o.env, ...o.sanitize });
  let manifest;
  try { manifest = inventory.readManifest(o.pluginRoot); }
  catch (e) { throw new Refusal(e.message, { reason: 'io', code: 1 }); }
  const entries = []; const all = [];
  for (const e of open) { const r = sanitize.sanitizeEntry(e, ctx); entries.push(r.entry); all.push(r.counts); }
  const counts = sanitize.sumCounts(all);
  const forkedSkills = [...new Set(inventory.detectForks(o.cwd, inventory.loadInventory(o.pluginRoot)).map((f) => f.plugin))].sort();
  const payload = sanitize.buildPayload({ plugin: { name: manifest.name || 'agentex', version: manifest.version }, entries, forkedSkills, counts });
  const md = sanitize.renderExport(payload, { repository: manifest.repository, valueCheck: ctx.valueCheck, valueCheckReason: ctx.valueCheckReason, configFound: ctx.configFound });

  const stamp = utcStamp((o.learn.now || (() => new Date()))());
  let rel = `${EXPORT_DIR}/export-${stamp}.md`;
  if (gitIgnores(o.cwd, rel) === false) {
    throw new Refusal(`${EXPORT_DIR}/ is not git-ignored, so no export was written — run /update-agentex (migration 05 adds the scratch line to .gitignore), then export again.`, { reason: 'not-ignored' });
  }
  try { fs.mkdirSync(path.join(o.cwd, EXPORT_DIR), { recursive: true }); }
  catch (e) { throw new Refusal(`could not create ${EXPORT_DIR}: ${e.message}`, { reason: 'io', code: 1 }); }
  for (let n = 1; ; n++) {
    try { fs.writeFileSync(path.join(o.cwd, rel), md, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code === 'EEXIST' && n < 50) { rel = `${EXPORT_DIR}/export-${stamp}-${n + 1}.md`; continue; }
      throw new Refusal(`could not write the export file: ${e.code || 'error'}`, { reason: 'io', code: 1 });
    }
  }
  return line('export', 'OK', { file: rel, entries: entries.length, forkedSkills: forkedSkills.length, counts, valueCheck: ctx.valueCheck, config: ctx.configFound ? 'found' : 'none' });
}

// ---- absorption ------------------------------------------------------------------------------
const RETIRED_DIR = `${EXPORT_DIR}/retired-skills`;
const CHANGELOG_HEADER = /^## \[(\d+\.\d+\.\d+)\] — /;

// CHANGELOG.md sections: { version, fromLine, toLine } (1-based, inclusive), `[Unreleased]` skipped.
function changelogSections(pluginRoot) {
  const file = path.join(pluginRoot, 'CHANGELOG.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file: null, sections: [] }; }
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => { const m = CHANGELOG_HEADER.exec(l); if (m) heads.push({ version: m[1], at: i }); else if (/^## /.test(l)) heads.push({ version: null, at: i }); });
  const sections = [];
  heads.forEach((h, k) => {
    if (!h.version) return;
    let end = (k + 1 < heads.length ? heads[k + 1].at : lines.length) - 1;
    while (end > h.at && lines[end].trim() === '') end--;
    sections.push({ version: h.version, fromLine: h.at + 1, toLine: end + 1, text: lines.slice(h.at, end + 1).join('\n') });
  });
  return { file, sections };
}
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionsName = (text, name) => name && name !== 'unknown' && new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, 'i').test(text);

function changelogEvidence(cl, name, fromExclusive, toInclusive) {
  return cl.sections
    .filter((sec) => (fromExclusive === null || compareVersions(sec.version, fromExclusive) > 0) && compareVersions(sec.version, toInclusive) <= 0)
    .map((sec) => ({ version: sec.version, file: cl.file, fromLine: sec.fromLine, toLine: sec.toLine, namesAffected: mentionsName(sec.text, name) }));
}
function skillFileOf(o, inv, name) {
  if (inv.skills.includes(name)) return path.join(o.pluginRoot, 'skills', name, 'SKILL.md');
  return null;
}

// `git status` for one pathspec: { inRepo, records:[XY, …] }. Never writes (no index refresh).
function gitStatus(cwd, rel) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { inRepo: false, records: [] };
  const parts = r.stdout.split('\0').filter(Boolean);
  const records = [];
  for (let i = 0; i < parts.length; i++) { records.push(parts[i].slice(0, 2)); if (/^[RC]/.test(parts[i])) i++; }
  return { inRepo: true, records };
}
// The paths an apply would touch that carry uncommitted changes: the learnings file (any
// change, an untracked file included), or a TRACKED fork with edits.
function blockedPaths(o, { learningsFile, forkPaths }) {
  const blocked = [];
  if (learningsFile && gitStatus(o.cwd, learnings.FILE_REL).records.length) blocked.push(learnings.FILE_REL);
  for (const f of forkPaths) if (gitStatus(o.cwd, f).records.some((xy) => xy !== '??' && xy !== '!!')) blocked.push(f);
  return blocked;
}

const normPath = (p) => { const x = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''); return x === '' ? '' : `${x}/`; };

async function absorbCandidates(args, o) {
  const manifest = readManifestOrThrow(o);
  const inv = inventory.loadInventory(o.pluginRoot);
  const cl = changelogSections(o.pluginRoot);
  const cur = learnings.readLearnings(o.cwd);
  const entries = cur.parsed.entries
    .filter((e) => e.status === 'open' && compareVersions(e.version, manifest.version) < 0)
    .map((e) => ({
      id: e.id, date: e.date, trigger: e.trigger, affected: e.affected, version: e.version,
      problem: e.fields.problem || '', workaround: e.fields.workaround || '',
      ...(e.fields.fork ? { fork: e.fields.fork } : {}),
      lineSha: e.lineSha,
      evidence: { changelog: changelogEvidence(cl, e.affected, e.version, manifest.version), skillFile: skillFileOf(o, inv, e.affected) },
    }));
  const forkList = inventory.detectForks(o.cwd, inv).map((f) => ({
    ...f, evidence: { changelog: changelogEvidence(cl, f.plugin, null, manifest.version), skillFile: skillFileOf(o, inv, f.plugin) },
  }));
  const blockedBy = blockedPaths(o, { learningsFile: entries.length > 0, forkPaths: forkList.map((f) => f.path) });
  return line('absorb-candidates', 'OK', { installed: manifest.version, changelog: cl.file, entries, forks: forkList, blockedBy });
}

function readManifestOrThrow(o) {
  try { return inventory.readManifest(o.pluginRoot); }
  catch (e) { throw new Refusal(e.message, { reason: 'io', code: 1 }); }
}

// The plan file -> { plan, sha }. Any malformed plan is exit 2 plan-invalid.
function readPlan(args, o) {
  const file = stringArg(args, 'plan', { required: true });
  let raw;
  try { raw = fs.readFileSync(path.resolve(o.cwd, file)); } catch { throw new Refusal('the plan file could not be read.', { reason: 'plan-invalid', code: 2 }); }
  let plan;
  try { plan = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch { throw new Refusal('the plan file is not valid JSON.', { reason: 'plan-invalid', code: 2 }); }
  const bad = (m) => { throw new Refusal(`plan invalid: ${m}`, { reason: 'plan-invalid', code: 2 }); };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) bad('not an object');
  if (plan.schemaVersion !== 1) bad('schemaVersion must be 1');
  if (typeof plan.installed !== 'string') bad('installed must be a string');
  for (const k of ['mark', 'retire', 'review']) { if (plan[k] === undefined) plan[k] = []; if (!Array.isArray(plan[k])) bad(`${k} must be an array`); }
  plan.mark.forEach((m) => { if (!m || typeof m.id !== 'string' || typeof m.lineSha !== 'string') bad('every mark needs an id and a lineSha'); });
  plan.retire.forEach((m) => { if (!m || typeof m.path !== 'string' || typeof m.plugin !== 'string') bad('every retire needs a path and a plugin'); });
  plan.review.forEach((m) => { if (!m || typeof m.path !== 'string' || typeof m.plugin !== 'string') bad('every review needs a path and a plugin'); });
  return { plan, sha: crypto.createHash('sha256').update(raw).digest('hex') };
}

// Every check a plan must pass, before anything is written. Returns the resolved items.
function validatePlan(plan, o) {
  const manifest = readManifestOrThrow(o);
  const errors = [];
  const fail = (m) => errors.push(m);
  if (plan.installed !== manifest.version) fail(`installed ${plan.installed} is not the manifest version ${manifest.version}`);
  const cur = learnings.readLearnings(o.cwd);
  learnings.refuseNewer(cur.parsed);
  const byId = new Map(cur.parsed.entries.map((e) => [e.id, e]));
  const seenIds = new Set();
  const marks = [];
  for (const m of plan.mark) {
    const e = byId.get(m.id);
    if (!e) { fail(`unknown learning ${m.id}`); continue; }
    if (e.status !== 'open') { fail(`learning ${m.id} is not open`); continue; }
    if (e.lineSha !== m.lineSha) { fail(`learning ${m.id} changed since the plan was made`); continue; }
    if (seenIds.has(m.id)) { fail(`learning ${m.id} is listed twice`); continue; }
    seenIds.add(m.id);
    marks.push(e);
  }
  const forks = new Map(inventory.detectForks(o.cwd, inventory.loadInventory(o.pluginRoot)).map((f) => [f.path, f]));
  const used = new Map();
  const resolveFork = (item, kind) => {
    const key = normPath(item.path);
    const f = key.split('/').includes('..') ? null : forks.get(key);
    if (!f) { fail(`${kind} path is not a detected fork: ${key || '(empty)'}`); return null; }
    if (f.plugin !== item.plugin) { fail(`${kind} plugin ${item.plugin} does not match the fork at ${key}`); return null; }
    if (used.has(key)) { fail(`${key} is listed more than once (${used.get(key)} and ${kind})`); return null; }
    used.set(key, kind);
    return f;
  };
  const retire = plan.retire.map((x) => resolveFork(x, 'retire')).filter(Boolean);
  const review = plan.review.map((x) => ({ ...resolveFork(x, 'review'), why: String(x.why || '').replace(/\s+/g, ' ').trim() })).filter((x) => x.path);
  if (errors.length) {
    const err = new Refusal(`plan invalid: ${errors.length} problem(s) — nothing was changed.`, { reason: 'plan-invalid', code: 2 });
    err.errors = errors;
    throw err;
  }
  return { manifest, marks, retire, review };
}

const firstLine = (t) => { const l = String(t || '').split('\n')[0]; return l.length > 110 ? `${l.slice(0, 110)}…` : l; };
function renderPlanMessage({ manifest, marks, retire, review }) {
  const out = [];
  if (marks.length) {
    out.push(`Mark absorbed in v${manifest.version} (${marks.length})`);
    for (const e of marks) out.push(`- ${e.id} · ${e.affected} · ${firstLine(e.fields.problem)}`);
  }
  if (retire.length) {
    if (out.length) out.push('');
    out.push(`Retire (moved to \`${RETIRED_DIR}/\`) (${retire.length})`);
    for (const f of retire) out.push(`- ${f.plugin} (${f.path})`);
  }
  if (review.length) {
    if (out.length) out.push('');
    out.push(`Review by hand (not changed) (${review.length})`);
    for (const f of review) out.push(`- ${f.plugin} (${f.path})${f.why ? ` — ${f.why}` : ''}`);
  }
  const asks = marks.length + retire.length > 0;
  out.push('', asks ? 'Apply the marks and moves above? Answer yes or no.' : 'Nothing above will be changed.');
  return { message: out.join('\n'), asks };
}

async function absorbPreview(args, o) {
  const { plan, sha } = readPlan(args, o);
  const v = validatePlan(plan, o);
  const { message, asks } = renderPlanMessage(v);
  return line('absorb-preview', 'OK', { message, planSha: sha, asks, mark: v.marks.length, retire: v.retire.length, review: v.review.length });
}

// ---- the folder move: rename, or copy-verify-remove across devices; never overwriting ------------
function treeFingerprint(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name); const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) out.push(`L ${rel} ${fs.readlinkSync(abs)}`);
      else if (e.isDirectory()) { out.push(`D ${rel}`); walk(abs); }
      else out.push(`F ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(root);
  return out.join('\n');
}
function moveFolder(src, dest, rename) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { rename(src, dest); return 'rename'; }
  catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (treeFingerprint(src) !== treeFingerprint(dest)) { fs.rmSync(dest, { recursive: true, force: true }); throw Object.assign(new Error('copy did not verify'), { code: 'EVERIFY' }); }
  fs.rmSync(src, { recursive: true });
  return 'copy';
}
function freshDestination(cwd, name, stamp) {
  const base = path.join(cwd, RETIRED_DIR, `${name}-${stamp}`);
  let dest = base;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${base}-${n}`;
  return dest;
}

async function absorbApply(args, o) {
  const { plan, sha } = readPlan(args, o);
  const expect = stringArg(args, 'expect-sha', { required: true });
  if (sha !== expect) throw new Refusal('the plan changed since it was previewed (sha mismatch) — nothing was changed; preview it again.', { reason: 'plan-changed', code: 2 });
  const v = validatePlan(plan, o);
  const blocked = blockedPaths(o, { learningsFile: v.marks.length > 0, forkPaths: v.retire.map((f) => f.path) });
  if (blocked.length) {
    const err = new Refusal(`uncommitted changes in ${blocked.join(', ')} — commit them first, then re-run; nothing was changed.`, { reason: 'blocked', code: 2 });
    err.blockedBy = blocked;
    throw err;
  }
  for (const f of v.retire) {
    let st; try { st = fs.lstatSync(path.join(o.cwd, f.path)); } catch { st = null; }
    if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new Refusal(`${f.path} is not a plain folder — nothing was changed.`, { reason: 'plan-invalid', code: 2 });
  }
  const results = [];
  let brokeStaleLock = false;
  if (v.marks.length) {
    const res = await learnings.withLock(o.cwd, learnings.withDefaults(o.learn), async () => {
      // re-check under the lock: the file may have changed since validation
      const cur = learnings.readLearnings(o.cwd);
      for (const e of v.marks) {
        const now = cur.parsed.entries.find((x) => x.id === e.id);
        if (!now || now.status !== 'open' || now.lineSha !== e.lineSha) throw new Refusal(`learning ${e.id} changed while applying — nothing was changed.`, { reason: 'plan-invalid', code: 2 });
      }
      const next = learnings.markAbsorbed(cur.buf, v.marks.map((e) => ({ id: e.id, version: v.manifest.version })));
      try { fs.writeFileSync(`${cur.abs}.tmp`, next); fs.renameSync(`${cur.abs}.tmp`, cur.abs); }
      catch (err) { throw new Refusal(`could not rewrite ${learnings.FILE_REL}: ${err.code || 'error'}`, { reason: 'io', code: 1 }); }
      return { ok: true };
    });
    brokeStaleLock = !!res.brokeStaleLock;
    for (const e of v.marks) results.push({ kind: 'mark', id: e.id, status: 'applied' });
  }
  const stamp = utcStamp((o.learn.now || (() => new Date()))());
  for (const f of v.retire) {
    const name = f.path.replace(/\/$/, '').split('/').pop();
    const dest = freshDestination(o.cwd, name, stamp);
    try {
      moveFolder(path.join(o.cwd, f.path), dest, o.learn.rename || fs.renameSync);
      results.push({ kind: 'retire', path: f.path, status: 'applied', to: path.relative(o.cwd, dest).split(path.sep).join('/') });
    } catch (e) {
      results.push({ kind: 'retire', path: f.path, status: 'failed', reason: e.code === 'EVERIFY' ? 'copy-not-verified' : 'io' });
    }
  }
  const failed = results.some((r) => r.status === 'failed');
  const out = line('absorb-apply', failed ? 'ERROR' : 'OK', {
    ...(failed ? { reason: 'io' } : {}),
    marked: results.filter((r) => r.kind === 'mark' && r.status === 'applied').length,
    retired: results.filter((r) => r.kind === 'retire' && r.status === 'applied').length,
    results, ...(brokeStaleLock ? { brokeStaleLock: true } : {}),
  });
  if (failed) { out.error = { message: 'a fork could not be moved; see results — the source folder is untouched' }; throw Object.assign(new Refusal(out.error.message, { reason: 'io', code: 1 }), { extra: out }); }
  return out;
}

const VERBS = { capture, forks, export: exportVerb, 'absorb-candidates': absorbCandidates, 'absorb-preview': absorbPreview, 'absorb-apply': absorbApply };

// run(argv, { cwd, pluginRoot, env, stdin, now, randomHex, sleep, lockWaitMs, lockRetryMs, staleLockMs }):
// the seams are for tests; the CLI passes none of them.
async function run(argv, opts = {}) {
  const { cwd, pluginRoot, env, stdin, sanitize: sanitizeOpts, ...learn } = opts;
  const o = {
    cwd: cwd || process.cwd(),
    pluginRoot: pluginRoot || inventory.defaultPluginRoot(),
    env: env || process.env,
    stdin,
    sanitize: sanitizeOpts,
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
      if (e.extra) return { code: e.code, out: e.extra };
      return { code: e.code, out: line(v, e.code === 2 ? 'BLOCKED' : 'ERROR', { reason: e.reason, error: { message: e.message }, ...(e.errors ? { errors: e.errors } : {}), ...(e.blockedBy ? { blockedBy: e.blockedBy } : {}) }) };
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
