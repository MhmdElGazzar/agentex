'use strict';
// Unit tests for the release-gate prepare script.
// Run: node scripts/release-gate/prepare.test.js — fully offline, sentinel values only.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CLI = path.join(__dirname, 'prepare.js');
const SENTINEL = 'EVAL_SENTINEL_PAT_a1b2c3d4';
const FAKE_LIVE = 'live-pat-value-0f9e8d7c6b5a';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-prep-')); }

// A fake "plugin repo" dir whose .env is the copy source.
function sourceDir(envLines) {
  const dir = tmp();
  if (envLines !== null) fs.writeFileSync(path.join(dir, '.env'), envLines);
  return dir;
}

// Child env with every AZURE_* wiped — the machine's real values must not leak in.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AZURE_')) delete env[k];
  return env;
}

function run(source, destParent) {
  return spawnSync(process.execPath, [CLI, '--source-env-dir', source, '--dest-parent', destParent],
    { encoding: 'utf8', env: cleanEnv() });
}

(async () => {
  await test('sentinel PAT → mode sentinel, throwaway dir created, one {dir, mode} JSON line, no value printed', async () => {
    const parent = tmp();
    const r = run(sourceDir(`AZURE_PAT=${SENTINEL}\n`), parent);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'exactly one stdout line');
    const out = JSON.parse(lines[0]);
    assert.strictEqual(out.mode, 'sentinel');
    assert.ok(out.dir.startsWith(parent), out.dir);
    assert.match(path.basename(out.dir), /^agentex-gate-/);
    assert.ok(fs.existsSync(out.dir));
    assert.ok(!(r.stdout + r.stderr).includes(SENTINEL), 'PAT value never printed');
  });

  await test('sentinel mode fills generic org/project placeholders so the tracker lane composes without real values', async () => {
    const r = run(sourceDir(`AZURE_PAT=${SENTINEL}\n`), tmp());
    const out = JSON.parse(r.stdout.trim());
    const env = fs.readFileSync(path.join(out.dir, '.env'), 'utf8');
    assert.match(env, new RegExp(`^AZURE_PAT=${SENTINEL}$`, 'm'));
    assert.match(env, /^AZURE_URL=https:\/\/dev\.azure\.com\/exampleorg$/m);
    assert.match(env, /^AZURE_PROJECT=Sample Project$/m);
  });

  await test('live PAT + org/project → mode live, every present tracker key copied verbatim', async () => {
    const src = sourceDir([
      `AZURE_PAT=${FAKE_LIVE}`,
      'AZURE_URL=https://dev.azure.com/someorg',
      'AZURE_PROJECT=Some Project',
      'AZURE_TEST_PLAN_ID=42',
      'UNRELATED_KEY=should-not-travel',
    ].join('\n') + '\n');
    const r = run(src, tmp());
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.mode, 'live');
    const env = fs.readFileSync(path.join(out.dir, '.env'), 'utf8');
    assert.match(env, new RegExp(`^AZURE_PAT=${FAKE_LIVE}$`, 'm'));
    assert.match(env, /^AZURE_URL=https:\/\/dev\.azure\.com\/someorg$/m);
    assert.match(env, /^AZURE_PROJECT=Some Project$/m);
    assert.match(env, /^AZURE_TEST_PLAN_ID=42$/m);
    assert.ok(!env.includes('UNRELATED_KEY'), 'only the documented tracker keys travel');
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_LIVE), 'PAT value never printed');
  });

  await test('live PAT without org/project → exit 2 naming AZURE_URL / AZURE_PROJECT, nothing echoed', async () => {
    const r = run(sourceDir(`AZURE_PAT=${FAKE_LIVE}\n`), tmp());
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /AZURE_URL/);
    assert.match(r.stderr, /AZURE_PROJECT/);
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_LIVE));
  });

  await test('no PAT anywhere → exit 2 naming all three PAT keys and the sentinel option', async () => {
    const r = run(sourceDir(''), tmp());
    assert.strictEqual(r.status, 2);
    for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']) assert.ok(r.stderr.includes(n), n);
    assert.match(r.stderr, /EVAL_SENTINEL_PAT_/);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
