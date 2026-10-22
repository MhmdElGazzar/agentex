#!/usr/bin/env node
'use strict';
// AgenTeX suite studio — the agent's side of the page ↔ agent channel. The agent opts in: it
// loops `wait` while a wizard is open; the page never drives a session by itself.
//
// Usage (from the project root, or pass --project <root>):
//   node channel.js wait [--timeout <ms>]           one bounded long-poll (default 90 s)
//   node channel.js post <kind> --json '<object>'   report to the page (--json - reads stdin)
//   node channel.js status
// Prints ONE JSON line:
//   wait   → {"event":"collect"|"collect-again"|"consent"|"gate-cleared"|"cancel"|"closed"|"idle", ...}
//   post   → the server's answer, e.g. {"ok":true} or {"ok":false,"error":"refused",...}
//   status → {"ok":true,"running":true|false,"port":...}
// Exit: 0 ok · 1 the server refused the post · 2 no studio running / usage.
// Kinds for post: phase, value, missing, gate, proposal, created, ended, failed. A captured
// token never travels here — browser_bridge.js hands it to the studio itself.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { sessionFile } = require('./server.js');

const DEFAULT_WAIT_MS = 90 * 1000; // (Q8)
const emit = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };

function readSession(root) {
  try { return JSON.parse(fs.readFileSync(sessionFile(root), 'utf8')); } catch { return null; }
}
function call(sess, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: sess.port, method, path: p, timeout: timeoutMs,
      headers: { 'x-studio-control': sess.controlToken, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: { ok: false, error: 'bad-response' } }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function readStdin() {
  return new Promise(resolve => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (b += d)); process.stdin.on('end', () => resolve(b)); });
}

async function main(argv) {
  const args = argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const root = path.resolve(opt('--project') || process.cwd());
  const cmd = args[0];
  if (!['wait', 'post', 'status'].includes(cmd)) return emit({ ok: false, error: 'usage', message: 'usage: channel.js wait [--timeout ms] | post <kind> --json <object> | status' }, 2);
  const sess = readSession(root);
  if (cmd === 'status') {
    if (!sess) return emit({ ok: true, running: false }, 0);
    try { await call(sess, 'GET', '/api/strings', undefined, 3000); return emit({ ok: true, running: true, port: sess.port }, 0); }
    catch { return emit({ ok: true, running: false, stale: true }, 0); }
  }
  if (!sess) return emit({ ok: false, error: 'no-studio', message: 'no studio is running for this project — start it with server.js --mode wizard' }, 2);
  if (cmd === 'wait') {
    const t = parseInt(opt('--timeout'), 10);
    const timeout = Number.isFinite(t) && t > 0 ? t : DEFAULT_WAIT_MS;
    try {
      const r = await call(sess, 'GET', `/api/agent/next?timeout=${timeout}`, undefined, timeout + 15000);
      return emit(r.json, r.status === 200 ? 0 : 2);
    } catch (e) {
      // The server is gone (closed by the tester, idle shutdown, or killed).
      return emit({ event: 'closed', reason: 'shutdown' }, 0);
    }
  }
  // post
  const kind = args[1];
  let raw = opt('--json');
  if (raw === '-') raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch (e) { return emit({ ok: false, error: 'bad-json', message: e.message }, 2); }
  if (!kind || kind.startsWith('--') || !payload || typeof payload !== 'object' || Array.isArray(payload)) return emit({ ok: false, error: 'usage', message: 'post <kind> --json <object>' }, 2);
  try {
    const r = await call(sess, 'POST', '/api/agent/event', { event: kind, payload }, 15000);
    return emit(r.json, r.json && r.json.ok ? 0 : 1);
  } catch (e) { return emit({ ok: false, error: 'no-studio', message: e.message }, 2); }
}

if (require.main === module) main(process.argv);
module.exports = { readSession, call };
