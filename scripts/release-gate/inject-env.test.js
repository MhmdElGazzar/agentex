'use strict';
// Unit tests for the release-gate inject-env script (design Amendment 1).
// Run: node scripts/release-gate/inject-env.test.js — fully offline, sentinel values only.
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

const CLI = path.join(__dirname, 'inject-env.js');
const SENTINEL = 'EVAL_SENTINEL_PAT_a1b2c3d4';
const FAKE_LIVE = 'live-pat-value-0f9e8d7c6b5a';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-inject-')); }

// A fake "plugin repo" dir whose .env is the copy source.
function sourceDir(envLines) {
  const dir = tmp();
  if (envLines !== null) fs.writeFileSync(path.join(dir, '.env'), envLines);
  return dir;
}

// A fake throwaway project dir, optionally with a wizard-era .env already in it.
function destDir(envLines) {
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

function run(dest, source) {
  return spawnSync(process.execPath, [CLI, dest, '--source-env-dir', source],
    { encoding: 'utf8', env: cleanEnv() });
}

function readEnv(dir) { return fs.readFileSync(path.join(dir, '.env'), 'utf8'); }
function countLines(env, key) { return env.split(/\r?\n/).filter(l => l.startsWith(`${key}=`)).length; }

// The keys-only .env that init.js scaffolds (blanked .env.example), after the
// wizard upserted the dummy secrets the persona typed.
const WIZARD_ENV = [
  'AZURE_PAT=',
  'SQLCMDPASSWORD=dummy-db-pw',
  'API_TOKEN=dummy-api-token',
  'KB_ASK_API_KEY=dummy-kb-key',
  'FIGMA_TOKEN=dummy-figma-token',
].join('\n') + '\n';

(async () => {
  await test('sentinel: fills the empty scaffolded AZURE_PAT in place, appends generic org/project placeholders, one JSON line, exit 0, no value printed', async () => {
    const dest = destDir(WIZARD_ENV);
    const r = run(dest, sourceDir(`AZURE_PAT=${SENTINEL}\n`));
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'exactly one stdout line');
    const out = JSON.parse(lines[0]);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'sentinel');
    const env = readEnv(dest);
    assert.match(env, new RegExp(`^AZURE_PAT=${SENTINEL}$`, 'm'));
    assert.strictEqual(countLines(env, 'AZURE_PAT'), 1, 'filled in place — no duplicate AZURE_PAT line');
    assert.match(env, /^AZURE_URL=https:\/\/dev\.azure\.com\/exampleorg$/m);
    assert.match(env, /^AZURE_PROJECT=Sample Project$/m);
    assert.ok(!(r.stdout + r.stderr).includes(SENTINEL), 'PAT value never printed');
    assert.ok(out.injected.includes('AZURE_PAT') && out.injected.includes('AZURE_URL') && out.injected.includes('AZURE_PROJECT'),
      `injected key names reported: ${JSON.stringify(out.injected)}`);
  });

  await test('wizard-written secret lines survive byte-for-byte and are not reported as injected', async () => {
    const dest = destDir(WIZARD_ENV);
    const r = run(dest, sourceDir(`AZURE_PAT=${SENTINEL}\n`));
    assert.strictEqual(r.status, 0, r.stderr);
    const env = readEnv(dest);
    for (const line of ['SQLCMDPASSWORD=dummy-db-pw', 'API_TOKEN=dummy-api-token', 'KB_ASK_API_KEY=dummy-kb-key', 'FIGMA_TOKEN=dummy-figma-token']) {
      assert.ok(env.includes(line), `untouched: ${line}`);
    }
    const out = JSON.parse(r.stdout.trim());
    for (const k of ['SQLCMDPASSWORD', 'API_TOKEN', 'KB_ASK_API_KEY', 'FIGMA_TOKEN']) {
      assert.ok(!out.injected.includes(k), `${k} is not the gate's to inject`);
    }
  });

  await test('live: every present tracker key travels verbatim, unrelated keys do not, mode live, no value printed', async () => {
    const src = sourceDir([
      `AZURE_PAT=${FAKE_LIVE}`,
      'AZURE_URL=https://dev.azure.com/someorg',
      'AZURE_PROJECT=Some Project',
      'AZURE_TEST_PLAN_ID=42',
      'UNRELATED_KEY=should-not-travel',
    ].join('\n') + '\n');
    const dest = destDir(WIZARD_ENV);
    const r = run(dest, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.mode, 'live');
    const env = readEnv(dest);
    assert.match(env, new RegExp(`^AZURE_PAT=${FAKE_LIVE}$`, 'm'));
    assert.match(env, /^AZURE_URL=https:\/\/dev\.azure\.com\/someorg$/m);
    assert.match(env, /^AZURE_PROJECT=Some Project$/m);
    assert.match(env, /^AZURE_TEST_PLAN_ID=42$/m);
    assert.ok(!env.includes('UNRELATED_KEY'), 'only the documented tracker keys travel');
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_LIVE), 'PAT value never printed');
    assert.ok(!(r.stdout + r.stderr).includes('someorg'), 'org value never printed');
  });

  await test('no-clobber: a non-empty wizard-written value for a tracker key is preserved and reported as preserved', async () => {
    const dest = destDir('AZURE_PAT=\nAZURE_URL=https://dev.azure.com/wizard-typed\n');
    const src = sourceDir([
      `AZURE_PAT=${SENTINEL}`,
      'AZURE_URL=https://dev.azure.com/exampleorg',
    ].join('\n') + '\n');
    const r = run(dest, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const env = readEnv(dest);
    assert.match(env, /^AZURE_URL=https:\/\/dev\.azure\.com\/wizard-typed$/m, 'existing value wins');
    assert.strictEqual(countLines(env, 'AZURE_URL'), 1, 'no duplicate AZURE_URL line');
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.preserved.includes('AZURE_URL'), `preserved list carries the key name: ${JSON.stringify(out.preserved)}`);
    assert.ok(!out.injected.includes('AZURE_URL'));
  });

  await test('missing throwaway .env → created with the injected keys (append path)', async () => {
    const dest = destDir(null);
    const r = run(dest, sourceDir(`AZURE_PAT=${SENTINEL}\n`));
    assert.strictEqual(r.status, 0, r.stderr);
    const env = readEnv(dest);
    assert.match(env, new RegExp(`^AZURE_PAT=${SENTINEL}$`, 'm'));
    assert.match(env, /^AZURE_URL=/m);
    assert.match(env, /^AZURE_PROJECT=/m);
  });

  await test('idempotent: a second run preserves everything and adds no duplicate lines', async () => {
    const dest = destDir(WIZARD_ENV);
    const src = sourceDir(`AZURE_PAT=${SENTINEL}\n`);
    assert.strictEqual(run(dest, src).status, 0);
    const first = readEnv(dest);
    const r2 = run(dest, src);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(readEnv(dest), first, 'second run changes nothing');
    const out = JSON.parse(r2.stdout.trim());
    assert.deepStrictEqual(out.injected, [], 'nothing left to inject');
    for (const k of ['AZURE_PAT', 'AZURE_URL', 'AZURE_PROJECT']) assert.ok(out.preserved.includes(k), `${k} preserved`);
  });

  await test('fail closed: no PAT in the source → exit 2 naming all three PAT keys and the sentinel option, dest .env untouched', async () => {
    const dest = destDir(WIZARD_ENV);
    const r = run(dest, sourceDir(''));
    assert.strictEqual(r.status, 2);
    for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']) assert.ok(r.stderr.includes(n), n);
    assert.match(r.stderr, /EVAL_SENTINEL_PAT_/);
    assert.strictEqual(readEnv(dest), WIZARD_ENV, 'nothing written on failure');
  });

  await test('fail closed: live PAT without org/project → exit 2 naming AZURE_URL / AZURE_PROJECT, dest .env untouched, nothing echoed', async () => {
    const dest = destDir(WIZARD_ENV);
    const r = run(dest, sourceDir(`AZURE_PAT=${FAKE_LIVE}\n`));
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /AZURE_URL/);
    assert.match(r.stderr, /AZURE_PROJECT/);
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_LIVE));
    assert.strictEqual(readEnv(dest), WIZARD_ENV, 'nothing written on failure');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
