'use strict';
// Self-contained test: spins up mock KB servers, runs ask_kb.js against them,
// asserts the single JSON line and exit code. Run: node ask_kb.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RUNNER = path.join(__dirname, 'ask_kb.js');
let passed = 0;

function server(handler) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function fixtureCwd(kb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askkb-'));
  fs.writeFileSync(path.join(dir, 'agentex.config.json'), JSON.stringify({ kb }));
  return dir;
}

function run(cwd, env, args) {
  return new Promise((resolve) => {
    const p = spawn('node', [RUNNER, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
      resolve({ code, json: JSON.parse(line) });
    });
  });
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

(async () => {
  // 1. OK: answer + sources
  await test('OK returns answer and sources, exit 0', async () => {
    const srv = await server((req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: '## A', sources: ['mod-x'], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'travel-insurance' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'How?']);
    srv.close();
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.result, 'OK');
    assert.strictEqual(r.json.answer, '## A');
    assert.deepStrictEqual(r.json.sources, ['mod-x']);
  });

  // 2. Config default project is used and sent in the body
  await test('uses kb.project default from config in request body', async () => {
    let seen = null;
    const srv = await server((req, res, body) => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'x', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(seen.project, 'dwi');
    assert.strictEqual(seen.org, 'tameeni');
    assert.strictEqual(seen.model, 'opus');
  });

  // 2b. KB_PROJECT env takes precedence over kb.project in config
  await test('KB_PROJECT env overrides config project', async () => {
    let seen = null;
    const srv = await server((req, res, body) => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'x', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}`, KB_PROJECT: 'marine' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(seen.project, 'marine');
  });

  // 3. NOT_COVERED when hasContext false
  await test('NOT_COVERED when hasContext=false, exit 0', async () => {
    const srv = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'guess', sources: [], hasContext: false, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.result, 'NOT_COVERED');
    assert.ok(!('answer' in r.json), 'answer must be omitted when not covered');
  });

  // 4. 404 -> BLOCKED, not retried, exit 2
  await test('404 maps to BLOCKED exit 2', async () => {
    let calls = 0;
    const srv = await server((req, res) => {
      calls++;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown or empty project' }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'nope' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.strictEqual(calls, 1, '404 must not be retried');
  });

  // 5. 429 then 200 -> retried, OK
  await test('429 then 200 retries and returns OK', async () => {
    let calls = 0;
    const srv = await server((req, res) => {
      calls++;
      if (calls === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end(JSON.stringify({ error: 'rate limit' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'ok', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi', retries: 2 });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.json.result, 'OK');
    assert.strictEqual(calls, 2);
  });

  // 6. Missing base url -> BLOCKED
  await test('missing KB_ASK_BASE_URL -> BLOCKED', async () => {
    const cwd = fixtureCwd({ project: 'dwi' });
    const r = await run(cwd, { KB_ASK_BASE_URL: '' }, ['--question', 'Q']);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
  });

  // 7. 200 with success:false -> BLOCKED, not transient
  await test('200 with success=false maps to BLOCKED exit 2, not transient', async () => {
    const srv = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'boom' }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}` }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.ok(!r.json.transient, 'must not be marked transient');
  });

  // 8. x-api-key header sent when KB_ASK_API_KEY is set; cached surfaced
  await test('sends x-api-key from KB_ASK_API_KEY and surfaces cached', async () => {
    let seenKey = null;
    const srv = await server((req, res) => {
      seenKey = req.headers['x-api-key'] || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'a', sources: [], hasContext: true, isNoAnswer: false, cached: true }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}`, KB_ASK_API_KEY: 'secret-123' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(seenKey, 'secret-123', 'x-api-key header must carry KB_ASK_API_KEY');
    assert.strictEqual(r.json.result, 'OK');
    assert.strictEqual(r.json.cached, true, 'cached flag must be surfaced');
  });

  // 9. No x-api-key header when KB_ASK_API_KEY is unset (works against unauthenticated server)
  await test('omits x-api-key when KB_ASK_API_KEY unset', async () => {
    let hadKey = true;
    const srv = await server((req, res) => {
      hadKey = 'x-api-key' in req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'a', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}`, KB_ASK_API_KEY: '' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(hadKey, false, 'x-api-key must be absent when no key configured');
  });

  // 10. 401 -> BLOCKED, not retried, not transient
  await test('401 maps to BLOCKED exit 2, not retried', async () => {
    let calls = 0;
    const srv = await server((req, res) => {
      calls++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd({ project: 'dwi' });
    const r = await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}`, KB_ASK_API_KEY: 'wrong' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
    assert.strictEqual(r.json.status, 401);
    assert.ok(!r.json.transient, '401 must not be marked transient');
    assert.strictEqual(calls, 1, '401 must not be retried');
  });

  console.log(`\n${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
