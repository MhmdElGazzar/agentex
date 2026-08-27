'use strict';
// Unit tests for the release-gate prepare script.
// Run: node scripts/release-gate/prepare.test.js — fully offline, sentinel values only.
//
// Amendment 1 (design: release-e2e-gate): prepare creates the throwaway dir and
// detects sentinel/live mode but writes NO tracker values into it — the dir must
// look to scripts/init.js like a genuinely fresh consumer folder (no legacy
// signals). Env injection is inject-env.js's job, AFTER the wizard.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hasLegacySignals } = require(path.join(__dirname, '..', 'lib', 'scaffold.js'));

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CLI = path.join(__dirname, 'prepare.js');
const INIT = path.join(__dirname, '..', 'init.js');
const SENTINEL = 'EVAL_SENTINEL_PAT_a1b2c3d4';
const FAKE_LIVE = 'live-pat-value-0f9e8d7c6b5a';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-prep-')); }

// A fake "plugin repo" dir whose .env is the mode-detection source.
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
  await test('sentinel PAT → mode sentinel, throwaway dir created EMPTY (no .env, no tracker values), one {dir, mode} JSON line, no value printed', async () => {
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
    assert.deepStrictEqual(fs.readdirSync(out.dir), [], 'the throwaway dir starts genuinely fresh — nothing pre-written');
    assert.ok(!fs.existsSync(path.join(out.dir, '.env')), 'no .env is pre-seeded');
    assert.ok(!(r.stdout + r.stderr).includes(SENTINEL), 'PAT value never printed');
  });

  await test('prepared dir scaffolds as a genuinely fresh consumer project — init.js stamps it, hasLegacySignals never fires', async () => {
    const r = run(sourceDir(`AZURE_PAT=${SENTINEL}\n`), tmp());
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(hasLegacySignals(out.dir), false, 'no legacy signal before init');
    const init = spawnSync(process.execPath, [INIT, out.dir], { encoding: 'utf8', env: cleanEnv() });
    assert.strictEqual(init.status, 0, init.stderr);
    assert.ok(!init.stdout.includes('legacy conventions detected'),
      `init must not take the legacy/migration branch on a fresh gate scaffold:\n${init.stdout}`);
    assert.ok(fs.existsSync(path.join(out.dir, '.agentex', 'version.json')),
      'the version stamp is written — the genuinely-fresh consumer path');
    assert.strictEqual(hasLegacySignals(out.dir), false, 'no legacy signal after init either');
  });

  await test('live PAT + org/project → mode live, dir still empty — no tracker value travels at prepare time', async () => {
    const src = sourceDir([
      `AZURE_PAT=${FAKE_LIVE}`,
      'AZURE_URL=https://dev.azure.com/someorg',
      'AZURE_PROJECT=Some Project',
      'AZURE_TEST_PLAN_ID=42',
    ].join('\n') + '\n');
    const r = run(src, tmp());
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.mode, 'live');
    assert.deepStrictEqual(fs.readdirSync(out.dir), [], 'nothing is written into the throwaway dir');
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_LIVE), 'PAT value never printed');
    assert.ok(!(r.stdout + r.stderr).includes('someorg'), 'org value never printed');
  });

  await test('live PAT without org/project → exit 2 naming AZURE_URL / AZURE_PROJECT (early fail-closed, before a wizard run is wasted), nothing echoed', async () => {
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
