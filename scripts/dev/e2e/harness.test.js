'use strict';
// Tests for the e2e harness (harness.js) and the fixture app (fixture_app.js). No browser is
// needed here: the finder is exercised on fake node_modules folders, the cleanup on probe
// scripts that force a throw and the watchdog. Run: node scripts/dev/e2e/harness.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HARNESS = path.join(__dirname, 'harness.js');
const FIXTURE = path.join(__dirname, 'fixture_app.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-e2e-harness-test-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const mk = (label) => { const d = path.join(scratch, `${label}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };

// A node_modules folder shaped like the real one: playwright + @playwright/cli (+ its playwright-core).
// `chromium` false makes the reported Chromium executable a path that does not exist.
function fakeModules(dir, { pw = true, cli = true, chromium = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'fake-chromium');
  if (chromium) fs.writeFileSync(exe, '#!/bin/sh\n');
  const lib = `module.exports = { chromium: { executablePath: () => ${JSON.stringify(exe)} } };\n`;
  const pkg = (name, extra = {}) => { const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js', ...extra })); fs.writeFileSync(path.join(d, 'index.js'), lib); return d; };
  if (pw) pkg('playwright');
  if (cli) { const d = pkg('@playwright/cli', { bin: { 'playwright-cli': 'playwright-cli.js' } }); fs.writeFileSync(path.join(d, 'playwright-cli.js'), '\n'); pkg('playwright-core'); }
  return dir;
}
const bump = (dir, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(dir, t, t); };

function child(file, args = [], env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [file, ...args], { env: { ...process.env, AGENTEX_E2E_REQUIRE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, out }));
  });
}
const probe = (name, body) => { const f = path.join(mk('probe'), name); fs.writeFileSync(f, `'use strict';\nconst h = require(${JSON.stringify(HARNESS)});\n${body}\n`); return f; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
});
const post = (port, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); r.end();
});

(async () => {
  // ---- the skip protocol (AC4): the first thing written ------------------------------------
  const skipProbe = probe('skip.js', "h.requireDeps(); console.log('FOUND');");
  await test('a node_modules folder with no Chromium-capable playwright gives SKIP: exit 77 and the reason', async () => {
    const empty = mk('empty');
    const r = await child(skipProbe, [], { AGENTEX_E2E_NODE_MODULES: empty, AGENTEX_E2E_REQUIRE: '' });
    assert.strictEqual(r.status, 77, r.out);
    assert.match(r.out, /^SKIP: .*playwright/m);
    assert.match(r.out, /AGENTEX_E2E_NODE_MODULES/);
    assert.match(r.out, /npx playwright install chromium/);
    assert.doesNotMatch(r.out, /FOUND/);
  });
  await test('AGENTEX_E2E_REQUIRE=1 turns the same skip into FAIL: exit 1 naming the missing piece', async () => {
    const r = await child(skipProbe, [], { AGENTEX_E2E_NODE_MODULES: mk('empty'), AGENTEX_E2E_REQUIRE: '1' });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /^FAIL: e2e required: .*playwright/m);
    assert.doesNotMatch(r.out, /^SKIP:/m);
  });
  await test('playwright without @playwright/cli: the reason names the CLI', async () => {
    const r = await child(skipProbe, [], { AGENTEX_E2E_NODE_MODULES: fakeModules(mk('nocli'), { cli: false }) });
    assert.strictEqual(r.status, 77, r.out);
    assert.match(r.out, /^SKIP: .*@playwright\/cli/m);
  });
  await test('both packages but no Chromium executable: the reason names chromium and the install command', async () => {
    const r = await child(skipProbe, [], { AGENTEX_E2E_NODE_MODULES: fakeModules(mk('nochromium'), { chromium: false }) });
    assert.strictEqual(r.status, 77, r.out);
    assert.match(r.out, /^SKIP: .*chromium/mi);
    assert.match(r.out, /npx playwright install chromium/);
  });
  await test('a complete folder is found', async () => {
    const r = await child(skipProbe, [], { AGENTEX_E2E_NODE_MODULES: fakeModules(mk('good')) });
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /FOUND/);
  });

  // ---- the finder order and its read-only rule ----------------------------------------------
  const { find } = require(HARNESS);
  await test('AGENTEX_E2E_NODE_MODULES, when set, is the only place looked at', () => {
    const home = mk('home'); fakeModules(path.join(home, '.npm', '_npx', 'a', 'node_modules'));
    const repo = mk('repo'); fakeModules(path.join(repo, 'node_modules'));
    const r = find({ env: { AGENTEX_E2E_NODE_MODULES: mk('empty') }, home, repoRoot: repo });
    assert.strictEqual(r.missing, 'playwright');
    assert.ok(!r.nodeModules);
  });
  await test('the repo root and its parents come before the npx cache', () => {
    const home = mk('home'); fakeModules(path.join(home, '.npm', '_npx', 'a', 'node_modules'));
    const top = mk('mono'); const nm = fakeModules(path.join(top, 'node_modules'));
    const deep = path.join(top, 'a', 'b'); fs.mkdirSync(deep, { recursive: true });
    const r = find({ env: {}, home, repoRoot: deep });
    assert.strictEqual(fs.realpathSync(r.nodeModules), fs.realpathSync(nm));
  });
  await test('the npx cache: the newest folder holding BOTH packages wins, a newer one without the CLI is passed over', () => {
    const home = mk('home'); const cache = path.join(home, '.npm', '_npx');
    const oldGood = fakeModules(path.join(cache, 'old', 'node_modules')); bump(path.join(cache, 'old', 'node_modules'), 300);
    const newGood = fakeModules(path.join(cache, 'new', 'node_modules')); bump(path.join(cache, 'new', 'node_modules'), 100);
    fakeModules(path.join(cache, 'newest', 'node_modules'), { cli: false }); bump(path.join(cache, 'newest', 'node_modules'), 10);
    const r = find({ env: {}, home, repoRoot: mk('norepo') });
    assert.strictEqual(r.nodeModules, newGood);
    assert.notStrictEqual(r.nodeModules, oldGood);
  });
  await test('find() reads only: the cache folder is byte-for-byte the same afterwards', () => {
    const home = mk('home'); const nm = fakeModules(path.join(home, '.npm', '_npx', 'a', 'node_modules'));
    const tree = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => { const s = fs.statSync(path.join(d, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('\n');
    const before = tree(path.join(home, '.npm'));
    find({ env: {}, home, repoRoot: mk('norepo') });
    assert.strictEqual(tree(path.join(home, '.npm')), before);
    assert.ok(fs.existsSync(nm));
  });
  await test('nothing found anywhere: a missing piece with the places looked at', () => {
    const r = find({ env: {}, home: mk('home'), repoRoot: mk('norepo') });
    assert.strictEqual(r.missing, 'playwright');
    assert.ok(r.where);
  });

  // ---- the project, cleanup and the watchdog (AC9) ------------------------------------------
  const fakeGood = fakeModules(mk('fakegood'));
  const sleeper = path.join(mk('sleeper'), 'sleeper.js');
  fs.writeFileSync(sleeper, "console.log('ready'); setInterval(() => {}, 1000);\n");
  const cleanupProbe = (caseBody, opts = '') => probe('cleanup.js', `
const fs = require('node:fs');
const fx = h.requireDeps();
const p = h.project({ files: { 'config/project.json': { defaultEnvironment: 'qa' } } });
(async () => {
  const kid = await h.startChild(${JSON.stringify(sleeper)}, [], { readyLine: /ready/ });
  const fixture = await h.startFixture();
  fs.writeFileSync(process.argv[2], JSON.stringify({ root: p.root, dir: p.dir, tmp: p.tmp, pid: kid.child.pid, port: fixture.port, nm: fs.realpathSync(p.dir + '/node_modules'), tmpReal: fs.realpathSync(p.tmp), ignore: fs.readFileSync(p.dir + '/.gitignore', 'utf8'), cfg: fs.readFileSync(p.dir + '/config/project.json', 'utf8'), tmpdir: fs.realpathSync(require('node:os').tmpdir()) }));
  h.run([${caseBody}]${opts});
})();`);
  const readInfo = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

  await test('project(): own TMPDIR, a node_modules symlink, .gitignore with test/.auth/, the given files', async () => {
    const info = path.join(mk('info'), 'info.json');
    const r = await child(cleanupProbe("['fine', async () => {}]"), [info], { AGENTEX_E2E_NODE_MODULES: fakeGood });
    assert.strictEqual(r.status, 0, r.out);
    const i = readInfo(info);
    assert.strictEqual(i.nm, fs.realpathSync(fakeGood));
    assert.match(i.ignore, /^test\/\.auth\/$/m);
    assert.deepStrictEqual(JSON.parse(i.cfg), { defaultEnvironment: 'qa' });
    assert.ok(i.tmp.startsWith(i.root) && i.dir.startsWith(i.root), 'project and TMPDIR sit under one temp root');
    assert.strictEqual(i.tmpdir, i.tmpReal, 'the process tmpdir is the file\'s own');
  });
  await test('after a pass: no temp root, child or fixture server is left; ok - line printed', async () => {
    const info = path.join(mk('info'), 'info.json');
    const r = await child(cleanupProbe("['fine', async () => {}]"), [info], { AGENTEX_E2E_NODE_MODULES: fakeGood });
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /ok - fine/);
    const i = readInfo(info);
    assert.ok(!fs.existsSync(i.root), 'temp root removed');
    assert.ok(!alive(i.pid), 'child stopped');
    await assert.rejects(get(i.port, '/login'), 'fixture closed');
  });
  await test('after a forced throw: exit 1, the failing case is named, and everything is still cleaned up', async () => {
    const info = path.join(mk('info'), 'info.json');
    const r = await child(cleanupProbe("['boom case', async () => { throw new Error('forced'); }], ['after', async () => {}]"), [info], { AGENTEX_E2E_NODE_MODULES: fakeGood });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /FAIL - boom case: .*forced/);
    const i = readInfo(info);
    assert.ok(!fs.existsSync(i.root), 'temp root removed');
    assert.ok(!alive(i.pid), 'child stopped');
    await assert.rejects(get(i.port, '/login'), 'fixture closed');
  });
  await test('the watchdog ends a hung case: exit 1, "watchdog" named, nothing left behind', async () => {
    const info = path.join(mk('info'), 'info.json');
    const r = await child(cleanupProbe("['hangs', () => new Promise(() => {})]", ', { watchdogMs: 1200 }'), [info], { AGENTEX_E2E_NODE_MODULES: fakeGood });
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /watchdog/i);
    const i = readInfo(info);
    assert.ok(!fs.existsSync(i.root), 'temp root removed');
    await sleep(300);
    assert.ok(!alive(i.pid), 'child stopped');
  });


  // ---- a detached process tree and the socket dir are gone after every way of ending ------------
  // The stand-in for a CLI session daemon: a detached node whose own child (the "browser") outlives a plain kill.
  const treeProbe = (ending) => probe('tree.js', `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
h.requireDeps();
const p = h.project({});
const daemon = spawn(process.execPath, ['-e', "const {spawn}=require('child_process');const k=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(k.pid);setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
daemon.stdout.once('data', (d) => {
  h.adopt(daemon.pid, 'stub daemon');
  fs.writeFileSync(process.argv[2], JSON.stringify({ daemon: daemon.pid, browser: Number(String(d).trim()), sockets: p.env().PWTEST_SOCKETS_DIR || null, root: p.root }));
  ${ending}
});`);
  const endings = {
    'a failed assertion': "h.run([['fails', async () => { throw new Error('forced'); }]]);",
    'SIGTERM mid-case': "h.run([['hangs', () => new Promise(() => {})]]); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);",
    'an uncaught exception': "h.run([['hangs', () => new Promise(() => {})]]); setTimeout(() => { throw new Error('late'); }, 300);",
  };
  for (const [label, ending] of Object.entries(endings)) {
    await test(`after ${label}: the detached daemon, its child, the socket dir and the temp root are all gone`, async () => {
      const info = path.join(mk('info'), 'info.json');
      const r = await child(treeProbe(ending), [info], { AGENTEX_E2E_NODE_MODULES: fakeGood });
      assert.notStrictEqual(r.status, 0, r.out);
      const i = readInfo(info);
      assert.ok(!alive(i.daemon), 'daemon killed');
      assert.ok(!alive(i.browser), 'its child killed');
      if (i.sockets) assert.ok(!fs.existsSync(i.sockets), 'socket dir removed');
      assert.ok(!fs.existsSync(i.root), 'temp root removed');
    });
  }

  // ---- scanOutputs ---------------------------------------------------------------------------
  const { scanOutputs } = require(HARNESS);
  await test('scanOutputs: clean outputs and files pass; a sentinel in an output or in a file under dir fails, without echoing it', () => {
    const dir = mk('scan'); fs.writeFileSync(path.join(dir, 'a.txt'), 'nothing here');
    scanOutputs(['sid-SENTINEL-1'], ['plain output', '{"ok":true}'], dir);
    assert.throws(() => scanOutputs(['sid-SENTINEL-1'], ['x sid-SENTINEL-1 y'], dir), (e) => /output #0/.test(e.message) && !e.message.includes('sid-SENTINEL-1'));
    fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'b.json'), '{"t":"sid-SENTINEL-1"}');
    assert.throws(() => scanOutputs(['sid-SENTINEL-1'], [], dir), (e) => /b\.json/.test(e.message) && !e.message.includes('sid-SENTINEL-1'));
  });

  // ---- the fixture app -----------------------------------------------------------------------
  const { startFixture } = require(FIXTURE);
  await test('fixture: /login has #sign-in and a password input; POST /login sets an HttpOnly sid and writes the token', async () => {
    const f = await startFixture();
    try {
      const login = await get(f.port, '/login');
      assert.match(login.body, /id="sign-in"/); assert.match(login.body, /type="password"/);
      const r = await post(f.port, '/login');
      const cookie = String(r.headers['set-cookie']);
      assert.match(cookie, /^sid=sid-[0-9a-f]+; HttpOnly; SameSite=Lax; Path=\//);
      const { sids, tokens } = f.issued();
      assert.strictEqual(sids.length, 1); assert.strictEqual(tokens.length, 1);
      assert.ok(r.body.includes(`localStorage.setItem('token', "${tokens[0]}")`));
      assert.ok(cookie.includes(sids[0]));
    } finally { await f.close(); }
  });
  await test('fixture: #account-menu only with a valid sid; /api/me needs the bearer token; invalidate() drops every session', async () => {
    const f = await startFixture();
    try {
      assert.doesNotMatch((await get(f.port, '/')).body, /account-menu/);
      await post(f.port, '/login');
      const sid = f.issued().sids[0]; const token = f.issued().tokens[0];
      const home = await get(f.port, '/', { cookie: `sid=${sid}` });
      assert.match(home.body, /id="account-menu"/); assert.match(home.body, /Authorization: 'Bearer '/);
      assert.strictEqual((await get(f.port, '/api/me')).status, 401);
      assert.strictEqual((await get(f.port, '/api/me', { authorization: 'Bearer nope' })).status, 401);
      const me = await get(f.port, '/api/me', { authorization: `Bearer ${token}` });
      assert.strictEqual(me.status, 200); assert.deepStrictEqual(JSON.parse(me.body), { user: 'buyer' });
      f.invalidate();
      assert.doesNotMatch((await get(f.port, '/', { cookie: `sid=${sid}` })).body, /account-menu/);
      assert.strictEqual((await get(f.port, '/api/me', { authorization: `Bearer ${token}` })).status, 401);
    } finally { await f.close(); }
  });
  await test('fixture: rejectApi(on) answers 401 to every token while the session holds; requests() logs method + path only', async () => {
    const f = await startFixture();
    try {
      await post(f.port, '/login');
      const sid = f.issued().sids[0]; const token = f.issued().tokens[0];
      f.rejectApi(true);
      assert.match((await get(f.port, '/', { cookie: `sid=${sid}` })).body, /account-menu/);
      assert.strictEqual((await get(f.port, '/api/me', { authorization: `Bearer ${token}` })).status, 401);
      f.rejectApi(false);
      assert.strictEqual((await get(f.port, '/api/me', { authorization: `Bearer ${token}` })).status, 200);
      assert.deepStrictEqual(f.requests(), ['POST /login', 'GET /', 'GET /api/me', 'GET /api/me']);
      assert.ok(f.origin.startsWith('http://127.0.0.1:'));
    } finally { await f.close(); }
  });

  // ---- the library browser (only when a real Chromium is found) ------------------------------
  await test('libBrowser: a request to any host but 127.0.0.1 is aborted and recorded; the fixture page loads', async () => {
    const found = find();
    if (found.missing) { console.log(`  (skipped inside this test: ${found.missing} not found)`); return; }
    const out = path.join(mk('lb'), 'lb.json');
    const f = probe('lb.js', `
const fs = require('node:fs');
h.requireDeps();
h.project({});
h.run([['browser', async () => {
  const fx = await h.startFixture();
  const lb = await h.libBrowser();
  const page = await lb.context().then((c) => c.newPage());
  await page.goto(fx.origin + '/login');
  const ok = await page.locator('#sign-in').count();
  let external = 'no error';
  await page.goto('http://example.invalid/x').catch((e) => { external = String(e.message).split('\\n')[0]; });
  fs.writeFileSync(process.argv[2], JSON.stringify({ ok, external, seen: lb.external() }));
}]]);`);
    const r = await child(f, [out]);
    assert.strictEqual(r.status, 0, r.out);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(j.ok, 1);
    assert.deepStrictEqual(j.seen, ['http://example.invalid/x']);
    assert.match(j.external, /ERR_FAILED|aborted|net::/i);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
