'use strict';
// AgenTeX suite studio — HTTP helpers for the loopback page server. The pattern is copied from
// the setup wizard's server (scripts/wizard/server.js, deliberately not imported or edited):
// bind 127.0.0.1, a per-run token on every /api/* call, no CORS header, nosniff, and a
// "try --port" hint when the port is taken. Node built-ins only.
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const MAX_BODY = 4 * 1024 * 1024; // (Q8)

function respond(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    // No CORS: the page is same-origin. A wildcard would let any site open in the browser read
    // the project's suites and write its files.
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function respondJSON(res, status, data) { respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data)); }
function forbid(res) { respondJSON(res, 403, { error: 'forbidden — this API only serves the studio page and its agent' }); }

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// "page" for the page's x-studio-token, "control" for the agent/bridge's x-studio-control.
function roleOf(req, tokens) {
  if (sameToken(req.headers['x-studio-token'], tokens.page)) return 'page';
  if (sameToken(req.headers['x-studio-control'], tokens.control)) return 'control';
  return null;
}

// DNS rebinding (N12): a page on attacker.example can re-point its own name at 127.0.0.1 and
// then read /editor (with the per-run token) and call /api/* as a "same-origin" page. Binding
// to loopback does not stop that; checking the Host header does. Only the two loopback names
// on the studio's own port are served.
function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
// An Origin on /api/* (browsers send one on cross-origin and non-GET calls) must be the page's
// own origin; Host has already been checked by hostAllowed. Absent = a non-browser client.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${String(req.headers.host || '').toLowerCase()}`;
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', c => {
      size += c.length;
      if (size > max) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error(`request body over ${max} bytes`)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJSON(req, max) {
  const buf = await readBody(req, max);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

const portInUseMessage = port => `[studio] Port ${port} is in use. Try --port=${port + 1}`;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { execFile(cmd[0], cmd[1], { windowsHide: true }, () => {}); } catch { /* the URL is printed anyway */ }
}

const newToken = () => crypto.randomBytes(24).toString('hex');

module.exports = { HOST, MAX_BODY, respond, respondJSON, forbid, sameToken, roleOf, hostAllowed, originAllowed, readBody, readJSON, portInUseMessage, openBrowser, newToken };
