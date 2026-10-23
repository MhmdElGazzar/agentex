'use strict';
// The e2e fixture application: a tiny sign-in app on 127.0.0.1 with an ephemeral port.
// Maintainer tooling (never shipped): used by the *.e2e.test.js files through harness.js.
//
//   GET  /login   a page with #sign-in (a button) and input[type=password]: the logged-out landmark
//   POST /login   a new random sid (HttpOnly, SameSite=Lax, path /) and a page that writes
//                 localStorage.token = <random> and goes to /. No password: nothing secret-shaped
//                 ever sits on a command line
//   GET  /        with a valid sid: #account-menu plus a script calling /api/me with
//                 Authorization: Bearer <localStorage.token>. Without one: the login link only
//   GET  /api/me  200 { user } for a valid bearer token, else 401
//
// Control (in-process): invalidate() drops every session, rejectApi(on) makes /api/me answer 401
// to every token, requests() is the method + path log, issued() lists every sid and token ever
// handed out (the sentinels a test scans every output for), close().
const http = require('node:http');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const random = (label) => `${label}-${crypto.randomBytes(12).toString('hex')}`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function startFixture() {
  const sessions = new Map();              // sid -> token
  const issuedSids = []; const issuedTokens = [];
  const log = [];
  let reject = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    log.push(`${req.method} ${url.pathname}`);
    const cookie = String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === 'sid');
    const sid = cookie ? cookie[1] : null;
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };

    if (req.method === 'GET' && url.pathname === '/login') {
      return send(200, 'text/html; charset=utf-8', page('Sign in',
        '<h1>Sign in</h1><form method="post" action="/login"><input type="password" name="password" aria-label="Password"><button id="sign-in" type="submit">Sign in</button></form>'));
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      req.resume();
      req.on('end', () => {
        const newSid = random('sid'); const token = random('tok');
        sessions.set(newSid, token); issuedSids.push(newSid); issuedTokens.push(token);
        send(200, 'text/html; charset=utf-8',
          page('Signing in', `<script>localStorage.setItem('token', ${JSON.stringify(token)}); location.replace('/');</script>`),
          { 'set-cookie': `sid=${newSid}; HttpOnly; SameSite=Lax; Path=/` });
      });
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      if (sid && sessions.has(sid)) {
        return send(200, 'text/html; charset=utf-8', page('Home',
          `<div id="account-menu">Account</div><p id="me"></p>
<script>fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })
  .then((r) => r.json().catch(() => ({}))).then((j) => { document.getElementById('me').textContent = j.user || 'unknown'; });</script>`));
      }
      return send(200, 'text/html; charset=utf-8', page('Home', '<a id="login-link" href="/login">Log in</a>'));
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
      const ok = !reject && m && [...sessions.values()].includes(m[1]);
      return ok ? send(200, 'application/json', JSON.stringify({ user: 'buyer' })) : send(401, 'application/json', '{"error":"unauthorized"}');
    }
    return send(404, 'text/plain', 'not found');
  });

  return new Promise((resolve, reject2) => {
    server.once('error', reject2);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://${HOST}:${port}`,
        invalidate: () => sessions.clear(),
        rejectApi: (on) => { reject = !!on; },
        requests: () => log.slice(),
        issued: () => ({ sids: issuedSids.slice(), tokens: issuedTokens.slice() }),
        close: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFixture, HOST };
