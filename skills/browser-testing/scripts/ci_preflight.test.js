'use strict';
// Tests for ci_preflight.js — the CI-gating preflight: six checks, one JSON line,
// exit 0 (all gating checks pass) or exit 2 with named preflight-* reasons.
//
// The core promise under test: every environment/config failure here is exit 2,
// NEVER exit 1 — a broken environment must never masquerade as product defects.
// Secrets are reported by NAME only; a sentinel VALUE must appear in zero bytes
// of output.
//
// Run: node skills/browser-testing/scripts/ci_preflight.test.js
// Offline: local http server as the target; playwright-cli probe injected via the
// AGENTEX_PWCLI_PROBE_CMD seam; browsers dir via PLAYWRIGHT_BROWSERS_PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'ci_preflight.js');
let passed = 0; const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok - ${name}`); },
    (e) => { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); });
}

const SENTINEL = 'SENTINEL-secret-value-cipreflight-8f3a1c';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A working playwright-cli probe stub (version out, clean exit).
function pwcliStub(kind) {
  const dir = tmp('agentex-cipf-pwcli-');
  const file = path.join(dir, 'pwcli.js');
  const bodies = {
    ok: "process.stdout.write('0.1.18\\n');",
    benign: "process.stdout.write('0.1.18\\n'); process.stderr.write('Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)'); process.exitCode = 134;",
    broken: "process.stderr.write('npm ERR! could not determine executable to run\\n'); process.exitCode = 1;",
  };
  fs.writeFileSync(file, bodies[kind]);
  return `"${process.execPath}" "${file}"`;
}

// A browsers dir that passes the presence check.
function browsersDir() {
  const dir = tmp('agentex-cipf-browsers-');
  fs.mkdirSync(path.join(dir, 'chromium-1191'), { recursive: true });
  return dir;
}

// Fixture AgenTeX project.
function proj({ portalUrl = 'http://127.0.0.1:1/', config, envFile, dotenv, legacyOnly = false, integration } = {}) {
  const dir = tmp('agentex-cipf-proj-');
  if (!legacyOnly) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'),
      JSON.stringify(config || { name: 'sample', defaultEnvironment: 'qc' }));
    fs.mkdirSync(path.join(dir, 'environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'environments', 'qc.json'),
      JSON.stringify(envFile || { portalUrl, users: { valid_user: { password: { envSecret: 'QA_TESTER_PASSWORD' } } } }));
  }
  fs.writeFileSync(path.join(dir, '.env'), dotenv !== undefined ? dotenv : `QA_TESTER_PASSWORD=${SENTINEL}\n`);
  if (integration) {
    fs.mkdirSync(path.join(dir, 'integration'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'integration', 'sample_api.json'), JSON.stringify(integration));
  }
  return dir;
}

// Async spawn: the tests host the target http server in THIS process, so the
// event loop must stay free while the child runs (spawnSync would block it and
// every reachability check would time out).
function runPreflight(cwd, args = [], envExtra = {}) {
  const env = {
    ...process.env,
    AGENTEX_PWCLI_PROBE_CMD: envExtra.AGENTEX_PWCLI_PROBE_CMD || pwcliStub('ok'),
    PLAYWRIGHT_BROWSERS_PATH: envExtra.PLAYWRIGHT_BROWSERS_PATH || browsersDir(),
    ...envExtra,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
      resolve({ status, stdout, stderr, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null });
    });
  });
}

const codes = (j) => (j.blockedReasons || []).map((b) => b.code);

(async () => {
  // Local target the happy paths reach.
  const server = http.createServer((req, res) => {
    if (req.url === '/boom') { res.writeHead(500); res.end('kaboom'); return; }
    res.writeHead(200); res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await test('all checks green → exit 0, ok:true, ONE JSON line, all six checks reported', async () => {
    const r = await runPreflight(proj({ portalUrl: base }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(r.json.ok, true);
    for (const k of ['tools', 'target', 'environment', 'secrets', 'browser', 'pluginVersion']) {
      assert.ok(r.json.checks[k], `check ${k} present`);
    }
    assert.strictEqual(r.json.checks.environment.name, 'qc');
    assert.strictEqual(r.json.checks.pluginVersion.plugin && r.json.checks.pluginVersion.plugin.length > 0, true);
  });

  await test('secret VALUES never appear in any output — names only', async () => {
    const r = await runPreflight(proj({ portalUrl: base }));
    assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
    assert.ok(JSON.stringify(r.json.checks.secrets).includes('QA_TESTER_PASSWORD'), 'the NAME is reported');
  });

  await test('named environment with no file → exit 2 preflight-environment, never a silent fallback', async () => {
    const r = await runPreflight(proj({ portalUrl: base }), ['--env', 'nosuch']);
    assert.strictEqual(r.status, 2, `exit must be 2, never 1 (got ${r.status})`);
    assert.ok(codes(r.json).includes('preflight-environment'), JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json.blockedReasons), /qc/, 'available environments are listed');
    assert.strictEqual(r.lines.length, 1, 'one JSON line even on failure');
  });

  await test('nothing resolves (no --env, no defaultEnvironment, no legacy QA_TARGET_URL) → exit 2, named', async () => {
    const r = await runPreflight(proj({ config: { name: 'sample' }, dotenv: '' }));
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-environment'));
  });

  await test('legacy project (QA_TARGET_URL in .env, no config files) still preflights → exit 0', async () => {
    const r = await runPreflight(proj({ legacyOnly: true, dotenv: `QA_TARGET_URL=${base}\n` }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.checks.environment.name, null);
    assert.strictEqual(r.json.checks.environment.legacy, true);
  });

  await test('unreachable target → exit 2 preflight-target (NEVER exit 1)', async () => {
    const r = await runPreflight(proj({ portalUrl: 'http://127.0.0.1:9/' }));
    assert.notStrictEqual(r.status, 1, 'an environment failure must never be exit 1');
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-target'), JSON.stringify(r.json));
  });

  await test('a target answering HTTP 500 is REACHABLE (the app\'s problem to fail scenarios on)', async () => {
    const r = await runPreflight(proj({ portalUrl: `${base}/boom` }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.checks.target.ok, true);
  });

  await test('environment file without portalUrl → exit 2 preflight-target, named', async () => {
    const r = await runPreflight(proj({ envFile: { users: {} } }));
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-target'));
  });

  await test('missing secret NAMES (env file + integration catalog) → exit 2, names listed, values never', async () => {
    const dir = proj({
      portalUrl: base,
      dotenv: `QA_TESTER_PASSWORD=${SENTINEL}\n`,
      integration: { requests: { get_thing: { auth: { token: { envSecret: 'API_TOKEN_CI_TEST' } } } } },
      envFile: {
        portalUrl: base,
        defaults: { otp: '0000' },
        users: { valid_user: { password: { envSecret: 'QA_TESTER_PASSWORD' } }, admin: { token: { envSecret: 'ADMIN_TOKEN_CI_TEST' } } },
      },
    });
    const r = await runPreflight(dir);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.ok(codes(r.json).includes('preflight-secrets'));
    const s = JSON.stringify(r.json.checks.secrets);
    assert.match(s, /ADMIN_TOKEN_CI_TEST/);
    assert.match(s, /API_TOKEN_CI_TEST/);
    assert.ok(!s.includes('QA_TESTER_PASSWORD_MISSING'), 'present secrets are not in missing');
    assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
  });

  await test('broken playwright-cli → exit 2 preflight-tools (never 1)', async () => {
    const r = await runPreflight(proj({ portalUrl: base }), [], { AGENTEX_PWCLI_PROBE_CMD: pwcliStub('broken') });
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-tools'));
  });

  await test('the benign exit-crash posture holds in CI: version+crash probe → tools ok, exit 0', async () => {
    const r = await runPreflight(proj({ portalUrl: base }), [], { AGENTEX_PWCLI_PROBE_CMD: pwcliStub('benign') });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.checks.tools['playwright-cli'].ok, true);
    assert.match(r.json.checks.tools['playwright-cli'].note || '', /benign exit-crash/);
  });

  await test('no browser installed → exit 2 preflight-browser with an actionable detail', async () => {
    const empty = tmp('agentex-cipf-nobrowser-');
    const r = await runPreflight(proj({ portalUrl: base }), [], { PLAYWRIGHT_BROWSERS_PATH: empty });
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-browser'));
    assert.match(JSON.stringify(r.json.blockedReasons), /install-browser/);
  });

  await test('unreadable plugin manifest → exit 2 preflight-plugin-version (the only version gate)', async () => {
    const r = await runPreflight(proj({ portalUrl: base }), ['--plugin-root', tmp('agentex-cipf-emptyroot-')]);
    assert.strictEqual(r.status, 2);
    assert.ok(codes(r.json).includes('preflight-plugin-version'));
  });

  await test('plugin↔project version drift is REPORTED, not gate-closing (exit 0, drift:true)', async () => {
    const dir = proj({ portalUrl: base });
    fs.mkdirSync(path.join(dir, '.agentex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agentex', 'version.json'), JSON.stringify({ version: '0.0.1' }));
    const r = await runPreflight(dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.checks.pluginVersion.drift, true);
    assert.strictEqual(r.json.checks.pluginVersion.project, '0.0.1');
  });

  await test('multiple failures are all named (environment broken + missing browser)', async () => {
    const empty = tmp('agentex-cipf-nobrowser2-');
    const r = await runPreflight(proj({ portalUrl: 'http://127.0.0.1:9/' }), [], { PLAYWRIGHT_BROWSERS_PATH: empty });
    assert.strictEqual(r.status, 2);
    const c = codes(r.json);
    assert.ok(c.includes('preflight-target') && c.includes('preflight-browser'), JSON.stringify(c));
  });

  await test('structural pin: ci_preflight.js contains no process.exit(', async () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!src.includes('process.exit('), 'ci_preflight.js must not force-exit (exitCode + drain)');
  });

  server.close();
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
