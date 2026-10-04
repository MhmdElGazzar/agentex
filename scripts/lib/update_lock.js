'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Process-owned, per-target lock outside the consumer Git tree. The lock file
// never changes a project's clean-tree status. A crashed process can be
// recovered by the next invocation once its PID is confirmed gone.
function acquireUpdateLock(scope, target, { root = path.join(os.tmpdir(), 'agentex-update-locks'), pid = process.pid } = {}) {
  if (!/^(project|plugin)$/.test(scope)) throw new Error('invalid update lock scope');
  const resolved = fs.realpathSync(target);
  const key = crypto.createHash('sha256').update(`${scope}\0${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`).digest('hex');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${scope}-${key}.lock`);
  const owner = { pid, startedAt: Date.now(), target: resolved, scope };
  const create = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error(`update lock is unreadable: ${file}; inspect it before retrying`); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) {
      throw new Error(`update lock has no valid owner: ${file}; inspect it before retrying`);
    }
    let alive = true;
    try { process.kill(previous.pid, 0); }
    catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`${scope} update already running (PID ${previous.pid}); lock: ${file}`);
    // Recheck ownership before recovering a dead owner's lock.
    if (fs.readFileSync(file, 'utf8') !== JSON.stringify(previous)) {
      throw new Error(`${scope} update lock changed during stale-lock recovery; retry later`);
    }
    fs.unlinkSync(file);
    create();
  }
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.pid === owner.pid && current.startedAt === owner.startedAt && current.target === owner.target) fs.unlinkSync(file);
      } catch { /* preserve an unknown owner's lock */ }
    },
  };
}

module.exports = { acquireUpdateLock };
