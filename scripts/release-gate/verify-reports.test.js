'use strict';
// Unit tests for the release-gate reporting-lane verifier.
// Run: node scripts/release-gate/verify-reports.test.js — fully offline.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyReports } = require('./verify-reports.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const CLI = path.join(__dirname, 'verify-reports.js');
const SCENARIOS = [
  { name: 'Search returns matching products', verdict: 'PASS' },
  { name: 'Checkout rejects an expired card', verdict: 'FAIL' },
];

function project({ execName = 'execu_20260827-1200', md, html } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-vr-'));
  const exec = path.join(dir, 'executions', execName);
  fs.mkdirSync(exec, { recursive: true });
  const defaultMd = '# Report\n\n| scenario | verdict |\n|---|---|\n' +
    SCENARIOS.map((s) => `| ${s.name} | ${s.verdict} |`).join('\n') + '\n';
  const defaultHtml = `<html><body>${SCENARIOS.map((s) => `<div class="card">${s.name} <span>${s.verdict}</span></div>`).join('')}</body></html>`;
  if (md !== null) fs.writeFileSync(path.join(exec, 'report.md'), md !== undefined ? md : defaultMd);
  if (html !== null) fs.writeFileSync(path.join(exec, 'extent-report.html'), html !== undefined ? html : defaultHtml);
  return dir;
}

function scenariosFile(dir) {
  const f = path.join(dir, 'expected-scenarios.json');
  fs.writeFileSync(f, JSON.stringify(SCENARIOS));
  return f;
}

(async () => {
  await test('happy path: both reports exist and carry every scenario name + verdict → ok', async () => {
    const dir = project();
    const r = verifyReports({ dir, scenarios: SCENARIOS });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.ok, true);
    assert.match(r.execution, /execu_20260827-1200$/);
  });

  await test('missing extent-report.html → finding', async () => {
    const r = verifyReports({ dir: project({ html: null }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('extent-report.html')), JSON.stringify(r.findings));
  });

  await test('scenario name absent from report.md → finding naming scenario and file', async () => {
    const md = '# Report\n| Checkout rejects an expired card | FAIL |\nPASS\n';
    const r = verifyReports({ dir: project({ md }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('Search returns matching products') && f.includes('report.md')), JSON.stringify(r.findings));
  });

  await test('verdict absent from extent-report.html → finding', async () => {
    const html = `<html>${SCENARIOS.map((s) => s.name).join(' ')} PASS</html>`; // names there, FAIL missing
    const r = verifyReports({ dir: project({ html }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('extent-report.html')), JSON.stringify(r.findings));
  });

  await test('no executions tree at all → finding, not a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-vr-'));
    const r = verifyReports({ dir, scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('executions')), JSON.stringify(r.findings));
  });

  await test('newest execu_* dir is picked; --exec overrides', async () => {
    const dir = project({ execName: 'execu_20260827-1000' });
    const newer = path.join(dir, 'executions', 'execu_20260827-1400');
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(newer, 'report.md'), 'empty\n');
    fs.writeFileSync(path.join(newer, 'extent-report.html'), '<html></html>');
    const picked = verifyReports({ dir, scenarios: SCENARIOS });
    assert.match(picked.execution, /execu_20260827-1400$/, 'newest wins');
    assert.strictEqual(picked.ok, false, 'newest one is empty');
    const overridden = verifyReports({ dir, scenarios: SCENARIOS, exec: 'execu_20260827-1000' });
    assert.strictEqual(overridden.ok, true);
  });

  await test('mixed verdicts: a swapped expectation fails — each verdict must sit with its own scenario', async () => {
    const dir = project(); // reports carry A=PASS, B=FAIL — the expectation below swaps them
    const swapped = [
      { name: 'Search returns matching products', verdict: 'FAIL' },
      { name: 'Checkout rejects an expired card', verdict: 'PASS' },
    ];
    const r = verifyReports({ dir, scenarios: swapped });
    assert.strictEqual(r.ok, false, 'both verdict words exist in the files, but on the wrong scenarios');
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Search returns matching products') && f.includes('report.md')), JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.includes('PASS') && f.includes('Checkout rejects an expired card') && f.includes('extent-report.html')), JSON.stringify(r.findings));
  });

  await test('a verdict word in unrelated prose never satisfies a scenario', async () => {
    const md = '# Report\n\nNo lane may FAIL silently.\n\n| scenario | verdict |\n|---|---|\n' +
      '| Search returns matching products | PASS |\n| Checkout rejects an expired card | BLOCKED |\n';
    const html = '<html><body><p>zero FAIL tolerance</p>' +
      '<div class="card">Search returns matching products <span>PASS</span></div>' +
      '<div class="card">Checkout rejects an expired card <span>BLOCKED</span></div></body></html>';
    const r = verifyReports({ dir: project({ md, html }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false, 'FAIL only appears in prose, never beside its scenario');
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Checkout rejects an expired card') && f.includes('report.md')), JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Checkout rejects an expired card') && f.includes('extent-report.html')), JSON.stringify(r.findings));
  });

  await test('a scenario named twice still passes when the verdict sits with either occurrence', async () => {
    const md = '# Report\n\n## Scenarios\n- Search returns matching products\n\n| scenario | verdict |\n|---|---|\n' +
      '| Search returns matching products | PASS |\n';
    const html = '<html><body><nav>Search returns matching products</nav>' +
      '<div class="card">Search returns matching products <span>PASS</span></div></body></html>';
    const r = verifyReports({ dir: project({ md, html }), scenarios: [SCENARIOS[0]] });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.ok, true);
  });

  await test('CLI: --scenarios file, one JSON line, exit 0/1', async () => {
    const dir = project();
    let r = spawnSync(process.execPath, [CLI, dir, '--scenarios', scenariosFile(dir)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, true);
    const broken = project({ html: null });
    r = spawnSync(process.execPath, [CLI, broken, '--scenarios', scenariosFile(broken)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, false);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
