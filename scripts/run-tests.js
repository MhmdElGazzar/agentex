#!/usr/bin/env node
'use strict';
// Maintainer test runner — every tracked *.test.js, in parallel.
//
//   node scripts/run-tests.js [--filter <substring>] [--concurrency <n>] [--serial] [--require-e2e]
//
//   --filter       run only test files whose repo-relative path contains <substring>
//   --concurrency  how many files run at once (default: the CPU count)
//   --serial       one file at a time (same as --concurrency 1)
//   --require-e2e  set AGENTEX_E2E_REQUIRE=1 for every child (the e2e harness then fails
//                  instead of skipping) and count any skip as a failure
//
// Discovers the test files with `git ls-files` (tracked files only — `git add` a new
// test before it is picked up) in the repo the current directory belongs to, and runs
// each as `node <file>` from that repo's root, exactly as a maintainer would by hand.
// Files in SERIAL_ONLY run one at a time after the parallel pool.
//
// Skip protocol: a file named *.e2e.test.js that exits 77 AND prints a line `SKIP: <reason>`
// is SKIPPED (a browser or dependency this machine lacks), not failed. Exit 77 from any other
// file, or without the SKIP: line, is a failure, so a runner that does not know the protocol
// can never read a skip as a pass. See classify().
//
// Output: a human summary on stderr (one line per failure, one `SKIP <file>: <reason>` line
// per skip, totals incl. the skipped count, wall time) and exactly ONE JSON line on stdout:
//   {ok, total, passed, failed:[{file, exit, tail, reason?}], skipped:[{file, reason}], durationMs}
// where tail is the file's last ~20 output lines (stdout and stderr interleaved); `passed`
// excludes skipped files; total = passed + failed + skipped.
// Exit 0 all passed · 1 any failed · 2 usage or IO error (nothing run).
//
// Maintainer tooling: never shipped by any host (scripts/hosts COMMON_EXCLUDES).
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

// Files that must not share the machine with the rest of the suite (a fixed port, a
// fixed temp path, global state that cannot be made ephemeral). Repo-relative paths,
// run one by one after the pool, in this order. Every entry needs a reason beside it.
const SERIAL_ONLY = [];

const SKIP_EXIT = 77;
const E2E_FILE_RE = /(^|\/)[^/]+\.e2e\.test\.js$/;
const SKIP_LINE_RE = /^SKIP: (.*\S.*)$/m;
const TAIL_LINES = 20;
const KEEP_BYTES = 64 * 1024;   // output kept per file — enough for any 20-line tail
const USAGE = 'usage: run-tests.js [--filter <substring>] [--concurrency <n>] [--serial] [--require-e2e]';

function usageError(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

const cpuCount = () => Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

function parseArgs(argv) {
  const opts = { concurrency: cpuCount(), filter: null, serial: false, requireE2e: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serial') { opts.serial = true; continue; }
    if (a === '--require-e2e') { opts.requireE2e = true; continue; }
    if (a === '--filter' || a === '--concurrency') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw usageError(`${a} needs a value. ${USAGE}`);
      if (a === '--filter') opts.filter = v;
      else {
        if (!/^[0-9]+$/.test(v) || Number(v) < 1) throw usageError(`--concurrency must be a whole number ≥ 1 (got ${JSON.stringify(v)}). ${USAGE}`);
        opts.concurrency = Number(v);
      }
      continue;
    }
    throw usageError(`unknown argument ${JSON.stringify(a)}. ${USAGE}`);
  }
  if (opts.serial) opts.concurrency = 1;
  return opts;
}

// Split the discovered files into the parallel pool and the serial tail (SERIAL_ONLY
// order). Entries naming a file that was not discovered are ignored.
function partition(files, serialOnly) {
  const set = new Set(files);
  const serial = serialOnly.filter((f) => set.has(f));
  const held = new Set(serial);
  return { pool: files.filter((f) => !held.has(f)), serial };
}

function lastLines(text, n) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function discover(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const files = git(['-C', root, 'ls-files', '-z', '--', '*.test.js']).split('\0').filter(Boolean).sort();
  return { root, files };
}

// The verdict for one finished file — shared with scripts/dev/affected.js.
//   result: {file, exit, skipReason?}  →  {status:'passed'} | {status:'failed', reason?} | {status:'skipped', reason}
function classify(result, { requireE2e = false } = {}) {
  if (result.exit === 0) return { status: 'passed' };
  if (result.exit === SKIP_EXIT && E2E_FILE_RE.test(result.file) && result.skipReason) {
    if (requireE2e) return { status: 'failed', reason: `e2e skipped under --require-e2e: ${result.skipReason}` };
    return { status: 'skipped', reason: result.skipReason };
  }
  return { status: 'failed' };
}

function runOne(root, file, extraEnv) {
  return new Promise((resolve) => {
    let out = '';
    const keep = (chunk) => {
      out += chunk;
      if (out.length > KEEP_BYTES * 2) out = out.slice(-KEEP_BYTES);
    };
    let child;
    try {
      child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ file, exit: null, tail: `could not start: ${e.message}` });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', (e) => keep(`\n[run-tests] ${e.message}\n`));
    child.on('close', (code, signal) => {
      const r = { file, exit: code, tail: lastLines(out, TAIL_LINES) };
      const m = out.replace(/\r\n/g, '\n').match(SKIP_LINE_RE);
      if (m) r.skipReason = m[1].trim();
      if (signal) r.signal = signal;
      resolve(r);
    });
  });
}

async function runPool(root, files, concurrency, extraEnv) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      results.push(await runOne(root, file, extraEnv));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(argv) {
  const started = Date.now();
  let opts, found;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`run-tests: ${e.message}\n`);
    emit({ ok: false, error: e.message });
    return 2;
  }
  try {
    found = discover(process.cwd());
  } catch (e) {
    const msg = `could not list test files with git (${(e.stderr || e.message || '').toString().trim().split('\n')[0]})`;
    process.stderr.write(`run-tests: ${msg}\n`);
    emit({ ok: false, error: msg });
    return 2;
  }
  const files = opts.filter ? found.files.filter((f) => f.includes(opts.filter)) : found.files;
  if (!files.length) {
    const msg = opts.filter ? `no tracked *.test.js matches --filter ${JSON.stringify(opts.filter)}` : 'no tracked *.test.js files';
    process.stderr.write(`run-tests: ${msg}\n`);
    emit({ ok: false, error: msg });
    return 2;
  }

  const { pool, serial } = partition(files, SERIAL_ONLY);
  const childEnv = opts.requireE2e ? { AGENTEX_E2E_REQUIRE: '1' } : {};
  const results = [
    ...await runPool(found.root, pool, opts.concurrency, childEnv),
    ...await runPool(found.root, serial, 1, childEnv),
  ];
  const failed = []; const skipped = []; let passed = 0;
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
    const v = classify(r, { requireE2e: opts.requireE2e });
    if (v.status === 'passed') passed++;
    else if (v.status === 'skipped') skipped.push({ file: r.file, reason: v.reason });
    else {
      const f = { file: r.file, exit: r.exit, tail: r.tail };
      if (r.signal) f.signal = r.signal;
      if (v.reason) f.reason = v.reason;
      failed.push(f);
    }
  }
  const durationMs = Date.now() - started;

  for (const f of failed) process.stderr.write(`FAIL ${f.file} (exit ${f.exit === null ? f.signal || 'none' : f.exit})${f.reason ? `: ${f.reason}` : ''}\n`);
  for (const s of skipped) process.stderr.write(`SKIP ${s.file}: ${s.reason}\n`);
  process.stderr.write(`run-tests: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped (of ${results.length}) — `
    + `${(durationMs / 1000).toFixed(1)}s wall (concurrency ${opts.concurrency}${serial.length ? `, ${serial.length} serial-only` : ''})\n`);
  emit({ ok: failed.length === 0, total: results.length, passed, failed, skipped, durationMs });
  return failed.length ? 1 : 0;
}

module.exports = { parseArgs, partition, lastLines, runPool, classify, SERIAL_ONLY };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`run-tests: ${e.message}\n`);
    emit({ ok: false, error: e.message });
    process.exitCode = 2;
  });
}
