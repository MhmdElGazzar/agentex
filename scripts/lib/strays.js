'use strict';
// AgenTeX stray-files check — the part of /update-agentex that lists files sitting outside
// the project layout (scripts/lib/layout.js) and, only behind the user's explicit yes, moves
// exactly the listed set. Never a migration: migrate.js calls engineLines() before the
// version fast path, so it runs on every invocation, and it never touches the report
// counters, so it can never withhold the stamp.
//
// Report-only by default: paths only, grouped, zero writes. No file content is ever read
// for output (invariant #5). What is a candidate (project-layout-contract R4.1):
//   1. litter, anywhere outside protected subtrees: probe-*, explore-*, …, or any file in a
//      folder named tmp/temp/scratch (dotted or not);
//   2. root-level files that are neither allowlisted nor plugin-defined — data dumps and
//      agent scripts are litter, anything else is unplaced;
//   3. anything under .agentex/ that is not plugin-defined;
//   4. any file in a configured qaRecords folder that is not itself a configured file.
// Excluded first: OS metadata, protected paths, plugin-defined paths (and their transient
// .lock/.tmp siblings), and every path the project's own ignore rules match (untracked and
// tracked-but-ignored). Folders the user created at the root are not scanned except for
// class-1 litter. Symlinks are listed as never moved and never followed; gitlinks skipped.
//
// Litter is proposed to .agentex/scratch/strays/<run>/; unplaced files get no proposal
// (the agent may propose knowledge/ for a whole Markdown file of settled facts).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const layout = require('./layout.js');

const MAX_LISTED = 500;        // printed paths (tunable, Q8); counts and digest cover the full set
const STRAYS_DIR = '.agentex/scratch/strays';

const git = (root, args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const z = (out) => out.split('\0').filter(Boolean);

// Pattern labels, in match order (the group a litter file is counted under).
const NAME_LABELS = ['probe-*', 'explore-*', 'recon-*', 'scratch-*', 'tmp-*', 'temp-*', '.tmp-*',
  '.scratch_*', '.scratch-*', '*-out.txt', '*.out.txt', '*.tmp'];

const under = (p, entry) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry);

function isProtected(p) {
  return layout.PROTECTED.some((e) => under(p, e)) || layout.PROTECTED_RE.some((re) => re.test(p));
}

// The project's files: tracked (with their mode) + untracked, minus everything its ignore
// rules match. Paths are project-relative POSIX.
function sourceList(projectRoot) {
  const tracked = new Map();
  for (const line of z(git(projectRoot, ['ls-files', '-z', '--cached', '-s']))) {
    const tab = line.indexOf('\t');
    tracked.set(line.slice(tab + 1), line.split(' ')[0]);
  }
  const ignored = new Set(z(git(projectRoot, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'])));
  const untracked = z(git(projectRoot, ['ls-files', '-z', '--others', '--exclude-standard']))
    .filter((p) => !p.endsWith('/')); // a nested repository
  const out = [];
  for (const [p, mode] of tracked) {
    if (mode === '160000' || ignored.has(p)) continue; // gitlink; ignored by the project
    out.push({ path: p, tracked: true });
  }
  for (const p of untracked) if (!tracked.has(p)) out.push({ path: p, tracked: false });
  return out;
}

// Classify one path: null (not a candidate) or { class, group }.
function classify(p, ctx) {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  if (layout.OS_METADATA.includes(base)) return null;
  if (isProtected(p)) return null;
  if (ctx.defined.some((e) => under(p, e))) return null;
  if (ctx.definedFiles.some((f) => p === `${f}.lock` || p === `${f}.tmp`)) return null;
  // 1. litter by name, then by folder
  const nameHit = layout.LITTER_NAMES.findIndex((re) => re.test(base));
  if (nameHit !== -1) return { class: 'litter', group: NAME_LABELS[nameHit] };
  const dirIdx = parts.slice(0, -1).findIndex((s) => layout.LITTER_DIRS.includes(s));
  if (dirIdx !== -1) return { class: 'litter', group: 'temp folders', folder: `${parts.slice(0, dirIdx + 1).join('/')}/` };
  // 2. root-level files
  if (parts.length === 1) {
    if (layout.ROOT_ALLOWLIST.some((re) => re.test(base))) return null;
    if (layout.ROOT_DUMP.test(base)) return { class: 'litter', group: 'root data dumps' };
    if (layout.ROOT_SCRIPT.test(base)) return { class: 'litter', group: 'root scripts' };
    return { class: 'unplaced' };
  }
  // 3. undefined .agentex/ entries
  if (parts[0] === '.agentex') return { class: 'unplaced' };
  // 4. files the user put beside the configured QA watchlist files
  if (ctx.qaFolders.includes(parts.slice(0, -1).join('/'))) return { class: 'unplaced' };
  return null; // a user folder at the root: user-owned
}

// listStrays → { candidates: [{ path, tracked, class: 'litter'|'unplaced'|'symlink', group? }], notes }
function listStrays(projectRoot, { routes } = {}) {
  const { paths: defined, notes, qaRecords } = layout.definedPaths(projectRoot, { routes });
  const configured = Object.values(qaRecords).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  const ctx = {
    defined,
    definedFiles: defined.filter((e) => !e.endsWith('/')),
    qaFolders: [...new Set(configured.map((p) => path.posix.dirname(p)).filter((d) => d !== '.'))],
  };
  const candidates = [];
  for (const f of sourceList(projectRoot)) {
    const c = classify(f.path, ctx);
    if (!c) continue;
    let st;
    try { st = fs.lstatSync(path.join(projectRoot, f.path)); } catch { continue; } // deleted in the work tree
    if (st.isSymbolicLink()) candidates.push({ path: f.path, tracked: f.tracked, class: 'symlink' });
    else candidates.push({ path: f.path, tracked: f.tracked, ...c });
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { candidates, notes };
}

// sha256/12 over the sorted litter source paths — what an explicit yes approves.
function planDigest(litterPaths) {
  return crypto.createHash('sha256').update([...litterPaths].sort().join('\n')).digest('hex').slice(0, 12);
}

const tag = (c) => `${c.path}${c.tracked ? ' (tracked)' : ''}`;

function countsLine(litter) {
  const groups = new Map();
  for (const c of litter) {
    const g = groups.get(c.group) || { n: 0, folders: new Set() };
    g.n++; if (c.folder) g.folders.add(c.folder);
    groups.set(c.group, g);
  }
  return [...groups].map(([label, g]) => (label === 'temp folders'
    ? `temp folders ×${g.folders.size} (${g.n} file${g.n === 1 ? '' : 's'})` : `${label} ×${g.n}`)).join(' · ');
}

function listed(items, max) {
  const lines = items.slice(0, max).map((c) => `[stray]     ${tag(c)}`);
  if (items.length > max) lines.push(`[stray]     … and ${items.length - max} more`);
  return lines;
}

// The report (no consent flag): paths only, grouped, zero writes.
function reportLines(projectRoot, { routes, maxListed = MAX_LISTED } = {}) {
  const { candidates, notes } = listStrays(projectRoot, { routes });
  const lines = notes.map((n) => `[stray] note ${n}`);
  if (!candidates.length) return [...lines, '[stray] none — every file is where the layout puts it'];
  const litter = candidates.filter((c) => c.class === 'litter');
  const unplaced = candidates.filter((c) => c.class === 'unplaced');
  const links = candidates.filter((c) => c.class === 'symlink');
  lines.push(`[stray] ${candidates.length} file${candidates.length === 1 ? '' : 's'} outside the project layout (paths only; nothing was moved)`);
  if (litter.length) {
    lines.push(`[stray] litter → ${STRAYS_DIR}/<this run>/ (same relative paths):`);
    lines.push(`[stray]   ${countsLine(litter)}`);
    lines.push(...listed(litter, maxListed));
    const tracked = litter.filter((c) => c.tracked).length;
    if (tracked) lines.push(`[stray]   ${tracked} tracked: an approved move leaves their removal for the user to commit`);
  }
  if (unplaced.length) {
    lines.push('[stray] no destination proposed (listed only):');
    lines.push(...listed(unplaced, maxListed));
  }
  if (links.length) {
    lines.push('[stray] symlinks (listed only; never moved, never followed):');
    lines.push(...listed(links, maxListed));
  }
  if (litter.length || unplaced.some((c) => /\.md$/i.test(c.path))) {
    const d = planDigest(litter.map((c) => c.path));
    lines.push(`[stray] plan ${d} — ask the user once; only on an explicit yes, re-run with --move-strays=${d}`);
  }
  return lines;
}

// What migrate.js prints in its pre-fast-path slot.
function engineLines(projectRoot, { flagArgs = [], routes, maxListed } = {}) {
  return reportLines(projectRoot, { routes, maxListed });
}

module.exports = { MAX_LISTED, STRAYS_DIR, listStrays, planDigest, reportLines, engineLines };
