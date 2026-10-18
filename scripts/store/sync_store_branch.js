#!/usr/bin/env node
'use strict';
// Store-branch sync — builds the `store` branch that the Claude plugin directory follows.
//
// The directory validates the whole plugin folder (here, the repository root). Two things
// on main trip it: more than 512 files holds every version for a manual review, and the
// root .gitattributes (eol=lf rewrites file contents on checkout) stops validation with
// "Couldn't validate that repository". The store branch is main's tree minus the paths
// the installed plugin never uses (STORE_EXCLUDES). Main itself is never touched.
//
// Each sync is a new commit whose parent is the current store head, so the branch moves
// fast-forward only; anything pushed to store by hand makes the push fail instead of
// being overwritten. Built in a throwaway index — the working tree and index are untouched.
//
// Usage: node scripts/store/sync_store_branch.js [--source <ref>] [--parent <ref>] [--push <remote>]
//   --source  the tree to publish (default HEAD)
//   --parent  the current store head (default <remote>/store, else origin/store, when it exists)
//   --push    push the new commit to <remote>'s store branch
// Output: one JSON line {ok, changed, commit, files, source, pushed}. Exit 0 ok · 1 over
// the file limit (nothing pushed) · 2 usage/git error.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_BRANCH = 'store';
const FILE_LIMIT = 512;
// Pathspecs removed from the published tree. Everything else ships.
const STORE_EXCLUDES = [
  'evals',                // behavioral evals for `claude plugin eval` — development only
  ':(glob)**/*.test.js',  // unit tests
  '.github',              // CI, including the workflow that runs this script
  '.gitattributes',       // eol=lf rewrites contents on checkout; directory validation stops on it
  'scripts/store',        // this script
];

function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function resolveCommit(cwd, ref) {
  try { return git(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); } catch { return null; }
}

function buildStoreCommit({ cwd = process.cwd(), source = 'HEAD', parent = null } = {}) {
  const sourceSha = resolveCommit(cwd, source);
  if (!sourceSha) throw new Error(`unknown --source ref: ${source}`);
  const parentSha = parent ? resolveCommit(cwd, parent) : null;
  if (parent && !parentSha) throw new Error(`unknown --parent ref: ${parent}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-store-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    git(cwd, ['read-tree', sourceSha], env);
    git(cwd, ['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', ...STORE_EXCLUDES], env);
    const files = git(cwd, ['ls-files'], env).split('\n').filter(Boolean).length;
    const tree = git(cwd, ['write-tree'], env);
    if (parentSha && git(cwd, ['rev-parse', `${parentSha}^{tree}`]) === tree) {
      return { changed: false, commit: parentSha, files, source: sourceSha };
    }
    const message = `store: sync from main ${sourceSha.slice(0, 7)}\n\n`
      + `main's tree minus development-only paths (scripts/store/sync_store_branch.js).\n`
      + `Source: ${sourceSha}`;
    const commit = git(cwd, ['commit-tree', tree, ...(parentSha ? ['-p', parentSha] : []), '-m', message]);
    return { changed: true, commit, files, source: sourceSha };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!['source', 'parent', 'push'].includes(key) || argv[i + 1] === undefined) {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
    out[key] = argv[++i];
  }
  return out;
}

function main() {
  const cwd = process.cwd();
  let res;
  try {
    const args = parseArgs(process.argv.slice(2));
    const remote = args.push || 'origin';
    const parent = args.parent
      || (resolveCommit(cwd, `refs/remotes/${remote}/${STORE_BRANCH}`) ? `${remote}/${STORE_BRANCH}` : null);
    res = buildStoreCommit({ cwd, source: args.source || 'HEAD', parent });
    if (res.files > FILE_LIMIT) {
      console.log(JSON.stringify({ ok: false, ...res, pushed: false,
        reason: `store tree has ${res.files} files; the directory limit is ${FILE_LIMIT} — add paths to STORE_EXCLUDES` }));
      process.exitCode = 1;
      return;
    }
    let pushed = false;
    if (args.push && res.changed) {
      git(cwd, ['push', '-q', args.push, `${res.commit}:refs/heads/${STORE_BRANCH}`]);
      pushed = true;
    }
    console.log(JSON.stringify({ ok: true, ...res, pushed }));
  } catch (e) {
    const detail = (e.stderr && String(e.stderr).trim()) || e.message;
    console.log(JSON.stringify({ ok: false, reason: detail }));
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { buildStoreCommit, STORE_EXCLUDES, STORE_BRANCH, FILE_LIMIT };
