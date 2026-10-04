'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('./validate_executor_result.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-executor-contract-'));
const runDir = 'executions/execu_2026-01-01_12-00-00';
const session = 'smoke-120000-a1b2';
const evidence = `browser-sessions/${session}/screenshots/s1.png`;
const full = path.join(cwd, runDir, evidence);
fs.mkdirSync(path.dirname(full), { recursive: true });
fs.writeFileSync(full, 'png fixture');

const result = {
  schemaVersion: 1, runDir, session, spec: 'test/smoke.md', status: 'passed',
  startedAt: '2026-01-01T12:00:00.000Z', endedAt: '2026-01-01T12:00:01.000Z', durationMs: 1000,
  scenarios: [{ name: 'Open', session, status: 'passed', screenshots: [{ path: evidence, caption: 'opened' }], steps: [{ desc: 'Open', status: 'passed' }] }],
  defects: [], failures: [], cleanup: { attempted: true, closed: true, error: null },
};

assert.deepEqual(validate(result, cwd), []);
assert.match(validate({ ...result, session: 'default' }, cwd).join(' '), /invalid session/);
assert.match(validate({ ...result, scenarios: [{ ...result.scenarios[0], screenshots: [{ path: '../../outside.png' }], steps: [] }] }, cwd).join(' '), /outside assigned session/);
assert.match(validate({ ...result, cleanup: { attempted: true, closed: false, error: null } }, cwd).join(' '), /cleanup error/);
assert.deepEqual(validate({ ...result, status: 'blocked', scenarios: [{ ...result.scenarios[0], status: 'notrun' }] }, cwd), []);
assert.match(validate({ ...result, cleanup: { attempted: true, closed: false, error: 'session not closed' } }, cwd).join(' '), /passed result cannot have failed cleanup/);
assert.match(validate({ ...result, scenarios: [] }, cwd).join(' '), /passed result requires passing scenarios/);
assert.match(validate({ ...result, failures: [{ kind: 'infrastructure', detail: 'browser failed' }] }, cwd).join(' '), /passed result cannot contain defects or failures/);
fs.unlinkSync(full);
assert.match(validate(result, cwd).join(' '), /evidence missing/);
fs.rmSync(cwd, { recursive: true, force: true });
console.log('validate_executor_result: 9 passed');
