'use strict';
// AC14 sentinel test: a token taken from the browser session is stored only in its gitignored
// store and never shows up anywhere else. A fake application API requires
// "Bearer EVAL_SENTINEL_TOKEN_…" (and echoes it back, to prove the redaction). The wizard is
// driven over HTTP exactly as the page does, the agent's side runs the real channel.js, and the
// real browser_bridge.js captures the token (through a fake playwright-cli) and hands it to the
// studio. Then: approve, "approve and run now", and one case run from the editor.
// Asserted: zero occurrences of the token in the catalog, the suite, the collected store, every
// page response, executions/**, the server / channel / bridge output, and .playwright-cli/.
// Positive control: the token file holds it and the happy-path case PASSes with it.
// Run: node skills/endpoint-testing/scripts/studio/sentinel.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sentinel-tmp-'));
const ENV = { ...process.env, TMPDIR: TMP, TEMP: TMP, TMP };
const SENTINEL = `EVAL_SENTINEL_TOKEN_${Math.random().toString(36).slice(2, 10)}_ac14`;
const SERVER = path.join(__dirname, 'server.js');
const CHANNEL = path.join(__dirname, 'channel.js');
const BRIDGE = path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'browser_bridge.js');
const SHIM = path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'golden', 'fake_playwright_cli.js');

const outputs = [];   // every stdout/stderr byte of the server, channel and bridge processes
const responses = []; // every page response body
function proc(script, args, opts = {}) {
  const p = spawn(process.execPath, [script, ...args], { cwd: opts.cwd, env: { ...ENV, ...(opts.env || {}) } });
  const rec = { out: '', err: '' };
  p.stdout.on('data', d => { rec.out += d; });
  p.stderr.on('data', d => { rec.err += d; });
  outputs.push(rec);
  rec.done = new Promise(res => p.on('close', code => { rec.code = code; res(rec); }));
  rec.proc = p;
  return rec;
}
const lastJson = rec => JSON.parse(rec.out.trim().split('\n').pop());
function request(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => (b += d));
      res.on('end', () => { responses.push(b); let json = null; try { json = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, text: b, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

(async () => {
  let failed = false;
  const servers = [];
  try {
    // ---- the fake application API (requires the sentinel; echoes it back) ----
    const api = http.createServer((q, res) => {
      res.setHeader('content-type', 'application/json');
      const auth = q.headers.authorization || '';
      res.setHeader('x-echo-auth', auth);
      if (auth !== `Bearer ${SENTINEL}`) { res.writeHead(401); return res.end(JSON.stringify({ message: 'a token is required', youSent: auth })); }
      if (q.url === '/v1/pets/7') return res.end(JSON.stringify({ id: 7, name: 'Rex', debugToken: SENTINEL }));
      res.writeHead(404); res.end(JSON.stringify({ message: 'Pet not found' }));
    });
    await new Promise(r => api.listen(0, '127.0.0.1', r)); servers.push(api);
    const apiPort = api.address().port;
    const spec = {
      openapi: '3.0.3', info: { title: 'Pets' }, servers: [{ url: `http://127.0.0.1:${apiPort}/v1` }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }],
      paths: { '/pets/{petId}': { get: { operationId: 'getPetById', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } } } } },
          404: { description: 'nf', content: { 'application/json': { example: { message: 'Pet not found' } } } } } } } },
    };
    const specSrv = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(spec)); });
    await new Promise(r => specSrv.listen(0, '127.0.0.1', r)); servers.push(specSrv);

    // ---- the consumer project ----
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sentinel-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\ntest/.auth/\n.agentex/cache/\n.playwright-cli/\n');
    fs.mkdirSync(path.join(dir, 'environments'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config/project.json'), JSON.stringify({ defaultEnvironment: 'qc' }));
    fs.writeFileSync(path.join(dir, 'environments/qc.json'), JSON.stringify({ portalUrl: 'https://app.example.test', users: { qa_user_a: { email: 'qa_user_a@example.test' } } }));

    // ---- the studio (a real child process) ----
    const server = proc(SERVER, [dir, '--mode', 'wizard', '--port=0', '--no-open', '--lang=en']);
    for (let i = 0; i < 100 && !server.out.includes('\n'); i++) await new Promise(r => setTimeout(r, 50));
    const started = lastJson(server);
    assert.strictEqual(started.ok, true, server.out + server.err);
    const port = started.port;
    const html = await request(port, 'GET', '/wizard');
    const pageToken = /token: '([0-9a-f]+)'/.exec(html.text)[1];
    const page = (m, p, b) => request(port, m, p, b, { 'x-studio-token': pageToken });

    // steps 1-2
    assert.strictEqual((await page('POST', '/api/wizard/spec', { source: `http://127.0.0.1:${specSrv.address().port}/openapi.json`, suiteName: 'Pets', env: 'qc' })).status, 200);
    assert.strictEqual((await page('POST', '/api/wizard/select', { selection: ['GET /pets/{petId}'] })).status, 200);
    // step 3: the agent attaches (channel.js wait), the page asks to collect
    const wait1 = proc(CHANNEL, ['wait', '--timeout', '5000', '--project', dir]);
    await new Promise(r => setTimeout(r, 400));
    const collect = await page('POST', '/api/wizard/collect', { user: 'qa_user_a' });
    assert.strictEqual(collect.json.ok, true, collect.text);
    const ev = lastJson(await wait1.done);
    assert.strictEqual(ev.event, 'collect');
    // the bridge captures the app's own calls (fake playwright-cli) and hands the token over
    const callsFile = path.join(TMP, 'calls.json');
    fs.writeFileSync(callsFile, JSON.stringify([{ method: 'GET', url: `http://127.0.0.1:${apiPort}/v1/pets/7`, status: 200,
      headers: { authorization: `Bearer ${SENTINEL}` }, response: JSON.stringify({ id: 7, name: 'Rex', debugToken: SENTINEL }) }]));
    const bridge = proc(BRIDGE, ['capture', '--session', 'agentex-collect', '--api-origin', `http://127.0.0.1:${apiPort}`, '--goto', 'https://app.example.test/pets/7', '--wait-ms', '10', '--to-studio', '--user', 'qa_user_a', '--project', dir],
      { cwd: dir, env: { AGENTEX_PLAYWRIGHT_CLI: SHIM, SHIM_CALLS: callsFile } });
    const captured = lastJson(await bridge.done);
    assert.deepStrictEqual(captured.token, { seen: true, scheme: 'bearer', delivered: 'studio' }, bridge.out);
    // the agent posts the value it read off the redacted calls, then ends the run
    const post = (kind, obj) => proc(CHANNEL, ['post', kind, '--json', JSON.stringify({ runId: ev.runId, ...obj }), '--project', dir]).done;
    assert.strictEqual(lastJson(await post('value', { param: 'petId', value: 7, source: 'ui', user: 'qa_user_a', provenance: { screen: 'Pet details', call: 'GET /v1/pets/7' } })).ok, true);
    // a value that IS the token is refused
    assert.strictEqual(lastJson(await post('value', { param: 'petId', value: SENTINEL, source: 'ui' })).error, 'credential-shaped');
    await post('ended', { found: 1, total: 1 });
    await page('GET', '/api/wizard/state');
    await page('GET', '/api/wizard/preview');
    // step 5: approve and run now
    const wait2 = proc(CHANNEL, ['wait', '--timeout', '5000', '--project', dir]);
    await new Promise(r => setTimeout(r, 300));
    const approve = await page('POST', '/api/wizard/approve', { baseUrl: `http://127.0.0.1:${apiPort}/v1`, run: true });
    assert.strictEqual(approve.status, 200, approve.text);
    assert.strictEqual(lastJson(await wait2.done).event, 'closed');
    const pollRun = async id => {
      for (let i = 0; i < 100; i++) { const r = await page('GET', `/api/run/${id}`); if (r.json.status === 'done') return r.json; await new Promise(res => setTimeout(res, 100)); }
      throw new Error('run did not finish');
    };
    const run1 = await pollRun(approve.json.runId);
    // the editor: load the suite, run one case
    const suite = await page('GET', `/api/suite?path=${encodeURIComponent(approve.json.suitePath)}`);
    await page('GET', '/api/suites');
    await page('GET', `/api/collected?suite=${encodeURIComponent(approve.json.suitePath)}`);
    const happyIndex = suite.json.json.cases.findIndex(c => c.kind === 'happy') + 1;
    const r2 = await page('POST', '/api/run', { suite: approve.json.suitePath, case: happyIndex, etag: suite.json.etag, env: 'qc' });
    const run2 = await pollRun(r2.json.id);
    for (const c of run2.result.cases) if (c.log) await page('GET', `/api/log?path=${encodeURIComponent(c.log)}`);
    await page('GET', '/api/done');
    await server.done;

    // ---- positive control ----
    const tokenFile = path.join(dir, 'test/.auth/api-tokens/pets-qc.json');
    assert.ok(fs.readFileSync(tokenFile, 'utf8').includes(SENTINEL), 'the token file holds the token');
    const happy1 = run1.result.cases.find(c => c.name.endsWith('-happy'));
    assert.strictEqual(happy1.result, 'PASS', JSON.stringify(run1.result));
    assert.strictEqual(run2.result.cases[0].result, 'PASS', JSON.stringify(run2.result));
    assert.ok(run1.result.cases.some(c => c.name.endsWith('-no-token') && c.result === 'PASS'), 'the no-token case gets its 401');

    // ---- zero occurrences anywhere else ----
    const leaks = [];
    const check = (label, text) => { if (String(text).includes(SENTINEL)) leaks.push(label); };
    check('catalog', fs.readFileSync(path.join(dir, approve.json.catalogPath), 'utf8'));
    check('suite', fs.readFileSync(path.join(dir, approve.json.suitePath), 'utf8'));
    check('collected store', fs.readFileSync(path.join(dir, '.agentex/cache/api-data/pets.json'), 'utf8'));
    check('.env', fs.readFileSync(path.join(dir, '.env'), 'utf8'));
    responses.forEach((b, i) => check(`page response #${i}`, b));
    for (const f of walk(path.join(dir, 'executions'))) check(path.relative(dir, f), fs.readFileSync(f, 'utf8'));
    for (const f of walk(path.join(dir, '.playwright-cli'))) check(path.relative(dir, f), fs.readFileSync(f, 'utf8'));
    outputs.forEach((o, i) => { check(`process #${i} stdout`, o.out); check(`process #${i} stderr`, o.err); });
    // every file in the project other than the token file
    for (const f of walk(dir).filter(f => !f.includes(`${path.sep}.git${path.sep}`) && f !== tokenFile)) check(`file ${path.relative(dir, f)}`, fs.readFileSync(f, 'utf8'));
    assert.deepStrictEqual(leaks, [], `the token leaked into: ${leaks.join(', ')}`);
    assert.ok(walk(path.join(dir, 'executions')).some(f => f.endsWith('.log')), 'evidence logs exist (the check above is not vacuous)');
    assert.ok(responses.length > 15, 'page responses were captured');
    console.log(`  ok - AC14: the token (${SENTINEL.length} chars) appears only in its 0600 store; ${responses.length} page responses, ${outputs.length} process outputs and every project file checked`);
  } catch (e) {
    failed = true;
    console.error(`  FAIL - AC14 sentinel: ${e.stack.split('\n').slice(0, 4).join(' | ')}`);
  } finally {
    for (const s of servers) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); }
    for (const o of outputs) if (o.code === undefined) { try { o.proc.kill(); } catch { /* gone */ } }
  }
  console.log(failed ? '\n1 FAILED, 0 passed' : '\n1 passed');
  process.exitCode = failed ? 1 : 0;
})();
