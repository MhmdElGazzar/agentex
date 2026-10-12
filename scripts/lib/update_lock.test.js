'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireUpdateLock } = require('./update_lock.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-lock-test-'));
const project = path.join(sandbox, 'project');
const locks = path.join(sandbox, 'locks');
fs.mkdirSync(project);
const first = acquireUpdateLock(project, { root: locks });
assert.throws(() => acquireUpdateLock(project, { root: locks }), /migration lock exists/);
assert.strictEqual(first.release(), true);
assert.strictEqual(first.release(), false);

const second = acquireUpdateLock(project, { root: locks });
const original = fs.readFileSync(second.file, 'utf8');
fs.writeFileSync(second.file, JSON.stringify({ pid: 999999999, nonce: 'interrupted', target: fs.realpathSync(project) }));
assert.strictEqual(second.release(), false, 'an owner cannot release a replaced lock');
assert.throws(() => acquireUpdateLock(project, { root: locks }), /no automatic takeover/);
fs.writeFileSync(second.file, '{ broken');
assert.throws(() => acquireUpdateLock(project, { root: locks }), /unreadable or invalid/);
fs.writeFileSync(second.file, original);
assert.strictEqual(second.release(), true);
assert.strictEqual(fs.existsSync(second.file), false);
console.log('update lock: active, interrupted, malformed, ownership and release checks passed');
