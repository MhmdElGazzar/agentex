#!/usr/bin/env node
'use strict';
// Re-proof (Q17) for the 0.27.0 gate defect F1: a failed login that re-renders the posted
// password in the form (value="<password>") must not reach the accessibility snapshot taken
// after fill_secret.js --submit. Drives the REAL playwright-cli against a local page.
//
// Needs @playwright/cli: set AGENTEX_REPROOF_NODE_MODULES to a node_modules folder that has
// it (symlinked into the throwaway project), else it runs `npm install @playwright/cli`.
// The secret is a dummy generated per run; it is never printed. Output: one JSON line,
// exit 0 = no leak, 1 = leak or a step failed.
//
//   node scripts/dev/reproof_fill_secret_rerender.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const FILL = path.resolve(__dirname, '..', '..', 'skills', 'browser-driver', 'scripts', 'fill_secret.js');
const SECRET = `Dummy-${crypto.randomBytes(8).toString('hex')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const form = (u, p) => `<!doctype html><html><head><title>Login</title></head><body><h1>Sign in</h1>
<form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" type="text" value="${esc(u)}">
<label for="password">Password</label><input id="password" name="password" type="password" value="${esc(p)}">
<button id="submit" type="submit">Sign in</button></form></body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      const f = new URLSearchParams(b);
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end(form(f.get('username') || '', f.get('password') || '').replace('<h1>Sign in</h1>', '<h1>Sign in</h1><p>Invalid username or password.</p>'));
    });
  } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(form('', '')); }
});

function sh(cwd, args, env = {}) {
  const r = spawnSync(args[0], args.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// The page is served by a child process: the CLI calls below block this one.
if (process.argv[2] === '--serve') {
  server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
} else {
  const child = spawn(process.execPath, [__filename, '--serve'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', (d) => main(`http://127.0.0.1:${String(d).trim()}/login`, child));
}

function main(url, child) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-reproof-'));
  const session = `reproof-${process.pid}`;
  const result = { reproof: 'fill_secret re-rendered password', steps: {} };
  let leaked = true;
  try {
    fs.mkdirSync(path.join(proj, 'config')); fs.mkdirSync(path.join(proj, 'environments'));
    fs.writeFileSync(path.join(proj, 'config', 'project.json'), JSON.stringify({ defaultEnvironment: 'qc' }));
    fs.writeFileSync(path.join(proj, 'environments', 'qc.json'), JSON.stringify({ defaults: { password: { envSecret: 'REPROOF_PASSWORD' } } }));
    const nm = process.env.AGENTEX_REPROOF_NODE_MODULES;
    if (nm) fs.symlinkSync(nm, path.join(proj, 'node_modules'));
    else { fs.writeFileSync(path.join(proj, 'package.json'), '{"private":true}'); sh(proj, ['npm', 'install', '--silent', '@playwright/cli']); }
    const pw = (...a) => sh(proj, ['npx', 'playwright-cli', `-s=${session}`, ...a]);
    const opened = pw('open', url);
    const snap = pw('snapshot').out;
    const ref = (name) => (snap.match(new RegExp(`textbox "${name}" \\[ref=([^\\]]+)\\]`)) || [])[1];
    const btn = (snap.match(/button "Sign in" \[ref=([^\]]+)\]/) || [])[1];
    if (process.env.REPROOF_DEBUG) process.stderr.write(opened.out + snap);
    result.steps.open = opened.status === 0 && !!ref('Username') && !!ref('Password') && !!btn;
    if (!result.steps.open) throw new Error('could not open the login page / read its refs');
    pw('fill', ref('Username'), 'qa.tester');
    const fs1 = sh(proj, [process.execPath, FILL, '--session', session, '--target', ref('Password'), '--env-var', 'REPROOF_PASSWORD', '--submit-target', btn], { REPROOF_PASSWORD: SECRET });
    const line = (fs1.out.trim().split('\n').filter(Boolean).pop() || '{}');
    let j = {}; try { j = JSON.parse(line); } catch { /* reported below */ }
    result.steps.fillSecret = { result: j.result, submitted: j.submitted, scrubbed: j.scrubbed };
    // The snapshot a wizard would take next, plus every other command output and file.
    const after = pw('snapshot');
    const hits = [after.out, fs1.out].filter((t) => t.includes(SECRET)).length
      + walk(proj).filter((f) => { try { return fs.readFileSync(f, 'utf8').includes(SECRET); } catch { return false; } }).length;
    const rerendered = /Invalid username or password/.test(after.out);
    result.steps.pageReRendered = rerendered;
    result.secretHits = hits;
    leaked = hits > 0 || !rerendered || j.result !== 'PASS' || !(j.scrubbed >= 1);
    pw('close');
  } catch (e) { result.error = String(e.message).split(SECRET).join('***'); }
  finally {
    try { sh(proj, ['npx', 'playwright-cli', `-s=${session}`, 'close']); } catch { /* best effort */ }
    fs.rmSync(proj, { recursive: true, force: true });
    child.kill();
  }
  result.verdict = leaked ? 'LEAK-OR-FAILED' : 'PASS';
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = leaked ? 1 : 0;
}
