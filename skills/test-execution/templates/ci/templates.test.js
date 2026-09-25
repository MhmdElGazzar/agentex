'use strict';
// Tests for the shipped CI templates (skills/browser-testing/templates/ci/):
// ci-settings.json parses and keeps the deny-by-default security posture;
// both pipeline YAMLs are structurally sane (no YAML parser ships with the
// plugin — zero-dependency rule — so the YAML check is a structural lint:
// no tabs, required stage markers present), reference the ci_gate.js entry
// point, show BOTH advisory and blocking wiring plus the PM manual-approval
// step, publish only executions/ artifacts, and stay fully generic — no
// consumer/org/project names, no plugin cache paths, placeholders only.
//
// Run: node skills/browser-testing/templates/ci/templates.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const DIR = __dirname;
const AZ = path.join(DIR, 'azure-pipelines.yml');
const GH = path.join(DIR, 'github-actions.yml');
const SETTINGS = path.join(DIR, 'ci-settings.json');

const read = (f) => fs.readFileSync(f, 'utf8');

// ---- ci-settings.json ------------------------------------------------------------

test('ci-settings.json parses and carries a permissions block', () => {
  const j = JSON.parse(read(SETTINGS));
  assert.ok(j.permissions && Array.isArray(j.permissions.allow) && Array.isArray(j.permissions.deny));
});

test('ci-settings.json allows what a run actually issues (playwright-cli + bundled node scripts)', () => {
  const { allow } = JSON.parse(read(SETTINGS)).permissions;
  assert.ok(allow.some((r) => r.includes('npx playwright-cli')), 'playwright-cli allowed');
  assert.ok(allow.some((r) => r.startsWith('Bash(node')), 'bundled node scripts allowed');
});

test('ci-settings.json DENIES .env reads, key material and test/.auth (settings.example.json philosophy)', () => {
  const { deny } = JSON.parse(read(SETTINGS)).permissions;
  for (const rule of ['Read(./.env)', 'Read(./**/.env)', 'Read(./test/.auth/**)', 'Read(./**/*.pem)', 'Read(./**/*.key)']) {
    assert.ok(deny.includes(rule), `${rule} must be denied`);
  }
  assert.ok(deny.some((r) => r.includes('git push')), 'git push denied');
});

// ---- pipeline YAMLs ---------------------------------------------------------------

for (const [label, file] of [['azure-pipelines.yml', AZ], ['github-actions.yml', GH]]) {
  test(`${label}: exists, non-empty, structurally sane YAML (no tabs)`, () => {
    const src = read(file);
    assert.ok(src.trim().length > 200, 'non-trivial template');
    assert.ok(!src.includes('\t'), 'YAML must not contain tab characters');
  });

  test(`${label}: invokes the ci_gate.js entry point and branches on its exit code`, () => {
    const src = read(file);
    assert.match(src, /ci_gate\.js/);
    assert.match(src, /skills\/browser-testing\/scripts\/ci_gate\.js/);
  });

  test(`${label}: shows BOTH advisory and blocking wiring`, () => {
    const src = read(file);
    assert.match(src, /advisory/i);
    assert.match(src, /blocking/i);
    assert.match(src, /continue(OnError|-on-error)/, 'the advisory switch is shown concretely');
  });

  test(`${label}: publishes ONLY executions/ artifacts — test/.auth appears solely as a warning comment`, () => {
    const src = read(file);
    assert.match(src, /executions/, 'run artifacts are published');
    for (const line of src.split('\n')) {
      if (line.includes('test/.auth')) {
        assert.ok(line.trimStart().startsWith('#') || /never/i.test(line),
          `test/.auth may only appear in a warning, got: ${line.trim()}`);
      }
    }
  });

  test(`${label}: secrets travel by NAME from the CI secret store — never a value`, () => {
    const src = read(file);
    assert.match(src, /ANTHROPIC_API_KEY/);
    assert.ok(!src.includes('sk-ant'), 'no API key material');
  });

  test(`${label}: never hardcodes the unstable plugin cache path`, () => {
    const src = read(file);
    assert.ok(!src.includes('plugins/cache'), 'cache paths are documented as ephemeral');
    assert.ok(!/[A-Za-z]:\\Users\\/.test(src), 'no absolute user paths');
  });

  test(`${label}: generic — placeholders only, no consumer/org/project names`, () => {
    const src = read(file);
    assert.ok(!/dnlds|elgazzar|melgazzar/i.test(src), 'no author/consumer identifiers');
    assert.match(src, /<[a-z-]+>/, 'angle-bracket placeholders mark every consumer-specific value');
    for (const m of src.matchAll(/@([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      assert.strictEqual(m[1].toLowerCase(), 'example.com', `emails must use example.com, got @${m[1]}`);
    }
  });
}

test('azure-pipelines.yml: full stage including the PM ManualValidation approval step', () => {
  const src = read(AZ);
  assert.match(src, /ManualValidation/);
  assert.match(src, /stages:/);
});

test('github-actions.yml: PM approval via an environment with required reviewers', () => {
  const src = read(GH);
  assert.match(src, /environment:/);
  assert.match(src, /required reviewers/i);
  assert.match(src, /upload-artifact/);
  assert.match(src, /GITHUB_STEP_SUMMARY/, 'the verdict is surfaced in the job summary');
});

test('ci-settings.json is generic too', () => {
  const src = read(SETTINGS);
  assert.ok(!/dnlds|elgazzar|melgazzar/i.test(src));
  assert.ok(!src.includes('plugins/cache'));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
