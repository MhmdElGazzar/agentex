'use strict';
// Unit tests for the release-gate reporting-lane verifier.
// Run: node scripts/release-gate/verify-reports.test.js — fully offline.
//
// Every HTML fixture on the verdict path is REAL make_html_report.js output —
// the plugin's own extent-report generator, invoked in-test on sample run data.
// The previous round's synthetic hand-written HTML let a verdict-vocabulary
// mismatch ship: the generator renders "Passed"/"Failed"/"Blocked" pills while
// the verifier demanded caps "PASS" adjacency, so a healthy live run failed all
// scenarios in extent-report.html (release gate R1).
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
const GENERATOR = path.join(__dirname, '..', '..', 'skills', 'extent-report', 'scripts', 'make_html_report.js');
const SCENARIOS = [
  { name: 'Search returns matching products', verdict: 'PASS' },
  { name: 'Checkout rejects an expired card', verdict: 'FAIL' },
  { name: 'Inventory endpoint answers the catalog call', verdict: 'BLOCKED' },
];
const STATUS_OF = { PASS: 'passed', FAIL: 'failed', BLOCKED: 'blocked' };

/** Real extent-report.html: build a run-summary JSON from the scenario list
 *  and run the ACTUAL generator on it — never hand-written HTML. */
function generateHtml(scenarios, { extraCases = [] } = {}) {
  const testCases = scenarios.map((s, i) => ({
    name: s.name,
    spec: `test/suite1/sample-${i + 1}.md`,
    status: STATUS_OF[s.verdict],
    steps: [
      { desc: 'open the page', status: 'passed' },
      { desc: 'act and assert', status: STATUS_OF[s.verdict], note: 'sample step detail' },
    ],
  })).concat(extraCases);
  const summary = { total: testCases.length, passed: 0, failed: 0, blocked: 0, naDescoped: 0, notRun: 0 };
  for (const tc of testCases) summary[tc.status] += 1;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-vr-gen-'));
  const inFile = path.join(work, 'run-summary.json');
  const outFile = path.join(work, 'extent-report.html');
  fs.writeFileSync(inFile, JSON.stringify({ title: 'Sample Run', date: '2026-08-28', summary, testCases }));
  const r = spawnSync(process.execPath, [GENERATOR, inFile, outFile], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `the real generator must succeed: ${r.stderr}`);
  return fs.readFileSync(outFile, 'utf8');
}

/** report.md vocabulary is caps PASS/FAIL/BLOCKED — the agent-written summary table. */
function mdFor(scenarios) {
  return '# Report\n\n| scenario | verdict |\n|---|---|\n' +
    scenarios.map((s) => `| ${s.name} | ${s.verdict} |`).join('\n') + '\n';
}

function project({ execName = 'execu_20260827-1200', md, html, scenarios = SCENARIOS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-vr-'));
  const exec = path.join(dir, 'executions', execName);
  fs.mkdirSync(exec, { recursive: true });
  if (md !== null) fs.writeFileSync(path.join(exec, 'report.md'), md !== undefined ? md : mdFor(scenarios));
  if (html !== null) fs.writeFileSync(path.join(exec, 'extent-report.html'), html !== undefined ? html : generateHtml(scenarios));
  return dir;
}

function scenariosFile(dir, scenarios = SCENARIOS) {
  const f = path.join(dir, 'expected-scenarios.json');
  fs.writeFileSync(f, JSON.stringify(scenarios));
  return f;
}

(async () => {
  await test('R1 regression: real generator pills (Passed/Failed/Blocked) satisfy PASS/FAIL/BLOCKED expectations', async () => {
    const dir = project();   // html is real make_html_report.js output
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
    const md = mdFor(SCENARIOS.slice(1));   // first scenario missing from the table
    const r = verifyReports({ dir: project({ md }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('Search returns matching products') && f.includes('report.md')), JSON.stringify(r.findings));
  });

  await test('a real report that disagrees (Blocked pill where FAIL is expected) → finding for extent-report.html', async () => {
    const rendered = SCENARIOS.map((s) => (s.verdict === 'FAIL' ? { ...s, verdict: 'BLOCKED' } : s));
    const r = verifyReports({ dir: project({ html: generateHtml(rendered) }), scenarios: SCENARIOS });
    assert.strictEqual(r.ok, false);
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Checkout rejects an expired card') && f.includes('extent-report.html')), JSON.stringify(r.findings));
    assert.ok(!r.findings.some((f) => f.includes('report.md')), 'report.md still agrees with the expectation');
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
    fs.writeFileSync(path.join(newer, 'extent-report.html'), generateHtml([]));   // a real, scenario-less report
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

  await test('a verdict token elsewhere in the artifact never satisfies a scenario', async () => {
    // md: FAIL appears only in prose. html (real): a Failed pill exists, but it
    // belongs to a card the expectation does not name.
    const rendered = [SCENARIOS[0], { name: 'Checkout rejects an expired card', verdict: 'BLOCKED' }];
    const md = '# Report\n\nNo lane may FAIL silently.\n\n' + mdFor(rendered);
    const html = generateHtml(rendered, {
      extraCases: [{ name: 'Unrelated teardown sweep', spec: 'test/suite1/teardown.md', status: 'failed',
                     steps: [{ desc: 'sweep', status: 'failed' }] }],
    });
    const expectation = SCENARIOS.slice(0, 2);   // checkout expected FAIL
    const r = verifyReports({ dir: project({ md, html }), scenarios: expectation });
    assert.strictEqual(r.ok, false, 'FAIL/Failed only appear away from the checkout scenario');
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Checkout rejects an expired card') && f.includes('report.md')), JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.includes('FAIL') && f.includes('Checkout rejects an expired card') && f.includes('extent-report.html')), JSON.stringify(r.findings));
  });

  await test('a scenario named twice still passes when the verdict sits with either occurrence', async () => {
    const md = '# Report\n\n## Scenarios\n- Search returns matching products\n\n' + mdFor([SCENARIOS[0]]);
    const r = verifyReports({ dir: project({ md, html: generateHtml([SCENARIOS[0]]) }), scenarios: [SCENARIOS[0]] });
    assert.deepStrictEqual(r.findings, []);
    assert.strictEqual(r.ok, true);
  });

  await test('a scenario name that is a proper prefix of another never borrows the longer one\'s verdict', async () => {
    // Only the LONGER scenario exists in both artifacts. The shorter expected
    // name is its proper prefix — matching it inside the longer name would
    // hand it the longer card's PASS.
    const expectation = [
      { name: 'Search returns', verdict: 'PASS' },
      { name: 'Search returns matching products', verdict: 'PASS' },
    ];
    const dir = project({ md: mdFor([SCENARIOS[0]]), html: generateHtml([SCENARIOS[0]]) });
    const r = verifyReports({ dir, scenarios: expectation });
    assert.strictEqual(r.ok, false, 'the prefix scenario was never reported — it must not pass');
    for (const file of ['report.md', 'extent-report.html']) {
      assert.ok(r.findings.some((f) => f.includes('"Search returns"') && f.includes(file)),
        `expected a finding for the prefix scenario in ${file}: ${JSON.stringify(r.findings)}`);
    }
    assert.ok(!r.findings.some((f) => f.includes('"Search returns matching products"')),
      'the longer scenario itself is clean');
  });

  await test('fail-closed vocabulary: an expected verdict outside the token map is a usage error', async () => {
    const dir = project();
    for (const verdict of ['Passed', 'pass', 'SKIPPED']) {
      assert.throws(() => verifyReports({ dir, scenarios: [{ name: 'Search returns matching products', verdict }] }),
        /verdict/, `"${verdict}" must be refused, never matched loosely`);
    }
  });

  await test('CLI: --scenarios file, one JSON line, exit 0/1; unknown verdict exits 2', async () => {
    const dir = project();
    let r = spawnSync(process.execPath, [CLI, dir, '--scenarios', scenariosFile(dir)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, true);
    const broken = project({ html: null });
    r = spawnSync(process.execPath, [CLI, broken, '--scenarios', scenariosFile(broken)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, false);
    const badVocab = project();
    r = spawnSync(process.execPath, [CLI, badVocab, '--scenarios',
      scenariosFile(badVocab, [{ name: 'Search returns matching products', verdict: 'Skipped' }])], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, 'an out-of-map verdict is a usage error');
    assert.strictEqual(JSON.parse(r.stderr.trim()).ok, false);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
