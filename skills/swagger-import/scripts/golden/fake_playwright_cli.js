#!/usr/bin/env node
'use strict';
// Fake playwright-cli for browser_bridge.test.js. Records its argv (one JSON line per call) to
// $SHIM_LOG and plays the browser's part of the two run-code shapes the bridge composes:
//   capture     → POSTs the calls in $SHIM_CALLS (a JSON file) to the code's loopback sink
//   fill-secret → GETs the code's single-use handle; writes what it received to $SHIM_FILLED
// It then prints CLI-like output that echoes the code, as the real CLI does.
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
if (process.env.SHIM_LOG) fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + '\n');
const at = args.indexOf('run-code');
if (at === -1) { console.log('### Page\n- Page URL: about:blank'); process.exit(0); }
const code = args[at + 1];
const done = (result) => { console.log(`### Result\n${JSON.stringify(result)}\n### Ran Playwright code\n\`\`\`js\nawait (${code})(page);\n\`\`\``); process.exit(0); };
const sink = /const sink = ("[^"]+")/.exec(code);
const handle = /page\.request\.get\(("[^"]+")\)/.exec(code);
function send(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
      let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
// SHIM_FIELD: run the composed fill code against a one-field page and write the field's final
// state there. The page has a single password input (matched by the --locator and by
// input[type=password]); a click on submit navigates away (the field is gone) unless
// SHIM_STAY_ON_PAGE is set (wrong password / same-page OTP). SHIM_FIELD_STUCK ignores fill('').
async function runFill(src, served) {
  const field = { present: true, value: '', sawPassword: false };
  const clicks = [];
  const loc = sel => {
    const isField = sel !== undefined && !/submit/.test(sel);
    const api = {
      first: () => api, nth: () => api,
      count: async () => (isField && field.present ? 1 : 0),
      inputValue: async () => { if (!field.present) throw new Error('no element'); return field.value; },
      fill: async v => { if (!field.present) throw new Error('no element'); if (v === '' && process.env.SHIM_FIELD_STUCK) return; field.value = v; if (v) field.sawPassword = true; },
      click: async () => { clicks.push(sel); if (!process.env.SHIM_STAY_ON_PAGE) field.present = false; },
    };
    return api;
  };
  const page = {
    request: { get: async () => ({ ok: () => served.status === 200, text: async () => served.body }) },
    locator: loc,
    waitForTimeout: async () => {}, waitForLoadState: async () => {},
  };
  const fn = eval(`(${src})`); // eslint-disable-line no-eval -- test double for the browser
  const result = await fn(page);
  fs.writeFileSync(process.env.SHIM_FIELD, JSON.stringify({ value: field.present ? field.value : '', present: field.present, sawPassword: field.sawPassword, clicks }));
  return result;
}

(async () => {
  if (process.env.SHIM_FAIL) { console.log('### Error\nError: browser crashed'); process.exit(1); }
  if (sink) {
    const calls = process.env.SHIM_CALLS ? fs.readFileSync(process.env.SHIM_CALLS, 'utf8') : '[]';
    await send(JSON.parse(sink[1]), 'POST', calls);
    return done(`captured ${JSON.parse(calls).length}`);
  }
  if (handle) {
    const r = await send(JSON.parse(handle[1]), 'GET');
    if (process.env.SHIM_FILLED) fs.writeFileSync(process.env.SHIM_FILLED, JSON.stringify({ status: r.status, value: r.body }));
    if (process.env.SHIM_SECOND_GET) { const again = await send(JSON.parse(handle[1]), 'GET').catch(() => ({ status: 0 })); fs.appendFileSync(process.env.SHIM_SECOND_GET, String(again.status)); }
    if (process.env.SHIM_FIELD) return done(await runFill(code, r));
    return done(r.status === 200 ? 'filled' : 'handle-refused');
  }
  done('ok');
})();
