#!/usr/bin/env node
'use strict';
// Which release-gate lanes the local e2e tests prove (policy Q31, written by the project manager).
//
//   node scripts/dev/e2e/proof.js --base <last release> [--root <repo>] [--covers <covers.json>]
//
// Takes the lanes scripts/release-gate/gate-plan.js selects for <base>..HEAD and decides, per lane,
// whether the covering e2e files prove it. A lane is proven only when ALL hold:
//   1. the tree is clean and HEAD is known (a dirty tree exits 2 and nothing is proven);
//   2. no changed file of the lane is a prompt or agent file (skills/**/*.md, agents/*.md,
//      commands/*.md, references/**/*.md): e2e exercises scripts and pages, never an agent following
//      a prompt;
//   3. the lane is not tracker, and no changed file is code that talks to a real third-party API
//      (a fixed list below that no covers.json entry can override): a fixture this repo writes shares
//      this repo's assumptions;
//   4. every changed file of the lane is mapped in covers.json, and for a function-scoped entry
//      (`file#fn1,fn2`) every changed hunk lies inside the named functions, at base and at HEAD;
//   5. every covering e2e file ran at HEAD with AGENTEX_E2E_REQUIRE=1 and passed (a skip or a failure
//      is never proof).
// setup and wizard always run live (Q16): never proven here.
//
// covers.json: { "schemaVersion": 1, "<e2e file>": ["<file>", "<file>#fn1,fn2"] }. A scope is a
// top-level `function name(`, `async function name(` or `const name =` at column 0 (inside the one
// <script> of an .html); its span runs to the next top-level declaration (or the closing </script>).
//
// Output: ONE JSON line {head, base, clean, lanes:{<lane>:{proven, by:[e2e files], why}}}.
// Exit 0 · 2 dirty tree, unknown HEAD or base, usage ({error} in the line). Read-only.
// Maintainer tooling: never shipped by any host (scripts/hosts COMMON_EXCLUDES).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const gate = require('../../release-gate/gate-plan.js');

// Code that talks to a real third-party API (or is only ever proven by a live run): never proven by e2e.
const NEVER = [
  'scripts/lib/tracker/**', 'skills/tracker-ops/**', 'skills/task-estimation/**', 'skills/test-design/**',
  'skills/bug-report-azure/**', 'references/tracker/**', 'scripts/lib/estimation_config.js',
  'scripts/release-gate/inject-env.js', 'scripts/release-gate/gate-ledger.js', 'scripts/release-gate/teardown.js',
  'scripts/release-gate/fixtures/**',
];
const PROMPTS = ['skills/**/*.md', 'agents/*.md', 'commands/*.md', 'references/**/*.md'];
const NEVER_RE = NEVER.map((g) => gate.globToRegExp(g));
const PROMPT_RE = PROMPTS.map((g) => gate.globToRegExp(g));
const any = (res, f) => res.some((re) => re.test(f));
const E2E_TIMEOUT_MS = 300000;
const USAGE = 'usage: proof.js --base <ref> [--root <repo>] [--covers <covers.json>]';

class Blocked extends Error {}

function git(root, args, { allowFail = false } = {}) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }); }
  catch (e) {
    if (allowFail) return null;
    throw new Blocked(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

// ---- covers.json ------------------------------------------------------------------------------
function parseCovers(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = []; // { e2e, file, fns: null | [names] }
  for (const [e2e, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const [f, fns] = String(entry).split('#');
      out.push({ e2e, file: f, fns: fns ? fns.split(',').map((x) => x.trim()).filter(Boolean) : null });
    }
  }
  return out;
}

// ---- scopes and hunks -------------------------------------------------------------------------
const DECL_RE = /^(?:async\s+function\s+([A-Za-z_$][\w$]*)\s*\(|function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=)/;
// name -> [{start, end}] (1-based, inclusive), from the top-level declarations of a text.
function spansOf(text) {
  const lines = text.split('\n');
  const decls = [];
  lines.forEach((l, i) => { const m = DECL_RE.exec(l); if (m) decls.push({ name: m[1] || m[2] || m[3], line: i + 1 }); });
  const out = new Map();
  decls.forEach((d, k) => {
    let end = k + 1 < decls.length ? decls[k + 1].line - 1 : lines.length;
    for (let i = d.line; i <= end; i++) if (/^<\/script>/.test(lines[i - 1])) { end = i - 1; break; }
    if (!out.has(d.name)) out.set(d.name, []);
    out.get(d.name).push({ start: d.line, end });
  });
  return out;
}
// `git diff -U0` hunks: old and new line ranges. A pure insertion/deletion is the pair of lines around the point.
function hunksOf(root, base, head, file) {
  const diff = git(root, ['diff', '-U0', '--no-renames', `${base}..${head}`, '--', file]);
  const hunks = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oc = m[2] === undefined ? 1 : Number(m[2]); const nc = m[4] === undefined ? 1 : Number(m[4]);
    const os = Number(m[1]); const ns = Number(m[3]);
    hunks.push({ old: oc === 0 ? [os, os + 1] : [os, os + oc - 1], neu: nc === 0 ? [ns, ns + 1] : [ns, ns + nc - 1] });
  }
  return hunks;
}
const inside = (range, spans) => (spans || []).some((s) => range[0] >= s.start && range[1] <= s.end);

const showAt = (root, ref, file) => git(root, ['show', `${ref}:${file}`], { allowFail: true });

// Does `cover` (a scoped entry) hold every changed hunk of `file`? Returns '' or the reason it does not.
function scopedGap(root, base, head, file, fns) {
  const before = showAt(root, base, file); const after = showAt(root, head, file);
  if (before === null || after === null) return `${file} was added or deleted: only a whole-file entry covers that`;
  const b = spansOf(before); const a = spansOf(after);
  const bad = hunksOf(root, base, head, file).filter((h) => !fns.some((n) => inside(h.old, b.get(n)) && inside(h.neu, a.get(n))));
  return bad.length ? `${file} lines ${bad.map((h) => `${h.neu[0]}-${h.neu[1]}`).join(', ')} lie outside ${fns.join(', ')}` : '';
}

// Which e2e files cover a changed file; or why none does.
function coverageOf(root, base, head, file, covers) {
  const entries = covers.filter((c) => c.file === file);
  if (!entries.length) return { by: [], why: `${file} is not in covers.json` };
  const by = []; const gaps = [];
  for (const c of entries) {
    if (!c.fns) { by.push(c.e2e); continue; }
    const gap = scopedGap(root, base, head, file, c.fns);
    if (gap) gaps.push(gap); else by.push(c.e2e);
  }
  return by.length ? { by: [...new Set(by)], why: '' } : { by: [], why: gaps[0] };
}

// ---- running the e2e files ---------------------------------------------------------------------
function runE2e(root, file) {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(root, file))) { resolve({ ok: false, why: `${file} does not exist at HEAD` }); return; }
    const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, AGENTEX_E2E_REQUIRE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), E2E_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, why: `${file} could not start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve({ ok: true });
      const skip = /^SKIP: (.*)$/m.exec(out);
      if (code === 77 && skip) return resolve({ ok: false, why: `${file} skipped (${skip[1].slice(0, 160)}): a skip is never proof` });
      const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      return resolve({ ok: false, why: `${file} failed (exit ${code}): ${last.slice(0, 160)}` });
    });
  });
}

// ---- the decision ------------------------------------------------------------------------------
function judge(root, base, head, lane, because, covers) {
  const prompts = because.filter((f) => any(PROMPT_RE, f));
  if (prompts.length) return { by: [], why: `a prompt or agent file changed (${prompts.slice(0, 3).join(', ')}): e2e does not exercise an agent following a prompt, so this lane runs live` };
  if (lane === 'tracker') return { by: [], why: 'the tracker lane is never proven by e2e: a fixture this repo writes shares its assumptions about the tracker' };
  const never = because.filter((f) => any(NEVER_RE, f));
  if (never.length) return { by: [], why: `third-party adapter code changed (${never.slice(0, 3).join(', ')}): never proven by e2e` };
  const by = new Set();
  for (const f of because) {
    const c = coverageOf(root, base, head, f, covers);
    if (!c.by.length) return { by: [], why: c.why };
    c.by.forEach((x) => by.add(x));
  }
  return { by: [...by], why: '' };
}

async function proof(root, baseRef, coversFile) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  let base;
  try { base = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]).trim(); }
  catch { throw new Blocked(`--base ${JSON.stringify(baseRef)} is not a commit in this repo`); }
  const short = git(root, ['rev-parse', '--short', head]).trim();
  const clean = git(root, ['status', '--porcelain', '--untracked-files=normal']).trim() === '';
  if (!clean) return { code: 2, out: { head: short, base: baseRef, clean: false, lanes: {}, error: 'the working tree is not clean: nothing is proven, every lane runs live' } };
  const covers = parseCovers(coversFile);
  const changed = git(root, ['diff', '--name-only', '--no-renames', `${base}..${head}`]).split('\n').filter(Boolean);
  const plan = gate.planLanes(changed);
  const lanes = {};
  const pending = [];
  for (const lane of gate.LANES) {
    const l = plan.lanes[lane];
    if (!l.run) continue;
    if (gate.ALWAYS_ON.includes(lane)) { lanes[lane] = { proven: false, by: [], why: 'setup and the wizard always run live (Q16)' }; continue; }
    if (!l.because.length) { lanes[lane] = { proven: false, by: [], why: 'selected without a changed file of its own' }; continue; }
    const j = judge(root, base, head, lane, l.because, covers);
    if (j.why) { lanes[lane] = { proven: false, by: [], why: j.why }; continue; }
    lanes[lane] = { proven: null, by: j.by, why: '' };
    pending.push(...j.by);
  }
  const results = new Map();
  await Promise.all([...new Set(pending)].map(async (f) => { results.set(f, await runE2e(root, f)); }));
  for (const [lane, v] of Object.entries(lanes)) {
    if (v.proven !== null) continue;
    const bad = v.by.map((f) => results.get(f)).find((r) => !r.ok);
    if (bad) lanes[lane] = { proven: false, by: [], why: bad.why };
    else lanes[lane] = { proven: true, by: v.by, why: `${v.by.join(', ')} passed at ${short} with skipping forbidden` };
  }
  return { code: 0, out: { head: short, base: baseRef, clean: true, lanes } };
}

function parseArgs(argv) {
  const o = { base: null, root: null, covers: path.join(__dirname, 'covers.json') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (['--base', '--root', '--covers'].includes(k)) {
      if (v === undefined || v.startsWith('--')) throw new Blocked(`${k} needs a value. ${USAGE}`);
      o[k.slice(2)] = v; i++;
    } else throw new Blocked(`unknown argument ${JSON.stringify(k)}. ${USAGE}`);
  }
  if (!o.base) throw new Blocked(`--base is required. ${USAGE}`);
  return o;
}

async function main(argv) {
  let res;
  try {
    const o = parseArgs(argv);
    const root = o.root ? path.resolve(o.root) : git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    res = await proof(root, o.base, path.resolve(o.covers));
  } catch (e) {
    if (!(e instanceof Blocked) && !(e && e.code === 'ENOENT') && !(e instanceof SyntaxError)) throw e;
    res = { code: 2, out: { head: null, clean: false, lanes: {}, error: String(e.message) } };
  }
  process.stdout.write(JSON.stringify(res.out) + '\n');
  const on = Object.entries(res.out.lanes || {});
  process.stderr.write(`proof: ${res.out.error || on.map(([l, v]) => `${l} ${v.proven ? 'PROVEN' : 'live'}`).join(', ') || 'no lane selected'}\n`);
  return res.code;
}

module.exports = { spansOf, parseCovers, hunksOf, NEVER, PROMPTS };

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
