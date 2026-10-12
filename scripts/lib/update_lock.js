'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// A lock belongs to a single canonical project path. Existing locks are never
// removed automatically: process liveness alone cannot prove quiescence.
function acquireUpdateLock(projectRoot, { root = path.join(os.tmpdir(), 'agentex-update-locks') } = {}) {
  const target = fs.realpathSync(projectRoot);
  const identity = process.platform === 'win32' ? target.toLowerCase() : target;
  const key = crypto.createHash('sha256').update(identity).digest('hex');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `project-${key}.lock`);
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), target, startedAt: new Date().toISOString() };
  const payload = JSON.stringify(owner);
  let handle;
  try {
    handle = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(handle, payload);
    fs.fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) {
      fs.closeSync(handle);
      try { fs.unlinkSync(file); } catch { /* retain any uncertain state */ }
    }
    if (error.code !== 'EEXIST') throw error;
    let prior;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || !prior.nonce || prior.target !== target) throw new Error('invalid lock');
    } catch { throw new Error(`migration lock is unreadable or invalid: ${file}; verify no migration process for this project is running, then manually rename this exact lock for audit and retry`); }
    let state = 'owner status unknown';
    try { process.kill(prior.pid, 0); state = `owner PID ${prior.pid} may still be active`; }
    catch (probe) { if (probe.code === 'ESRCH') state = `owner PID ${prior.pid} is absent`; }
    throw new Error(`migration lock exists (${state}): ${file}; verify the owner PID and command line and that no migration for this project is running, then manually rename this exact lock for audit and retry; no automatic takeover`);
  }
  const identityStat = fs.fstatSync(handle);
  fs.closeSync(handle);
  let released = false;
  return { file, owner, release() {
    if (released) return false;
    try {
      const current = fs.statSync(file);
      // On Windows, Node reports different dev values for fstat and stat on
      // the same file. The file index (ino) remains stable across both.
      if (current.ino !== identityStat.ino ||
          (process.platform !== 'win32' && current.dev !== identityStat.dev) ||
          fs.readFileSync(file, 'utf8') !== payload) return false;
    }
    catch { return false; }
    fs.unlinkSync(file);
    released = true;
    return true;
  } };
}

module.exports = { acquireUpdateLock };
