#!/usr/bin/env node
'use strict';
// AgenTeX consumer secret scan — is this project safe to commit and push?
//
//   node scripts/secret_scan.js (--staged | --tracked) [--project <dir>] [--hook]
//                               [--max-file-bytes <n>] [--min-value-length <n>]
//                               [--min-labeled-value-length <n>]
//
//   --staged   exactly what the next commit carries (this commit's delta, read from
//              the index — the pre-commit hook's mode)
//   --tracked  every file git tracks (working-tree copy; the index blob when absent)
//   --project  the AgenTeX project folder (default: the current directory); its .env,
//              config/project.json, environments/ and integration/ are read from there
//   --hook     the pre-commit hook's mode: "commit REFUSED" wording, and the
//              credential-shape confirmation (below)
//   The three numeric flags override the tunable defaults (1 MiB file cap, 8-char
//   substring cut-off, 4-char label-check floor) — for tests and tuning.
//
// Checks (the same in both modes): the project's own secret values in a file, a
// short known value right after a password label, .env in the index, a credential
// in a remote URL — each a LEAK; a plain string in a secret-capable field of
// environments/*.json or integration/**/*.json, and a public credential shape
// (private-key block, GitHub, AWS, Atlassian, Figma token) in any file or in a
// remote URL's user part — warnings, never a block on their own. The shape check
// runs with or without .env.
//
// The confirmation (--hook only): when nothing is a leak and at least one warning
// is a credential shape, and an interactive terminal can be opened (/dev/tty;
// CONIN$/CONOUT$ on Windows), the warnings are shown and the user is asked
// "Continue the commit anyway? [y/N]" (default No). No → exit 1 with
// "result":"LEAK" and "reason":"declined" (the contract installed hooks already
// honour). Yes, or no terminal (IDE commit button, CI) → exit 0 with the warnings.
// Test seam: AGENTEX_SECRET_SCAN_TTY=none (no terminal) or =<file> (the answer is
// that file's first line; the question goes to stderr).
//
// Output: exactly ONE JSON line on stdout; a human summary on stderr. Exit 0
// clean/warnings/skipped, 1 leak (or a declined confirmation), 2 could not run.
// Values are never printed — only file, line and key/field/label/pattern names, and
// a remote's name. Read-only: no file, index or config write. The installed
// pre-commit hook relies on this file's name, --staged, --project, --hook and the
// "result":"LEAK" marker — a stable contract.
const fs = require('fs');
const path = require('path');
const core = require('./lib/secret_scan_core.js');
const gp = require('./lib/git_plumbing.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(PLUGIN_ROOT, 'docs', 'putting-your-project-in-git.md');
const USAGE = 'usage: secret_scan.js (--staged | --tracked) [--project <dir>] [--hook] [--max-file-bytes <n>] [--min-value-length <n>] [--min-labeled-value-length <n>]';

let emitted = false;
function emit(result) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.exit;
}

function parseArgs(argv) {
  const o = { mode: null, project: null, hook: false, maxFileBytes: core.DEFAULTS.MAX_FILE_BYTES,
    minValueLength: core.DEFAULTS.MIN_VALUE_LENGTH, minLabeledValueLength: core.DEFAULTS.MIN_LABELED_VALUE_LENGTH };
  const nums = { '--max-file-bytes': 'maxFileBytes', '--min-value-length': 'minValueLength', '--min-labeled-value-length': 'minLabeledValueLength' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged' || a === '--tracked') {
      if (o.mode) return null;
      o.mode = a.slice(2);
    } else if (a === '--hook') o.hook = true;
    else if (a === '--project') {
      if (i + 1 >= argv.length) return null;
      o.project = argv[++i];
    } else if (nums[a]) {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) return null;
      o[nums[a]] = Number(v);
    } else return null;
  }
  return o.mode ? o : null;
}

const posix = (p) => p.split(path.sep).join('/');
function realOr(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function readTextOrNull(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function parseQuiet(text) { try { return JSON.parse(String(text).replace(/^﻿/, '')); } catch { return null; } }

// envSecret sources: config/project.json, environments/*.json, integration/**/*.json
function isConfigLike(rel) {
  return rel === 'config/project.json' || /^environments\/[^/]+\.json$/i.test(rel) || /^integration\/.+\.json$/i.test(rel);
}
function fieldKindOf(rel) {
  if (/^environments\/[^/]+\.json$/i.test(rel)) return 'environment';
  if (/^integration\/.+\.json$/i.test(rel)) return 'catalog';
  return null;
}
function walkConfigFiles(projectDir) {
  const out = [];
  const add = (f) => { if (fs.existsSync(f)) out.push(f); };
  add(path.join(projectDir, 'config', 'project.json'));
  try {
    for (const f of fs.readdirSync(path.join(projectDir, 'environments'))) if (/\.json$/i.test(f)) out.push(path.join(projectDir, 'environments', f));
  } catch { /* none */ }
  (function walk(d) {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else if (e.isFile() && /\.json$/i.test(e.name)) out.push(full);
    }
  })(path.join(projectDir, 'integration'));
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) { emit(core.errorResult(null, 'usage', USAGE)); process.stderr.write(USAGE + '\n'); return; }
  const { mode } = opts;
  const projectDir = path.resolve(process.cwd(), opts.project === null ? '.' : opts.project);

  let info;
  try { info = gp.repoInfo(projectDir); }
  catch (e) { return fail(mode, e.code === 'git-missing' ? 'git-missing' : 'not-a-git-repository'); }
  const relProject = posix(path.relative(realOr(info.toplevel), realOr(projectDir)));
  if (relProject.startsWith('..') || path.isAbsolute(relProject)) return fail(mode, 'not-a-git-repository');
  const prefix = relProject === '' ? '' : relProject + '/';
  const top = info.toplevel;

  // ── File list ────────────────────────────────────────────────────────────
  const index = gp.trackedEntries(projectDir);
  const entries = mode === 'staged' ? gp.stagedEntries(projectDir, gp.diffBase(projectDir)) : index;
  const counts = { filesConsidered: entries.length, filesScanned: 0, skipped: { binary: 0, oversize: 0, symlink: 0, submodule: 0 } };
  const envRel = prefix + '.env';
  const items = [];     // { rel, sha?, wt? }
  for (const e of entries) {
    if (e.mode === '120000') { counts.skipped.symlink++; continue; }
    if (e.mode === '160000') { counts.skipped.submodule++; continue; }
    if (e.path === envRel) continue;   // reported structurally, never value-scanned
    if (mode === 'staged') { items.push({ rel: e.path, sha: e.sha }); continue; }
    const full = path.join(top, ...e.path.split('/'));
    let st = null;
    try { st = fs.lstatSync(full); } catch { /* absent on disk */ }
    if (st && st.isSymbolicLink()) { counts.skipped.symlink++; continue; }
    if (st && st.isFile()) items.push({ rel: e.path, wt: full, size: st.size });
    else if (!st && e.sha) items.push({ rel: e.path, sha: e.sha });
  }
  const sizes = gp.blobSizes(projectDir, items.filter(it => it.sha).map(it => it.sha));
  for (const it of items) if (it.sha) it.size = sizes.has(it.sha) ? sizes.get(it.sha) : 0;
  const small = items.filter(it => {
    if (it.size > opts.maxFileBytes) { counts.skipped.oversize++; return false; }
    return true;
  });
  const blobs = gp.readBlobs(projectDir, small.filter(it => it.sha).map(it => it.sha));
  const texts = [];
  for (const it of small) {
    let buf;
    if (it.sha) buf = blobs.get(it.sha) || Buffer.alloc(0);
    else { try { buf = fs.readFileSync(it.wt); } catch { continue; } }
    if (core.isBinary(buf)) { counts.skipped.binary++; continue; }
    texts.push({ rel: it.rel, text: buf.toString('utf8') });
  }
  counts.filesScanned = texts.length;

  // ── Needles: the project's own values ────────────────────────────────────
  const inProject = (rel) => (rel.startsWith(prefix) ? rel.slice(prefix.length) : null);
  const configDocs = walkConfigFiles(projectDir).map(f => parseQuiet(readTextOrNull(f))).filter(Boolean);
  const stagedConfigDocs = mode === 'staged'
    ? texts.filter(t => inProject(t.rel) !== null && isConfigLike(inProject(t.rel))).map(t => ({ rel: inProject(t.rel), doc: parseQuiet(t.text) })).filter(x => x.doc)
    : [];
  const envSecretNames = new Set();
  for (const doc of configDocs.concat(stagedConfigDocs.map(x => x.doc))) core.collectEnvSecretNames(doc, envSecretNames);
  const needles = core.buildNeedles({
    envText: readTextOrNull(path.join(projectDir, '.env')),
    envSecretNames: [...envSecretNames],
    canonicalNames: core.canonicalSecretNames(readTextOrNull(path.join(PLUGIN_ROOT, '.env.example'))),
    processEnv: process.env,
    minValueLength: opts.minValueLength,
    minLabeledValueLength: opts.minLabeledValueLength,
  });

  // ── Field table: working-tree + staged copies of config/project.json ────
  const projectConfigs = [parseQuiet(readTextOrNull(path.join(projectDir, 'config', 'project.json')))]
    .concat(stagedConfigDocs.filter(x => x.rel === 'config/project.json').map(x => x.doc));
  const fieldTable = core.secretFieldTable(projectConfigs);

  // ── Scan ─────────────────────────────────────────────────────────────────
  const findings = [];
  for (const t of texts) {
    const rel = inProject(t.rel);
    findings.push(...core.scanFile({ file: t.rel, text: t.text, needles, fieldKind: rel === null ? null : fieldKindOf(rel), fieldTable }));
  }

  // ── Structural checks, every run, both modes ─────────────────────────────
  if (index.some(e => e.path === envRel)) findings.push({ severity: 'leak', kind: 'env-file-tracked', file: envRel });
  const known = new Set(needles.all.map(n => n.value));
  for (const r of gp.remoteUrls(projectDir)) {
    if (core.remoteHasCredential(r.url, known)) findings.push({ severity: 'leak', kind: 'remote-credential', remote: r.remote, field: r.field });
    for (const pattern of core.remoteShapes(r.url)) findings.push({ severity: 'warn', kind: 'credential-shape', remote: r.remote, field: r.field, pattern });
  }

  const result = core.buildResult({ mode, valueCheck: needles.valueCheck, counts, findings });
  process.stderr.write(summary(result, opts, prefix));
  emit(core.shapeConfirmationNeeded({ hook: opts.hook, findings }) ? confirm(result, findings) : result);
}

// ── The --hook confirmation for credential-shape warnings ──────────────────
// The terminal: { inFd, outFd } or null. Never stdin — git gives a hook none.
function openTerminal() {
  const seam = process.env.AGENTEX_SECRET_SCAN_TTY;
  if (seam === 'none') return null;
  try {
    if (seam) return { inFd: fs.openSync(seam, 'r'), outFd: 2 };
    if (process.platform === 'win32') {
      const inFd = fs.openSync('\\\\.\\CONIN$', 'r');
      try { return { inFd, outFd: fs.openSync('\\\\.\\CONOUT$', 'w') }; }
      catch (e) { fs.closeSync(inFd); throw e; }
    }
    const fd = fs.openSync('/dev/tty', 'r+');
    return { inFd: fd, outFd: fd };
  } catch { return null; }
}

// One line from the terminal ('' on end of input or a read error — the default No).
function readAnswer(fd) {
  const buf = Buffer.alloc(256);
  let s = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch { break; }
    if (!n) break;
    s += buf.toString('utf8', 0, n);
    if (s.includes('\n') || s.length > 1024) break;
  }
  return s;
}

function confirm(result, findings) {
  const term = openTerminal();
  if (!term) {
    process.stderr.write('  no terminal to ask in (IDE commit button or CI) - the commit proceeds with the credential-shape warning(s) above.\n');
    return result;
  }
  const shapes = findings.filter(f => f.kind === 'credential-shape');
  const lines = [];
  // the warnings were printed on stderr; repeat them only when stderr is not this terminal
  if (term.outFd !== 2 && !process.stderr.isTTY) for (const f of shapes) lines.push(shapeLine(f));
  lines.push(`AgenTeX secret scan: ${shapes.length} possible credential(s) by shape (value not shown). Continue the commit anyway? [y/N] `);
  let answer = '';
  try {
    fs.writeSync(term.outFd, lines.join('\n'));
    answer = readAnswer(term.inFd);
  } finally {
    for (const fd of new Set([term.inFd, term.outFd])) if (fd !== 2) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
  if (term.outFd === 2) process.stderr.write('\n');
  if (core.confirmAnswerIsYes(answer)) {
    process.stderr.write('  you confirmed - the commit proceeds with the warning(s) above.\n');
    return result;
  }
  process.stderr.write('  commit REFUSED - you answered No (the default). Nothing was committed. Remove the flagged credential(s), then commit again.\n');
  return core.declinedResult(result);
}

function fail(mode, code) {
  const r = core.errorResult(mode, code, gp.ERRORS[code] || 'the scan could not run');
  emit(r);
  process.stderr.write(`AgenTeX secret scan could not run: ${r.message}\n`);
}

// ── Human summary (stderr): fixed text, paths and key names only ───────────
function shapeLine(f) {
  if (f.remote !== undefined) {
    return `  WARN remote "${ascii(f.remote)}" ${f.field} user part looks like a ${f.pattern} - git remote set-url ${ascii(f.remote)} <URL without credentials>, then rotate that token if it is real`;
  }
  return `  WARN ${f.file}:${f.line}  looks like a ${f.pattern} (credential shape, value not shown) - if it is a real credential, remove it, keep it in .env, and rotate it`;
}
const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '?');
function summary(r, opts, prefix) {
  const out = [];
  const L = (s) => out.push(s);
  L(`AgenTeX secret scan (${r.mode}): ${r.result} - ${r.counts.leaks} leak(s), ${r.counts.warnings} warning(s), ${r.counts.filesScanned} file(s) scanned`);
  for (const f of r.findings) {
    switch (f.kind) {
      case 'secret-value':
        L(`  LEAK ${f.file}:${f.line}  the value of ${f.key}${f.field ? ` (in field ${f.field})` : ''}`); break;
      case 'short-value-labeled':
        L(`  LEAK ${f.file}:${f.line}  the value of ${f.key} after a "${f.label}" label${f.field ? ` (field ${f.field})` : ''}`); break;
      case 'env-file-tracked':
        L(`  LEAK ${f.file} is tracked by git - untrack it: git rm --cached ${f.file} , commit, and rotate every value in it if it was ever pushed`); break;
      case 'remote-credential':
        L(`  LEAK remote "${ascii(f.remote)}" ${f.field} carries a credential - git remote set-url ${ascii(f.remote)} <URL without credentials>, then rotate that token`); break;
      case 'plain-secret-field':
        L(`  WARN ${f.file}:${f.line}  ${f.field} holds a plain string - suggested: ${JSON.stringify(f.suggest)} with the value in .env`); break;
      case 'credential-shape':
        L(shapeLine(f)); break;
      case 'unparseable-config':
        L(`  WARN ${f.file} is not valid JSON - plain-string field check skipped for this file (its text was still value-scanned)`); break;
      default: L(`  ${f.severity.toUpperCase()} ${f.kind}`);
    }
  }
  if (r.findingsTruncated) L(`  ... and ${r.findingsTruncated} more finding(s) not listed`);
  const vc = r.valueCheck;
  if (vc.status === 'skipped') {
    const why = { 'no-env-file': `no ${prefix}.env file and no secret in the environment`, 'no-values': `${prefix}.env has no values yet`, 'all-excluded': 'every value is a non-secret config key or too short' }[vc.reason];
    L(`  value check SKIPPED: ${why} - only the structural checks and credential shapes ran (.env tracked, remote URL credentials, plain-string fields, credential shapes)`);
  }
  if (vc.notChecked.shortValue.length) {
    L(`  short values not substring-checked: ${vc.notChecked.shortValue.join(', ')} - checked only right after a password label${vc.labelChecked.length ? '' : ' (too short even for that)'}`);
  }
  if (vc.notChecked.nonSecretKeys.length) {
    L(`  ${vc.notChecked.nonSecretKeys.length} non-secret config key(s) in .env were not value-checked: ${vc.notChecked.nonSecretKeys.join(', ')} - move them to config`);
  }
  if (vc.notChecked.baseUrlKeys.length) {
    L(`  ${vc.notChecked.baseUrlKeys.length} base-URL key(s) in .env not value-checked (not secrets): ${vc.notChecked.baseUrlKeys.join(', ')}`);
  }
  const s = r.counts.skipped;
  if (s.binary || s.oversize || s.symlink || s.submodule) {
    L(`  files skipped: ${s.binary} binary, ${s.oversize} over ${opts.maxFileBytes} bytes, ${s.symlink} symlink, ${s.submodule} submodule`);
  }
  if (r.result === 'LEAK') L(opts.hook ? '  commit REFUSED - nothing was committed. Fix the findings above, then commit again.' : '  this is a leak: fix it before committing or pushing.');
  if (r.result !== 'CLEAN' || vc.status === 'skipped') L(`  how to fix: ${DOCS}#fixing-findings`);
  return out.join('\n') + '\n';
}

try { main(); }
catch {
  if (!emitted) {
    emit(core.errorResult(null, 'scan-failed', 'the scan stopped unexpectedly'));
    process.stderr.write('AgenTeX secret scan could not run: the scan stopped unexpectedly\n');
  }
}
