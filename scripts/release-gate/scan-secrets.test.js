'use strict';
// Unit tests for the release-gate secret/never-name scanner.
// Run: node scripts/release-gate/scan-secrets.test.js — fully offline, sentinel values only.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanSecrets } = require('./scan-secrets.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// The tests own the env — the machine's real values must not leak in.
for (const k of Object.keys(process.env)) if (k.startsWith('AZURE_')) delete process.env[k];

const CLI = path.join(__dirname, 'scan-secrets.js');
const PAT = 'EVAL_SENTINEL_PAT_scan1234';
const PAT_B64 = Buffer.from(':' + PAT).toString('base64');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-scan-')); }

function envSource({ pat = PAT, url = 'https://dev.azure.com/hushorg', project = 'Hush Project' } = {}) {
  const dir = tmp();
  const lines = [];
  if (pat) lines.push(`AZURE_PAT=${pat}`);
  if (url) lines.push(`AZURE_URL=${url}`);
  if (project) lines.push(`AZURE_PROJECT=${project}`);
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  return dir;
}

function artifacts(files) {
  const dir = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AZURE_')) delete env[k];
  return env;
}

function runCli(envFrom, target) {
  return spawnSync(process.execPath, [CLI, target, '--env-from', envFrom], { encoding: 'utf8', env: cleanEnv() });
}

(async () => {
  await test('clean artifacts → ok, exit 0; loaded key NAMES reported, values never', async () => {
    const dir = artifacts({ 'ledger.json': '{"entries":[]}\n', 'gate.log': 'lane UI PASS\n' });
    const r = runCli(envSource(), dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.ok, true);
    assert.ok(out.keysLoaded.includes('AZURE_PAT'));
    for (const v of [PAT, PAT_B64, 'hushorg', 'Hush Project']) {
      assert.ok(!(r.stdout + r.stderr).includes(v), `${v} never printed`);
    }
  });

  await test('a PAT value in any artifact → FAIL with {file, line, key} — no value, no line content', async () => {
    const dir = artifacts({ 'nested/deep/gate.log': `line one\nAuthorization leak: ${PAT}\n` });
    const r = runCli(envSource(), dir);
    assert.strictEqual(r.status, 1);
    const out = JSON.parse(r.stdout.trim());
    const hit = out.hits.find((h) => h.key === 'AZURE_PAT');
    assert.ok(hit, r.stdout);
    assert.strictEqual(hit.line, 2);
    assert.match(hit.file, /gate\.log$/);
    assert.ok(!(r.stdout + r.stderr).includes(PAT), 'value never echoed');
  });

  await test('the base64 Basic-auth form of the PAT is caught too', async () => {
    const dir = artifacts({ 'log.txt': `header was Basic ${PAT_B64}\n` });
    const r = runCli(envSource(), dir);
    assert.strictEqual(r.status, 1);
    assert.ok(JSON.parse(r.stdout.trim()).hits.some((h) => h.key.includes('AZURE_PAT') && h.key.includes('base64')), r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes(PAT_B64));
  });

  await test('the org segment of AZURE_URL in an artifact → never-name FAIL', async () => {
    const dir = artifacts({ 'report.md': 'saw https://dev.azure.com/hushorg/Something today\n' });
    const r = runCli(envSource(), dir);
    assert.strictEqual(r.status, 1);
    assert.ok(JSON.parse(r.stdout.trim()).hits.some((h) => h.key.includes('AZURE_URL')), r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes('hushorg'));
  });

  await test('the AZURE_PROJECT value in an artifact → never-name FAIL', async () => {
    const dir = artifacts({ 'notes.md': 'ran against Hush Project fixtures\n' });
    const r = runCli(envSource(), dir);
    assert.strictEqual(r.status, 1);
    assert.ok(JSON.parse(r.stdout.trim()).hits.some((h) => h.key === 'AZURE_PROJECT'), r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes('Hush Project'));
  });

  await test('zero loadable values → exit 2, never a trivial pass', async () => {
    const empty = tmp();
    fs.writeFileSync(path.join(empty, '.env'), '\n');
    const r = runCli(empty, artifacts({ 'a.txt': 'x\n' }));
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  });

  await test('in-process API: scans multiple targets, counts files', async () => {
    const src = envSource();
    const clean = artifacts({ 'a.txt': 'nothing here\n' });
    const dirty = artifacts({ 'b.txt': `${PAT}\n` });
    const r = scanSecrets({ targets: [clean, dirty], envFromDir: src });
    assert.strictEqual(r.ok, false);
    assert.ok(r.scannedFiles >= 2);
    assert.strictEqual(r.hits.length, 1);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
