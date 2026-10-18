#!/usr/bin/env node
'use strict';
// Host build — turns main (the Claude Code plugin, the only source) into one host's
// plugin tree and publishes it as that host's branch. One workflow runs this per host
// on every push to main (.github/workflows/hosts.yml); hosts/<host>/host.json says how.
//
// Pipeline: export the source commit's tree → drop dev-only paths (COMMON_EXCLUDES +
// the host's `exclude`) → run the host's `transforms` (transforms.js) → copy
// hosts/<host>/overlay/ on top → run the host's `guards` (guards.js). Any finding
// fails the build and nothing is published.
//
// Everything happens in git objects and a throwaway index: the working tree, the index
// and HEAD are never touched. Each build is a new commit whose parent is the target's
// current head, so the target only fast-forwards — a hand edit on the target makes the
// push fail instead of being overwritten. An unchanged tree makes no commit. With
// `tag` set, the first build of each plugin version also pushes `<host>-v<version>`,
// because stores that pin a tag or sha (Copilot, Devin) need one.
//
// Usage: node scripts/hosts/build_host.js --host <name> [--source <ref>] [--parent <ref>]
//          [--push <remote>] [--list]
//   --source  the commit to build (default HEAD)
//   --parent  the target's current head (default <remote>/<target branch>, when it exists)
//   --push    publish the commit (and tag) to <remote>; omit for a dry run
//   --list    also print the built tree's paths, one per line, after the JSON line
// Output: one JSON line {ok, host, target, changed, commit, files, source, version,
// pushed, tagged, findings}. Exit 0 ok · 1 guard findings (nothing pushed) · 2 usage/git.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyTransforms, matcher, text } = require('./transforms.js');
const { runGuards } = require('./guards.js');

// Never shipped by any host: evals, unit tests, CI, the line-ending pin (directory
// validation stops on a root .gitattributes) and the host build machinery itself.
const COMMON_EXCLUDES = ['evals', '**/*.test.js', '.github', '.gitattributes', 'hosts', 'scripts/hosts'];

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd, env: { ...process.env, ...opts.env }, input: opts.input,
    maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const gitText = (cwd, args, opts) => git(cwd, args, opts).toString('utf8').trim();

function resolveCommit(cwd, ref) {
  try { return gitText(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); } catch { return null; }
}

function readHostConfig(cwd, sourceSha, host) {
  if (!/^[a-z0-9-]+$/.test(host)) throw new Error(`invalid host name: ${host}`);
  let raw;
  try { raw = gitText(cwd, ['show', `${sourceSha}:hosts/${host}/host.json`]); }
  catch { throw new Error(`unknown host "${host}": no hosts/${host}/host.json in ${sourceSha.slice(0, 7)}`); }
  const config = JSON.parse(raw);
  if (!config.target || !config.target.branch) throw new Error(`hosts/${host}/host.json: target.branch is required`);
  return config;
}

// ls-tree entries → Map<path, {mode, sha, buf}>, contents read in one cat-file pass.
function readTree(cwd, sourceSha) {
  const entries = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', sourceSha]).toString('utf8')
    .split('\0').filter(Boolean).map((line) => {
      const [meta, p] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
      const [mode, type, sha] = meta.split(' ');
      if (type !== 'blob') throw new Error(`unsupported tree entry (${type}) at ${p}`);
      return { mode, sha, path: p };
    });
  const shas = [...new Set(entries.map((e) => e.sha))];
  const out = git(cwd, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n` });
  const blobs = new Map();
  for (let pos = 0; pos < out.length;) {
    const nl = out.indexOf(10, pos);
    const [sha, type, size] = out.subarray(pos, nl).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`cannot read blob ${sha} (${type})`);
    blobs.set(sha, out.subarray(nl + 1, nl + 1 + Number(size)));
    pos = nl + 1 + Number(size) + 1;
  }
  return new Map(entries.map((e) => [e.path, { mode: e.mode, sha: e.sha, buf: blobs.get(e.sha) }]));
}

// The whole pipeline, in memory. Returns the host tree plus guard findings.
function buildTree({ cwd = process.cwd(), source = 'HEAD', host }) {
  const sourceSha = resolveCommit(cwd, source);
  if (!sourceSha) throw new Error(`unknown --source ref: ${source}`);
  const config = readHostConfig(cwd, sourceSha, host);
  const files = readTree(cwd, sourceSha);
  const claude = files.get('.claude-plugin/plugin.json');
  const version = claude ? JSON.parse(text(claude)).version : undefined;

  const overlayPrefix = `hosts/${host}/overlay/`;
  const overlay = [...files].filter(([p]) => p.startsWith(overlayPrefix))
    .map(([p, f]) => [p.slice(overlayPrefix.length), f]);
  const drop = matcher([...COMMON_EXCLUDES, ...(config.exclude || [])]);
  for (const p of [...files.keys()]) if (drop(p)) files.delete(p);

  applyTransforms(files, config.transforms, { host, label: config.label || host, version });
  for (const [p, f] of overlay) files.set(p, f);
  const findings = runGuards(files, config.guards);
  return { files, findings, config, version, sourceSha };
}

// Write the tree as a commit on top of `parentSha` (no commit when nothing changed).
function commitTree(cwd, files, { parentSha, message }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-host-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const lines = [];
    for (const [p, f] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sha = f.sha || gitText(cwd, ['hash-object', '-w', '--stdin'], { input: f.buf });
      lines.push(`${f.mode} ${sha}\t${p}\0`);
    }
    git(cwd, ['update-index', '-z', '--index-info'], { env, input: lines.join('') });
    const tree = gitText(cwd, ['write-tree'], { env });
    if (parentSha && gitText(cwd, ['rev-parse', `${parentSha}^{tree}`]) === tree) {
      return { changed: false, commit: parentSha };
    }
    const commit = gitText(cwd, ['commit-tree', tree, ...(parentSha ? ['-p', parentSha] : []), '-m', message]);
    return { changed: true, commit };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function buildHostCommit({ cwd = process.cwd(), source = 'HEAD', host, parent = null }) {
  const built = buildTree({ cwd, source, host });
  const base = {
    host, target: built.config.target.branch, files: built.files.size,
    source: built.sourceSha, version: built.version, findings: built.findings,
  };
  if (built.findings.length) return { ok: false, ...base };
  const parentSha = parent ? resolveCommit(cwd, parent) : null;
  if (parent && !parentSha) throw new Error(`unknown --parent ref: ${parent}`);
  const message = `${host}: build from main ${built.sourceSha.slice(0, 7)}\n\n`
    + `Generated by scripts/hosts/build_host.js from hosts/${host}/host.json. Do not edit this branch by hand.\n`
    + `Source: ${built.sourceSha}`;
  const res = commitTree(cwd, built.files, { parentSha, message });
  return { ok: true, ...base, ...res, config: built.config };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'list') { out.list = true; continue; }
    if (!['host', 'source', 'parent', 'push'].includes(key) || argv[i + 1] === undefined) {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
    out[key] = argv[++i];
  }
  if (!out.host) throw new Error('--host <name> is required');
  return out;
}

function main() {
  const cwd = process.cwd();
  try {
    const args = parseArgs(process.argv.slice(2));
    const remote = args.push || 'origin';
    const sourceSha = resolveCommit(cwd, args.source || 'HEAD');
    if (!sourceSha) throw new Error(`unknown --source ref: ${args.source || 'HEAD'}`);
    const branch = readHostConfig(cwd, sourceSha, args.host).target.branch;
    const parent = args.parent
      || (resolveCommit(cwd, `refs/remotes/${remote}/${branch}`) ? `${remote}/${branch}` : null);
    const res = buildHostCommit({ cwd, source: sourceSha, host: args.host, parent });
    const { config, ...report } = res;
    let pushed = false; let tagged = null;
    if (res.ok && args.push && config.publish !== false) {
      if (res.changed) {
        git(cwd, ['push', '-q', remote, `${res.commit}:refs/heads/${branch}`]);
        pushed = true;
      }
      if (config.tag && res.version) {
        const tag = config.tag.replace('{version}', res.version);
        if (!gitText(cwd, ['ls-remote', '--tags', remote, `refs/tags/${tag}`])) {
          git(cwd, ['push', '-q', remote, `${res.commit}:refs/tags/${tag}`]);
          tagged = tag;
        }
      }
    }
    const publishNote = res.ok && args.push && config.publish === false ? { reason: 'publish is off for this host' } : {};
    console.log(JSON.stringify({ ...report, pushed, tagged, ...publishNote }));
    if (args.list && res.ok) {
      console.log(gitText(cwd, ['ls-tree', '-r', '--name-only', res.commit]));
    }
    process.exitCode = res.ok ? 0 : 1;
  } catch (e) {
    const detail = (e.stderr && String(e.stderr).trim()) || e.message;
    console.log(JSON.stringify({ ok: false, reason: detail }));
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { buildTree, buildHostCommit, readHostConfig, COMMON_EXCLUDES };
