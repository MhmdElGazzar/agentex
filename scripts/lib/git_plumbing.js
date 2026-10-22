'use strict';
// AgenTeX git plumbing — every git call behind the consumer secret scan
// (scripts/secret_scan.js) and the pre-commit hook installer
// (scripts/lib/precommit_hook.js), in one place.
//
// Read-only by construction: plumbing commands only, GIT_OPTIONAL_LOCKS=0 (no
// opportunistic index refresh), never `git status`, never a write. The process
// environment is inherited as-is — inside a pre-commit hook git exports
// GIT_INDEX_FILE (the temporary index of `commit -a` / `commit <paths>`) and may
// export GIT_DIR, and both must keep pointing where git meant. So: no `-C`, and
// the caller's cwd is only used when no such variable is set (gitCwd below).
//
// Errors carry a fixed vocabulary (`code` + a fixed message), never git's raw
// stderr: a remote URL or a path in that text could carry a credential.
const { spawnSync } = require('child_process');
const path = require('path');

const ERRORS = {
  'git-missing': 'git was not found on this machine - install git first',
  'not-a-git-repository': 'this folder is not inside a git repository - run git init first',
  'git-failed': 'a git command failed unexpectedly',
};

class GitError extends Error {
  constructor(code) { super(ERRORS[code] || ERRORS['git-failed']); this.code = code in ERRORS ? code : 'git-failed'; }
}

// Under a hook git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE, possibly as
// paths relative to the directory it started the hook in — the process cwd.
// Running git anywhere else would point those at the wrong repository or index.
function gitCwd(dir) {
  const e = process.env;
  if (e.GIT_DIR || e.GIT_INDEX_FILE || e.GIT_WORK_TREE) return process.cwd();
  return dir || process.cwd();
}

function run(dir, args, { input, okCodes = [0] } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: gitCwd(dir),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    input,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw new GitError(r.error.code === 'ENOENT' ? 'git-missing' : 'git-failed');
  if (!okCodes.includes(r.status)) {
    const err = new GitError('git-failed');
    err.status = r.status;
    throw err;
  }
  return { status: r.status, stdout: r.stdout };
}

const text = (buf) => buf.toString('utf8');
const trimEol = (s) => s.replace(/\r?\n$/, '');

// Repository facts for the directory the caller works in.
function repoInfo(dir) {
  let inside;
  try { inside = trimEol(text(run(dir, ['rev-parse', '--is-inside-work-tree']).stdout)) === 'true'; }
  catch (e) { if (e.code === 'git-missing') throw e; inside = false; }
  if (!inside) throw new GitError('not-a-git-repository');
  const toplevel = path.resolve(trimEol(text(run(dir, ['rev-parse', '--show-toplevel']).stdout)));
  const prefix = trimEol(text(run(dir, ['rev-parse', '--show-prefix']).stdout));
  return { toplevel, prefix };
}

// What staged mode diffs against: HEAD, or — before the first commit — the empty
// tree, computed (never hard-coded) so SHA-256 repositories stay correct.
function diffBase(dir) {
  const head = run(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okCodes: [0, 1] });
  if (head.status === 0) return trimEol(text(head.stdout));
  return trimEol(text(run(dir, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).stdout));
}

// This commit's delta: added, modified or type-changed index entries relative to
// `against`, each with its destination mode and blob sha. Paths are repo-relative.
function stagedEntries(dir, against) {
  const out = text(run(dir, ['diff-index', '--cached', '-z', '--raw', '--no-renames',
    '--diff-filter=AMT', against, '--']).stdout);
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(':')) break;
    const [, dstMode, , dstSha] = meta.slice(1).split(' ');
    entries.push({ path: parts[i + 1], mode: dstMode, sha: dstSha });
  }
  return entries;
}

// Every index path of the whole repository. Stage-0 entries carry mode + sha;
// an unmerged path appears once with sha null (read from the working tree).
function trackedEntries(dir) {
  const out = text(run(dir, ['ls-files', '-z', '-s', '--full-name', '--', ':/']).stdout);
  const seen = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (stage === '0') seen.set(p, { path: p, mode, sha });
    else if (!seen.has(p)) seen.set(p, { path: p, mode, sha: null, unmerged: true });
  }
  return [...seen.values()];
}

// sha → size, for the given blob shas (missing objects are absent from the map).
function blobSizes(dir, shas) {
  const sizes = new Map();
  const uniq = [...new Set(shas.filter(Boolean))];
  if (!uniq.length) return sizes;
  const out = text(run(dir, ['cat-file', '--batch-check'], { input: uniq.join('\n') + '\n' }).stdout);
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]+) blob (\d+)$/);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  return sizes;
}

// sha → Buffer, one `cat-file --batch` process for all of them.
function readBlobs(dir, shas) {
  const blobs = new Map();
  const uniq = [...new Set(shas.filter(Boolean))];
  if (!uniq.length) return blobs;
  const buf = run(dir, ['cat-file', '--batch'], { input: uniq.join('\n') + '\n' }).stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.slice(pos, nl).toString('utf8');
    const m = header.match(/^([0-9a-f]+) (\w+) (\d+)$/);
    if (!m) { pos = nl + 1; continue; }              // "<sha> missing"
    const size = Number(m[3]);
    if (m[2] === 'blob') blobs.set(m[1], buf.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

// Every remote.<name>.url / pushurl in every config scope. The URL stays in
// memory for the caller's credential check and must never be printed.
function remoteUrls(dir) {
  const r = run(dir, ['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { okCodes: [0, 1] });
  if (r.status === 1) return [];
  const list = [];
  for (const rec of text(r.stdout).split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const url = nl < 0 ? '' : rec.slice(nl + 1);
    const m = key.match(/^remote\.(.*)\.(url|pushurl)$/i);
    if (m) list.push({ remote: m[1], field: m[2].toLowerCase(), url });
  }
  return list;
}

function configGet(dir, scopeArgs) {
  const r = run(dir, ['config', ...scopeArgs, '--path', '--get', 'core.hooksPath'], { okCodes: [0, 1, 128, 129] });
  if (r.status !== 0) return null;
  const v = trimEol(text(r.stdout));
  return v === '' ? null : v;
}

// core.hooksPath with its scope: 'local' (this repository or this worktree) or
// 'global' (machine-wide: global or system config). null when unset. Works on
// git versions without --show-scope.
function hooksPathConfig(dir) {
  const effective = configGet(dir, []);
  if (effective === null) return null;
  if (configGet(dir, ['--local']) !== null || configGet(dir, ['--worktree']) !== null) {
    return { value: effective, scope: 'local' };
  }
  return { value: effective, scope: 'global' };
}

// The default hooks directory, absolute — the common directory's for a linked worktree.
function defaultHooksDir(dir) {
  const p = trimEol(text(run(dir, ['rev-parse', '--git-path', 'hooks']).stdout));
  return path.resolve(gitCwd(dir), p);
}

module.exports = {
  GitError, ERRORS,
  repoInfo, diffBase, stagedEntries, trackedEntries, blobSizes, readBlobs,
  remoteUrls, hooksPathConfig, defaultHooksDir,
};
