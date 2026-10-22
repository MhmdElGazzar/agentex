'use strict';
// Tests for browser_bridge.js — capture / fill-secret / token-status, against a fake
// playwright-cli (golden/fake_playwright_cli.js, via AGENTEX_PLAYWRIGHT_CLI). Also the wizard's
// standard login: an { "envSecret" } password is typed by browser-driver's fill_secret.js (the
// same fake, via its AGENTEX_PWCLI_CMD seam), never by the bridge.
// Run: node skills/swagger-import/scripts/browser_bridge.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bridge-tmp-'));
const B = require('./browser_bridge.js');
const BRIDGE = path.join(__dirname, 'browser_bridge.js');
const SHIM = path.join(__dirname, 'golden', 'fake_playwright_cli.js');
const FILL_SECRET = path.join(__dirname, '..', '..', 'browser-driver', 'scripts', 'fill_secret.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack.split('\n').slice(0, 2).join(' | ')}`); }
}
const TOKEN = 'EVAL_SENTINEL_TOKEN_bridge_93c';
const PASSWORD = 'EVAL_SENTINEL_PASSWORD_bridge_17';
function proj(files, ignore = '.agentex/\ntest/.auth/\n') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bridge-')));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  return dir;
}
const CALLS = [
  { method: 'GET', url: 'https://api.example.test/v1/orders?page=1&session_id=abc123', status: 200,
    headers: { authorization: `Bearer ${TOKEN}`, cookie: 'sid=cookie-value-1', accept: 'application/json' },
    response: JSON.stringify({ items: [{ orderId: 1042, status: 'open', owner: { refreshToken: 'r-tok-1', note: `see ${TOKEN}` } }], jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxYSJ9.c2lnbmF0dXJl' }) },
  { method: 'POST', url: 'https://api.example.test/v1/orders/search', status: 200, headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ status: 'open', password: 'nope' }), response: '[]' },
];
function bridge(dir, args, env = {}) {
  return new Promise(resolve => {
    const log = path.join(dir, '..', `${path.basename(dir)}-shim.log`);
    const calls = path.join(dir, '..', `${path.basename(dir)}-calls.json`);
    fs.writeFileSync(calls, JSON.stringify(CALLS));
    const p = spawn(process.execPath, [BRIDGE, ...args, '--project', dir], { env: { ...process.env, AGENTEX_PLAYWRIGHT_CLI: SHIM, SHIM_LOG: log, SHIM_CALLS: calls, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
      resolve({ code, json, out, err, argv: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' });
    });
  });
}
const CAPTURE = ['capture', '--session', 'agentex-collect', '--api-origin', 'https://api.example.test', '--goto', 'https://app.example.test/orders', '--wait-ms', '10'];

(async () => {
  await test('redaction: secret headers dropped, secret-named keys, JWT-shaped strings and the exact token value', async () => {
    const r = B.redactCalls(CALLS, { secrets: [TOKEN] });
    const text = JSON.stringify(r);
    assert.ok(!text.includes(TOKEN) && !text.includes('cookie-value-1') && !text.includes('r-tok-1') && !text.includes('eyJhbGci') && !text.includes('abc123') && !text.includes('"nope"'));
    assert.ok(!('headers' in r[0]));
    assert.strictEqual(r[0].responseBody.items[0].orderId, 1042);
    assert.strictEqual(r[0].responseBody.items[0].owner.note, 'see [redacted]');
    assert.strictEqual(r[1].requestBody.status, 'open');
  });

  await test('redaction: an application/x-www-form-urlencoded body has its secret-named keys redacted, the rest kept', async () => {
    const calls = [
      { method: 'POST', url: 'https://api.example.test/connect/token', status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=password&username=qa_user_a&password=${PASSWORD}&client_secret=cs-value-9&scope=orders+read`,
        response: `access_token=at-value-7&token_type=bearer&expires_in=3600` },
      { method: 'POST', url: 'https://api.example.test/login', status: 302, body: `user%5Bname%5D=qa&user%5Bpassword%5D=${PASSWORD}` },
    ];
    const r = B.redactCalls(calls);
    const text = JSON.stringify(r);
    for (const secret of [PASSWORD, 'cs-value-9', 'at-value-7']) assert.ok(!text.includes(secret), secret);
    assert.strictEqual(r[0].requestBody, 'grant_type=password&username=qa_user_a&password=[redacted]&client_secret=[redacted]&scope=orders+read');
    assert.strictEqual(r[0].responseBody, 'access_token=[redacted]&token_type=[redacted]&expires_in=3600'); // same key rule as JSON bodies
    assert.strictEqual(r[1].requestBody, 'user%5Bname%5D=qa&user%5Bpassword%5D=[redacted]');
    // plain text that only looks like a sentence is left alone
    assert.strictEqual(B.redactCalls([{ method: 'POST', url: 'https://x.test/', body: 'hello world' }])[0].requestBody, 'hello world');
  });

  await test('single-use loopback handle: 127.0.0.1, random path, second GET 404, wrong path 404', async () => {
    const h = await B.serveOnce(PASSWORD);
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    assert.strictEqual(h.srv.address().address, '127.0.0.1');
    const get = u => new Promise(res => http.get(u, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }));
    const wrong = await get(h.url.replace(/\/[0-9a-f]+$/, '/nope'));
    const first = await get(h.url);
    const second = await get(h.url);
    h.close();
    assert.deepStrictEqual([wrong.status, first.status, first.body, second.status], [404, 200, PASSWORD, 404]);
  });

  await test('capture --store: the token is written 0600 with schemaVersion; stdout and the composed run-code never contain it', async () => {
    const dir = proj({});
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.deepStrictEqual(r.json.token, { seen: true, scheme: 'bearer', delivered: 'store', ref: 'orders-qc' });
    assert.strictEqual(r.json.callCount, 2);
    const f = path.join(dir, 'test/.auth/api-tokens/orders-qc.json');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepStrictEqual([rec.schemaVersion, rec.token, rec.user, rec.scheme], [1, TOKEN, 'qa_user_a', 'bearer']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), 'stdout/stderr leak the token');
    assert.ok(!r.argv.includes(TOKEN), 'the composed command line carries the token');
    assert.match(r.argv, /run-code/);
    assert.match(r.argv, /page\.request\.post\(sink/);
  });

  await test('capture --store refuses when test/.auth/ is not gitignored; the browser is never driven', async () => {
    const dir = proj({}, 'node_modules/\n');
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.error, 'not-ignored');
    assert.strictEqual(r.argv, '');
    assert.ok(!fs.existsSync(path.join(dir, 'test')));
  });

  await test('capture --to-studio hands the token to the open studio over loopback; nothing printed', async () => {
    const { createStudio } = require('../../endpoint-testing/scripts/studio/server.js');
    const dir = proj({ 'environments/qc.json': { users: {} } });
    const st = await createStudio({ root: dir, port: 0, mode: 'wizard', mount: require('../../endpoint-testing/scripts/studio/wizard.js').mount, log: () => {} });
    try {
      const r = await bridge(dir, [...CAPTURE, '--to-studio']);
      assert.strictEqual(r.code, 0, r.out);
      assert.deepStrictEqual(r.json.token, { seen: true, scheme: 'bearer', delivered: 'studio' });
      assert.ok(!r.out.includes(TOKEN) && !r.argv.includes(TOKEN));
      assert.strictEqual(st.studio.wizard().token.value, TOKEN);
      assert.strictEqual(st.studio.wizard().token.apiOrigin, 'https://api.example.test');
    } finally { st.close(); }
  });

  await test('capture: a failing browser step is reported, not hidden', async () => {
    const dir = proj({});
    const r = await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a'], { SHIM_FAIL: '1' });
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.error, 'browser-failed');
  });

  await test('fill-secret (plain-string password only): served once over loopback, never on the command line or in the output', async () => {
    const dir = proj({ 'environments/qc.json': { defaults: { password: PASSWORD }, users: { qa_user_a: { email: 'qa_user_a@example.test' } } } });
    const filled = path.join(dir, '..', `${path.basename(dir)}-filled.json`);
    const second = path.join(dir, '..', `${path.basename(dir)}-second.txt`);
    const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FILLED: filled, SHIM_SECOND_GET: second });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.json, { ok: true, filled: true, submitted: true, user: 'qa_user_a', passwordFieldCleared: false });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filled, 'utf8')), { status: 200, value: PASSWORD });
    assert.strictEqual(fs.readFileSync(second, 'utf8'), '404');
    assert.ok(!r.out.includes(PASSWORD) && !r.err.includes(PASSWORD) && !r.argv.includes(PASSWORD));
    assert.match(r.argv, /button\[type=submit\]/);
  });

  await test('fill-secret (plain-string password): refused without --submit, naming the flag; filled and submitted with it', async () => {
    const dir = proj({ 'environments/qc.json': { users: { qa_user_a: { password: PASSWORD } } } });
    const filled = path.join(dir, '..', `${path.basename(dir)}-filled.json`);
    // without --submit: a typed password would sit in the field for the next snapshot to print
    const no = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a'], { SHIM_FILLED: filled });
    assert.strictEqual(no.code, 2, no.out);
    assert.strictEqual(no.json.ok, false);
    assert.strictEqual(no.json.error, 'submit-required');
    assert.match(no.json.message, /--submit <submit button>/);
    assert.strictEqual(no.argv, '', 'the browser was driven');
    assert.ok(!fs.existsSync(filled), 'the password was served');
    assert.ok(!no.out.includes(PASSWORD) && !no.err.includes(PASSWORD));
    // with --submit: typed and submitted in the same call
    const yes = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FILLED: filled });
    assert.strictEqual(yes.code, 0, yes.out);
    assert.deepStrictEqual(yes.json, { ok: true, filled: true, submitted: true, user: 'qa_user_a', passwordFieldCleared: false });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filled, 'utf8')), { status: 200, value: PASSWORD });
    assert.ok(!yes.out.includes(PASSWORD) && !yes.err.includes(PASSWORD) && !yes.argv.includes(PASSWORD));
  });

  await test('fill-secret --submit (plain-string password): a password field still filled after submit is cleared and reported (wrong password, same-page OTP)', async () => {
    const dir = proj({ 'environments/qc.json': { users: { qa_user_a: { password: PASSWORD } } } });
    const field = path.join(dir, '..', `${path.basename(dir)}-field.json`);
    const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FIELD: field, SHIM_STAY_ON_PAGE: '1' });
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.json.passwordFieldCleared, true);
    assert.match(r.json.message, /fill-secret/);
    const f = JSON.parse(fs.readFileSync(field, 'utf8'));
    assert.deepStrictEqual(f.clicks, ['button[type=submit]']);
    assert.strictEqual(f.value, '', 'the field is empty when the bridge returns');
    assert.ok(f.sawPassword, 'the field held the password before submit');
    assert.ok(!r.out.includes(PASSWORD) && !r.err.includes(PASSWORD) && !r.argv.includes(PASSWORD));
    // the page moved on: nothing to clear
    const gone = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FIELD: field });
    assert.strictEqual(gone.json.passwordFieldCleared, false);
    // a field that refuses to clear is reported, never claimed cleared
    const stuck = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]'], { SHIM_FIELD: field, SHIM_STAY_ON_PAGE: '1', SHIM_FIELD_STUCK: '1' });
    assert.strictEqual(stuck.json.passwordFieldCleared, false);
    assert.strictEqual(stuck.json.passwordFieldStillFilled, true);
    assert.ok(!stuck.out.includes(PASSWORD));
  });

  await test('fill-secret refuses an { envSecret } password before touching the browser and names the fill_secret.js call', async () => {
    for (const env of [
      { defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { qa_user_a: { email: 'qa_user_a@example.test' } } },
      { defaults: { password: 'not-this-one' }, users: { qa_user_a: { password: { envSecret: 'QA_PASSWORD' } } } },
    ]) {
      const dir = proj({ 'environments/qc.json': env, '.env': `QA_PASSWORD=${PASSWORD}\n` });
      const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]']);
      assert.strictEqual(r.code, 2, r.out);
      assert.strictEqual(r.json.error, 'use-fill-secret');
      assert.strictEqual(r.json.envVar, 'QA_PASSWORD');
      assert.strictEqual(r.json.command, `node ${FILL_SECRET} --session agentex-collect --target '#password' --env-var QA_PASSWORD --env qc --submit-target 'button[type=submit]'`);
      assert.strictEqual(r.json.commandPowerShell, `node ${FILL_SECRET} --session agentex-collect --target '#password' --env-var QA_PASSWORD --env qc --submit-target 'button[type=submit]'`);
      assert.strictEqual(r.argv, '', 'the browser was driven');
      assert.ok(!r.out.includes(PASSWORD) && !r.err.includes(PASSWORD));
    }
    // without --submit, the named call submits with Enter
    const dir = proj({ 'environments/qc.json': { defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { qa_user_a: {} } } });
    const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', 'e4', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.json.command, `node ${FILL_SECRET} --session agentex-collect --target e4 --env-var QA_PASSWORD --env qc --submit`);
    assert.strictEqual(r.json.commandPowerShell, `node ${FILL_SECRET} --session agentex-collect --target e4 --env-var QA_PASSWORD --env qc --submit`);
  });

  await test('use-fill-secret: the text says to run from the project root and gives a POSIX and a PowerShell form', async () => {
    const dir = proj({ 'environments/qc.json': { defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { qa_user_a: {} } } });
    const r = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]']);
    assert.strictEqual(r.json.error, 'use-fill-secret');
    assert.strictEqual(r.json.cwd, dir);
    assert.ok(r.json.message.includes(`from the project root (${dir})`), r.json.message);
    assert.match(r.json.message, /"command" in a POSIX shell/);
    assert.match(r.json.message, /"commandPowerShell" in PowerShell/);
    // PowerShell quoting: single quotes, an embedded ' doubled; a leading # or @ is quoted
    const locator = `input[name='pass word']`, submit = `text="Sign in"`;
    const fs1 = 'C:\\Tools\\agentex\\fill_secret.js';
    assert.strictEqual(B.fillSecretCommandPowerShell({ session: 'agentex-collect', locator, envVar: 'QA_PASSWORD', env: 'qc', submit }).replace(/^node \S+/, 'node X'),
      `node X --session agentex-collect --target 'input[name=''pass word'']' --env-var QA_PASSWORD --env qc --submit-target 'text="Sign in"'`);
    assert.strictEqual(B.psq(fs1), fs1, 'a Windows path with no space needs no quotes');
    assert.strictEqual(B.psq('C:\\Program Files\\x.js'), `'C:\\Program Files\\x.js'`);
    assert.strictEqual(B.psq('@e4'), `'@e4'`);
    assert.strictEqual(B.psq('#p'), `'#p'`);
  });

  if (process.platform !== 'win32') {
    await test('the named fill_secret.js call survives the shell: quotes and spaces in a locator reach argv unchanged', async () => {
      const locator = `input[name='pass word']`, submit = `text="Sign in"`;
      const cmd = B.fillSecretCommand({ session: 'agentex-collect', locator, envVar: 'QA_PASSWORD', env: 'qc', submit });
      const echoed = execFileSync('/bin/sh', ['-c', cmd.replace(/^node \S+/, `${JSON.stringify(process.execPath)} -e "console.log(JSON.stringify(process.argv.slice(1)))" --`)], { encoding: 'utf8' });
      assert.deepStrictEqual(JSON.parse(echoed), ['--session', 'agentex-collect', '--target', locator, '--env-var', 'QA_PASSWORD', '--env', 'qc', '--submit-target', submit]);
    });
  }

  // The wizard's standard login, end to end: the bridge names the call, the agent runs it as
  // given, fill_secret.js types the .env value into the field and submits. The value never
  // reaches argv, stdout/stderr, .playwright-cli/ or a temp file; after a same-page failure the
  // field is scrubbed, so the snapshot playwright-cli writes next shows it empty.
  const fillSecretLogin = (dir, stayOnPage) => new Promise(resolve => {
    const log = path.join(dir, '..', `${path.basename(dir)}-fs-shim.log`);
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bridge-fs-tmp-'));
    (async () => {
      const named = await bridge(dir, ['fill-secret', '--session', 'agentex-collect', '--locator', '#password', '--env', 'qc', '--user', 'qa_user_a', '--submit', 'button[type=submit]']);
      const env = { ...process.env, AGENTEX_PWCLI_CMD: SHIM, SHIM_LOG: log, TMPDIR: tdir, TEMP: tdir, TMP: tdir };
      delete env.QA_PASSWORD; delete env.SHIM_STAY_ON_PAGE;
      if (stayOnPage) env.SHIM_STAY_ON_PAGE = '1';
      const p = spawn('/bin/sh', ['-c', named.json.command], { cwd: dir, env });
      let out = '', err = '';
      p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
      p.on('close', code => {
        let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
        resolve({ code, json, out, err, named, tdir, argv: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' });
      });
    })();
  });
  const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '.git') walk(f, acc); } else acc.push(f); } return acc; };
  const WIZARD_ENV = { portalUrl: 'https://app.example.test', defaults: { password: { envSecret: 'QA_PASSWORD' } }, users: { qa_user_a: { email: 'qa_user_a@example.test' } } };

  if (process.platform !== 'win32') {
    await test('envSecret login through fill_secret.js: typed and submitted in one call; the value is nowhere but the field', async () => {
      const dir = proj({ 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': WIZARD_ENV, '.env': `QA_PASSWORD=${PASSWORD}\n` });
      const r = await fillSecretLogin(dir, false);
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.deepStrictEqual(r.json, { result: 'PASS', envVar: 'QA_PASSWORD', targets: 1, masked: [true], submitted: true, scrubbed: 0 });
      assert.match(r.argv, /run-code/);
      assert.match(r.argv, /--filename=/);
      for (const [label, text] of [['stdout', r.out], ['stderr', r.err], ['the CLI argv', r.argv], ['the bridge output', r.named.out + r.named.err]]) assert.ok(!text.includes(PASSWORD), `password in ${label}`);
      const files = [...walk(dir).filter(f => path.basename(f) !== '.env'), ...walk(r.tdir)];
      assert.ok(files.some(f => f.includes(`${path.sep}.playwright-cli${path.sep}`)), 'the fake wrote no snapshot');
      for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(PASSWORD), `password in ${f}`);
      assert.deepStrictEqual(walk(r.tdir), [], 'a temp file outlived the call');
    });

    await test('envSecret login through fill_secret.js: the page did not move on (wrong password, same-page OTP) -> scrubbed, and the next snapshot shows the field empty', async () => {
      const dir = proj({ 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': WIZARD_ENV, '.env': `QA_PASSWORD=${PASSWORD}\n` });
      const r = await fillSecretLogin(dir, true);
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.strictEqual(r.json.submitted, true);
      assert.strictEqual(r.json.scrubbed, 1);
      const snaps = walk(path.join(dir, '.playwright-cli'));
      assert.strictEqual(snaps.length, 1);
      assert.match(fs.readFileSync(snaps[0], 'utf8'), /textbox "Password" \[ref=e4\]: \n/);
      for (const f of walk(dir).filter(f => path.basename(f) !== '.env')) assert.ok(!fs.readFileSync(f, 'utf8').includes(PASSWORD), `password in ${f}`);
      assert.ok(!r.out.includes(PASSWORD) && !r.err.includes(PASSWORD) && !r.argv.includes(PASSWORD));
    });

    await test('envSecret login through fill_secret.js: an unset variable is BLOCKED secret-unavailable before the browser, naming the variable', async () => {
      const dir = proj({ 'config/project.json': { defaultEnvironment: 'qc' }, 'environments/qc.json': WIZARD_ENV });
      const r = await fillSecretLogin(dir, false);
      assert.strictEqual(r.code, 2);
      assert.strictEqual(r.json.reason, 'secret-unavailable');
      assert.match(r.json.detail, /QA_PASSWORD/);
      assert.strictEqual(r.argv, '');
    });
  }

  await test('fill-secret: an unknown user or no password -> refused without touching the browser', async () => {
    const dir = proj({ 'environments/qc.json': { users: { qa_user_a: {} } } });
    const r = await bridge(dir, ['fill-secret', '--session', 's', '--locator', '#p', '--env', 'qc', '--user', 'qa_user_a']);
    assert.strictEqual(r.json.error, 'no-password');
    const u = await bridge(dir, ['fill-secret', '--session', 's', '--locator', '#p', '--env', 'qc', '--user', 'qa_user_b']);
    assert.match(u.json.message, /qa_user_b/);
    assert.strictEqual(r.argv + u.argv, '');
  });

  await test('token-status: owner and times only', async () => {
    const dir = proj({});
    await bridge(dir, [...CAPTURE, '--store', 'orders', '--env', 'qc', '--user', 'qa_user_a']);
    const r = await bridge(dir, ['token-status', '--store', 'orders', '--env', 'qc']);
    assert.strictEqual(r.json.present, true);
    assert.strictEqual(r.json.user, 'qa_user_a');
    assert.ok(!r.out.includes(TOKEN));
    const none = await bridge(dir, ['token-status', '--store', 'orders', '--env', 'uat']);
    assert.strictEqual(none.json.present, false);
  });

  await test('the composed run-code is one line and holds only loopback URLs and locators', async () => {
    const code = B.captureCode({ apiOrigin: 'https://api.example.test', sinkUrl: 'http://127.0.0.1:1/abc', goto: 'https://app.example.test/x', waitMs: 10 });
    assert.ok(!code.includes('\n'));
    assert.ok(!B.fillCode({ handleUrl: 'http://127.0.0.1:1/abc', locator: '#p' }).includes('\n'));
    assert.ok(!B.fillCode({ handleUrl: 'http://127.0.0.1:1/abc', locator: '#p', submit: '#go' }).includes('\n'));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
