#!/usr/bin/env node
'use strict';

// Codex-only lease around playwright-cli's already-detached named daemon.
// No listener, shell command endpoint, or global browser teardown is exposed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MIN_IDLE_MS = 60 * 1000;
const MAX_IDLE_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 10 * 1000;

function fail(message) { throw new Error(message); }
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function validSession(session) {
  return typeof session === 'string' && /^define-[a-z0-9][a-z0-9-]{5,63}$/.test(session) && session !== 'default';
}
function validTarget(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid target URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('unsafe target URL');
  return url.toString();
}
function cliPath() {
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'playwright-cli.js'));
  if (process.env.npm_config_prefix) candidates.push(path.join(process.env.npm_config_prefix, 'node_modules', '@playwright', 'cli', 'playwright-cli.js'));
  try { candidates.push(require.resolve('@playwright/cli/playwright-cli.js')); } catch { /* global install may not resolve from plugin */ }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const root = path.dirname(candidate);
    try {
      if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === '@playwright/cli') return fs.realpathSync(candidate);
    } catch { /* try the next supported install location */ }
  }
  fail('@playwright/cli direct Node entrypoint not found');
}
function ownerDir(root) {
  const real = fs.realpathSync(root);
  const dir = path.join(real, '.playwright-cli', 'define-owners');
  fs.mkdirSync(dir, { recursive: true });
  if (!inside(real, fs.realpathSync(dir))) fail('owner directory escapes project');
  return dir;
}
function ownerPath(root, session) {
  if (!validSession(session)) fail('invalid named Define Flow session');
  return path.join(ownerDir(root), `${session}.json`);
}
function readOwner(file, id) {
  const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = owner?.root && validSession(owner.session) ?
    path.join(fs.realpathSync(owner.root), '.playwright-cli', 'define-owners', `${owner.session}.json`) : null;
  const expectedDaemon = owner?.root && validSession(owner.session) ?
    path.join(fs.realpathSync(owner.root), '.playwright-cli', 'define-owners', `daemon-${owner.session}`) : null;
  if (!owner || owner.id !== id || !validSession(owner.session) || owner.file !== file ||
      file !== expected || fs.realpathSync(file) !== file || owner.daemonDir !== expectedDaemon ||
      !inside(fs.realpathSync(owner.root), file) ||
      owner.target !== validTarget(owner.target)) fail('stale or foreign owner');
  return owner;
}
function writeOwner(file, owner) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function runCli(owner, args, deps = {}) {
  if (!deps.run && fs.realpathSync(owner.cli) !== cliPath()) fail('untrusted playwright CLI path');
  const run = deps.run || cp.spawnSync;
  const result = run(process.execPath, [owner.cli, `-s=${owner.session}`, ...args], {
    cwd: owner.root, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PWTEST_DAEMON_SESSION_DIR: owner.daemonDir },
  });
  if (result.error || result.status !== 0) fail(`Playwright command failed: ${result.error?.code || result.status}; ${String(result.stderr || '').slice(0, 300)}`);
  return String(result.stdout || '');
}
function state(owner, deps = {}) {
  const output = runCli(owner, ['snapshot'], deps);
  const url = output.match(/^- Page URL: (.+)$/m)?.[1];
  if (!url) fail('original browser/session unavailable; do not reopen');
  if (new URL(url).origin !== new URL(owner.target).origin) fail('page left assigned target origin; re-observe');
  return { url, snapshot: output, hash: crypto.createHash('sha256').update(output).digest('hex') };
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function liveOwner(file, id, now = Date.now(), deps = {}) {
  const owner = readOwner(file, id);
  if (owner.state !== 'open') fail(`owner is ${owner.state}`);
  if (now >= owner.expiresAt) fail('interactive session expired');
  if (owner.watcherPid && !(deps.isAlive || isAlive)(owner.watcherPid)) {
    try { closeOwned(file, owner, 'crashed', deps); }
    catch { fail('interactive controller crashed; owned-session cleanup failed'); }
    fail('interactive controller crashed; owned session closed');
  }
  return owner;
}
function touch(file, owner, now = Date.now()) {
  owner.lastActivity = now;
  owner.expiresAt = now + owner.idleMs;
  writeOwner(file, owner);
}
function closeOwned(file, owner, reason, deps = {}) {
  if (owner.state === 'closed' || owner.state === 'expired') return owner;
  try { runCli(owner, ['close'], deps); }
  catch (error) {
    owner.state = 'cleanup_failed';
    owner.error = error.message;
    writeOwner(file, owner);
    throw error;
  }
  owner.state = reason;
  owner.closedAt = Date.now();
  writeOwner(file, owner);
  return owner;
}
function start(root, session, target, idleMs = DEFAULT_IDLE_MS, deps = {}) {
  const realRoot = fs.realpathSync(root);
  const normalizedTarget = validTarget(target);
  if (!Number.isInteger(idleMs) || idleMs < MIN_IDLE_MS || idleMs > MAX_IDLE_MS) fail('idle timeout out of bounds');
  const file = ownerPath(realRoot, session);
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const owner = { id, file, root: realRoot, session, target: normalizedTarget, cli: deps.cli || cliPath(),
    daemonDir: path.join(ownerDir(realRoot), `daemon-${session}`), idleMs, lastActivity: now,
    expiresAt: now + idleMs, state: 'starting', browserPid: null, watcherPid: null };
  fs.writeFileSync(file, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const output = runCli(owner, ['open', normalizedTarget], deps);
    owner.browserPid = Number(output.match(/opened with pid (\d+)/)?.[1]) || null;
    owner.state = 'open';
    state(owner, deps);
    if (!deps.noWatch) {
      const child = (deps.spawn || cp.spawn)(process.execPath, [__filename, 'watch', '--file', file, '--owner', id], {
        cwd: realRoot, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, PWTEST_DAEMON_SESSION_DIR: owner.daemonDir },
      });
      if (!child.pid) fail('watcher did not start');
      owner.watcherPid = child.pid;
      child.unref();
    }
    writeOwner(file, owner);
    return { file, id, session, browserPid: owner.browserPid, watcherPid: owner.watcherPid,
      target: owner.target, expiresAt: owner.expiresAt };
  } catch (error) {
    try { runCli(owner, ['close'], deps); } catch { /* original failure retained */ }
    try { fs.unlinkSync(file); } catch { /* no valid lease remains */ }
    throw error;
  }
}
function command(file, id, verb, opts = {}, deps = {}) {
  const owner = liveOwner(file, id, opts.now, deps);
  let result;
  if (verb === 'status' || verb === 'snapshot') result = state(owner, deps);
  else if (verb === 'click') {
    if (!/^e\d+$/.test(opts.ref || '')) fail('invalid element reference');
    if (!/^[a-f0-9]{64}$/.test(opts.hash || '')) fail('observed snapshot hash required');
    const before = state(owner, deps);
    if (before.hash !== opts.hash) fail('page state changed; re-observe and reconfirm');
    result = { output: runCli(owner, ['click', opts.ref], deps), beforeHash: before.hash };
  } else if (verb === 'screenshot') {
    const filename = path.join(ownerDir(owner.root), `${owner.session}-${Date.now()}.png`);
    result = { filename, output: runCli(owner, ['screenshot', `--filename=${filename}`], deps) };
  } else if (verb === 'visible-text') {
    const wanted = String(opts.text || '');
    if (!wanted || wanted.length > 200) fail('invalid text query');
    const expr = `() => { const e=[...document.querySelectorAll('*')].find(x=>x.textContent?.trim()===${JSON.stringify(wanted)}); if(!e)return {found:false}; const s=getComputedStyle(e),r=e.getBoundingClientRect(); return {found:true,visible:s.display!=='none'&&s.visibility==='visible'&&r.width>0&&r.height>0}; }`;
    result = { output: runCli(owner, ['eval', expr], deps) };
  } else if (verb === 'console' || verb === 'requests') result = { output: runCli(owner, [verb], deps) };
  else fail('unsupported browser operation');
  touch(file, owner, opts.now);
  return result;
}
function watchTick(file, id, now = Date.now(), deps = {}) {
  let owner;
  try { owner = readOwner(file, id); } catch { return 'gone'; }
  if (owner.state !== 'open') return owner.state;
  if (now < owner.expiresAt) return 'waiting';
  closeOwned(file, owner, 'expired', deps);
  return 'expired';
}
function parse(argv) {
  const [verb, ...args] = argv;
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || opts[args[i].slice(2)]) fail('invalid arguments');
    opts[args[i].slice(2)] = args[i + 1];
  }
  return { verb, opts };
}
function main(argv) {
  const { verb, opts } = parse(argv);
  if (verb === 'start') return start(opts.project || process.cwd(), opts.session, opts.target, opts['idle-ms'] ? Number(opts['idle-ms']) : DEFAULT_IDLE_MS);
  const file = path.resolve(opts.file || '');
  const owner = readOwner(file, opts.owner);
  if (verb === 'watch') {
    const timer = setInterval(() => {
      try { if (watchTick(file, owner.id) !== 'waiting') { clearInterval(timer); process.exit(0); } }
      catch { clearInterval(timer); process.exit(2); }
    }, POLL_MS);
    return { watching: owner.session, pid: process.pid };
  }
  if (verb === 'close') return closeOwned(file, owner, 'closed');
  if (verb === 'heartbeat') { touch(file, liveOwner(file, owner.id)); return { ok: true, expiresAt: readOwner(file, owner.id).expiresAt }; }
  return command(file, owner.id, verb, { ref: opts.ref, hash: opts.hash, text: opts.text });
}
if (require.main === module) {
  try { console.log(JSON.stringify({ ok: true, result: main(process.argv.slice(2)) })); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; }
}
module.exports = { validSession, validTarget, ownerPath, readOwner, start, state, command, closeOwned, watchTick,
  DEFAULT_IDLE_MS, MIN_IDLE_MS, MAX_IDLE_MS };
