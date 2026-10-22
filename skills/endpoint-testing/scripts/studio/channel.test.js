'use strict';
// Tests for studio/channel.js — the agent's long-poll channel to the studio page.
// Run: node skills/endpoint-testing/scripts/studio/channel.test.js
const { assert, fs, os, path, http, harness, proj, studio, sessionFile } = require('./test_helpers.js');
const { spawn } = require('node:child_process');
const { test, done } = harness();
const CHANNEL = path.join(__dirname, 'channel.js');

function channel(dir, args, stdin) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CHANNEL, ...args, '--project', dir], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    if (stdin !== undefined) { p.stdin.write(stdin); p.stdin.end(); }
    p.on('close', code => { let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ } resolve({ code, json, out, err }); });
  });
}
function specServer() {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'fixtures', 'golden', 'petstore-oa3', 'spec.json'), 'utf8'));
  return new Promise(resolve => {
    const srv = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(spec)); });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/spec.json`, close: () => { srv.close(); srv.closeAllConnections(); } }));
  });
}
const project = (env = {}) => proj({ '.gitignore': '.agentex/\ntest/.auth/\n', 'environments/qc.json': { portalUrl: 'https://app.example.test', users: { qa_user_a: {} }, ...env } });
async function wizardAt(dir) {
  const sp = await specServer();
  const s = await studio(dir, { mode: 'wizard' });
  await s.page('POST', '/api/wizard/spec', { source: sp.url, suiteName: 'Pets', env: 'qc' });
  await s.page('POST', '/api/wizard/select', { selection: ['GET /pets', 'GET /pets/{petId}'] });
  sp.close();
  return s;
}
// Start a collect run: one wait attaches the agent, then the page's Collect is delivered.
async function collecting(s, dir) {
  const first = channel(dir, ['wait', '--timeout', '3000']);
  await new Promise(r => setTimeout(r, 300));
  const c = await s.page('POST', '/api/wizard/collect', { user: 'qa_user_a' });
  assert.strictEqual(c.json.ok, true, c.text);
  const ev = await first;
  return { ev: ev.json, runId: c.json.runId };
}

(async () => {
  await test('no studio -> wait/post answer no-studio (exit 2); status says not running', async () => {
    const dir = project();
    const w = await channel(dir, ['wait', '--timeout', '50']);
    assert.strictEqual(w.code, 2); assert.strictEqual(w.json.error, 'no-studio');
    const st = await channel(dir, ['status']);
    assert.deepStrictEqual(st.json, { ok: true, running: false });
  });

  await test('wait times out with idle and marks the agent attached', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.attached, false);
    const w = await channel(dir, ['wait', '--timeout', '100']);
    assert.deepStrictEqual(w.json, { event: 'idle' });
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.attached, true);
  });

  await test('a pending wait receives the page\'s collect event with the needs', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const { ev, runId } = await collecting(s, dir);
    assert.strictEqual(ev.event, 'collect');
    assert.strictEqual(ev.runId, runId);
    assert.strictEqual(ev.env, 'qc');
    assert.strictEqual(ev.user, 'qa_user_a');
    assert.strictEqual(ev.apiOrigin, 'https://api.example.test');
    assert.deepStrictEqual(ev.needs.map(n => n.param).sort(), ['petId', 'status']);
  });

  await test('a queued event is returned by the next wait', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const { runId } = await collecting(s, dir);
    await channel(dir, ['post', 'gate', '--json', JSON.stringify({ runId, kind: 'otp', text: 'code sent' })]);
    await s.page('POST', '/api/wizard/gate-cleared', {});
    const w = await channel(dir, ['wait', '--timeout', '200']);
    assert.deepStrictEqual(w.json, { event: 'gate-cleared', runId }, w.out);
  });

  await test('post validation per kind; a stale runId is refused', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const { runId } = await collecting(s, dir);
    const bad = async (kind, obj) => (await channel(dir, ['post', kind, '--json', JSON.stringify({ runId, ...obj })])).json;
    assert.strictEqual((await bad('phase', { name: 'dance' })).error, 'bad-phase');
    assert.strictEqual((await bad('value', { param: 'nope', value: 1, source: 'ui' })).error, 'unknown-param');
    assert.strictEqual((await bad('value', { param: 'petId', value: 1, source: 'manual' })).error, 'bad-source');
    assert.strictEqual((await bad('gate', { kind: 'puzzle' })).error, 'bad-gate');
    assert.strictEqual((await bad('proposal', { items: [] })).error, 'bad-items');
    assert.strictEqual((await bad('teleport', {})).error, 'unknown-kind');
    const stale = await channel(dir, ['post', 'phase', '--json', JSON.stringify({ runId: 'c99', name: 'walk' })]);
    assert.strictEqual(stale.json.error, 'stale-run');
    const ok = await channel(dir, ['post', 'value', '--json', JSON.stringify({ runId, param: 'petId', value: 7, source: 'ui', user: 'qa_user_a', provenance: { screen: 'Pets list', call: 'GET /v1/pets?status=sold' } })]);
    assert.strictEqual(ok.code, 0, ok.out);
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual(st.values.petId, { value: 7, source: 'ui', user: 'qa_user_a', provenance: { screen: 'Pets list', call: 'GET /v1/pets?status=sold' } });
  });

  await test('a credential-shaped value is rejected: JWT, header token, or the held token', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const { runId } = await collecting(s, dir);
    const held = 'opaque-held-token-1234567890';
    await s.agent('POST', '/api/agent/token', { token: held, scheme: 'bearer' });
    for (const value of ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2ln', 'Bearer abcdefghijkl', `x-${held}-y`, { accessToken: 'abc' }]) {
      const r = await channel(dir, ['post', 'value', '--json', JSON.stringify({ runId, param: 'status', value, source: 'ui' })]);
      assert.strictEqual(r.json.error, 'credential-shaped', JSON.stringify(value));
      assert.strictEqual(r.code, 1);
    }
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.ok(!JSON.stringify(st).includes(held));
    assert.strictEqual(st.token.present, true);
  });

  await test('--json - reads the payload from stdin', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const { runId } = await collecting(s, dir);
    const r = await channel(dir, ['post', 'missing', '--json', '-'], JSON.stringify({ runId, param: 'status', hint: 'no screen lists it' }));
    assert.strictEqual(r.json.ok, true, r.out);
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.missing.status.hint, 'no screen lists it');
  });

  await test('closing the studio answers a pending wait with closed; a later wait sees shutdown', async () => {
    const dir = project();
    const s = await wizardAt(dir);
    const pending = channel(dir, ['wait', '--timeout', '5000']);
    await new Promise(r => setTimeout(r, 300));
    await s.page('GET', '/api/done');
    const w = await pending;
    assert.deepStrictEqual(w.json, { event: 'closed', reason: 'done' }, w.out);
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!fs.existsSync(sessionFile(dir)));
  });

  await test('the session file is in the OS temp dir, 0600, outside the project', async () => {
    const dir = project();
    await studio(dir);
    const f = sessionFile(dir);
    assert.ok(f.startsWith(os.tmpdir()) && !f.startsWith(dir));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  });

  done();
})();
