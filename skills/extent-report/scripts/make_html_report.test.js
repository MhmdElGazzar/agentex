'use strict';
// Tests for make_html_report.js — including the first-class `warning` and
// `viewMismatch` statuses (ui-check verdicts) and `flaky` (the browser-testing flake
// doctrine's outcome for a scenario that only passed on its one retry). Run-summary
// JSON contract widened from 5 to 8 statuses.
// Run: node skills/extent-report/scripts/make_html_report.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'make_html_report.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function render(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-extent-'));
  const inFile = path.join(dir, 'in.json');
  const outFile = path.join(dir, 'out.html');
  fs.writeFileSync(inFile, JSON.stringify(data));
  execFileSync(process.execPath, [SCRIPT, inFile, outFile], { encoding: 'utf8' });
  return fs.readFileSync(outFile, 'utf8');
}

const WARNING_COLOR = '#EAC54F';
const VIEWMISMATCH_COLOR = '#4D9DE0';
const FLAKY_COLOR = '#E0619B';
const PASSED_COLOR = '#2E9E4F';

const OLD_STYLE = {
  title: 'Legacy Run', date: '2026-08-13',
  summary: { total: 4, passed: 2, failed: 1, blocked: 1, naDescoped: 0, notRun: 0 },
  testCases: [
    { name: 'tc1', spec: 'test/a.md', status: 'failed', steps: [
      { desc: 'step one', status: 'passed', note: '' },
      { desc: 'step two', status: 'failed', note: 'defect #1' },
    ]},
  ],
};

const NEW_STYLE = {
  title: 'UI Check Run', date: '2026-08-13',
  summary: { total: 6, passed: 1, failed: 1, blocked: 1, warnings: 1, viewMismatch: 1, naDescoped: 0, notRun: 1 },
  testCases: [
    { name: 'checkout-ui', spec: 'test/suite1/checkout.md', status: 'warning', steps: [
      { desc: 'ui-check: figma 1:2 — mode: reference', status: 'warning', note: 'layout drift: sidebar moved' },
    ]},
    { name: 'mobile-ui', spec: 'test/suite1/mobile.md', status: 'viewMismatch', steps: [
      { desc: 'ui-check: figma 3:4 — mode: exact', status: 'viewMismatch', note: 'baseline is mobile 390x844; run targets desktop 1440x900' },
    ]},
  ],
};

test('legacy 5-status JSON renders with no trace of the new statuses', () => {
  const html = render(OLD_STYLE);
  assert.ok(!html.includes(WARNING_COLOR), 'no warning color in legacy render');
  assert.ok(!html.includes(VIEWMISMATCH_COLOR), 'no viewMismatch color in legacy render');
  assert.ok(!html.includes('View Mismatch'), 'no View Mismatch label in legacy render');
  assert.ok(!/>WARNING</.test(html), 'no WARNING stat card in legacy render');
  assert.ok(!html.includes(FLAKY_COLOR), 'no flaky color in legacy render');
  assert.ok(!/>FLAKY</.test(html), 'no FLAKY stat card in legacy render');
});

test('summary warnings/viewMismatch counts get their own stat cards', () => {
  const html = render(NEW_STYLE);
  assert.match(html, />WARNING</, 'WARNING stat card');
  assert.match(html, />VIEW MISMATCH</, 'VIEW MISMATCH stat card');
});

test('new statuses appear as legend entries with their own colors', () => {
  const html = render(NEW_STYLE);
  assert.match(html, /Warning/, 'Warning legend label');
  assert.match(html, /View Mismatch/, 'View Mismatch legend label');
  assert.ok(html.includes(WARNING_COLOR), 'warning color present');
  assert.ok(html.includes(VIEWMISMATCH_COLOR), 'viewMismatch color present');
});

test('donut gains segments for the new statuses', () => {
  const html = render(NEW_STYLE);
  const donutFills = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(donutFills.includes(WARNING_COLOR), `warning donut segment (got: ${donutFills.join(',')})`);
  assert.ok(donutFills.includes(VIEWMISMATCH_COLOR), 'viewMismatch donut segment');
});

test('step/test-case status accepts warning and viewMismatch as pills', () => {
  const html = render(NEW_STYLE);
  assert.ok(html.includes(`color:${WARNING_COLOR}`), 'warning pill colored');
  assert.ok(html.includes(`color:${VIEWMISMATCH_COLOR}`), 'viewMismatch pill colored');
  assert.match(html, />Warning<\/span>/, 'Warning pill label');
  assert.match(html, />View Mismatch<\/span>/, 'View Mismatch pill label');
});

test('test-case rollup border uses the new colors', () => {
  const html = render(NEW_STYLE);
  assert.ok(html.includes(`border-left-color:${WARNING_COLOR}`), 'warning rollup border');
  assert.ok(html.includes(`border-left-color:${VIEWMISMATCH_COLOR}`), 'viewMismatch rollup border');
});

test('coverage counts warning and viewMismatch as exercised', () => {
  // exercised = passed+failed+blocked+warnings+viewMismatch = 5 of 6 -> 83%
  const html = render(NEW_STYLE);
  assert.match(html, />83%</, 'coverage 83%');
});

// A run where one scenario failed on infrastructure and passed on its single retry.
// The doctrine calls that FLAKY, not PASS — the report has to say so.
const FLAKY_RUN = {
  title: 'Regression with a flake', date: '2026-08-24',
  summary: { total: 5, passed: 2, failed: 1, blocked: 0, flaky: 1, naDescoped: 0, notRun: 1 },
  testCases: [
    { name: 'cart-add-item', spec: 'test/suite1/cart.md', status: 'flaky', steps: [
      { desc: 'Open the product page', status: 'passed', note: '' },
      { desc: 'Add to cart', status: 'flaky', note: 'attempt 1: net::ERR_CONNECTION_RESET before the page loaded; attempt 2 passed' },
    ]},
  ],
};

test('flaky gets its own stat card, legend row and color', () => {
  const html = render(FLAKY_RUN);
  assert.match(html, />FLAKY</, 'FLAKY stat card');
  assert.match(html, />Flaky</, 'Flaky legend label');
  assert.ok(html.includes(FLAKY_COLOR), 'flaky color present');
});

test('a flaky test case is never rendered as passed', () => {
  const html = render(FLAKY_RUN);
  assert.ok(html.includes(`border-left-color:${FLAKY_COLOR}`), 'flaky rollup border');
  // The rollup is the whole point: a scenario that only passed on a retry must not
  // read green anywhere on the card, even though one of its steps did pass.
  assert.ok(!html.includes(`border-left-color:${PASSED_COLOR}`),
    'a flaky test case must not carry a passed rollup');
  assert.match(html, />Flaky<\/span>/, 'Flaky pill label');
});

test('donut gains a flaky segment', () => {
  const html = render(FLAKY_RUN);
  const donutFills = [...html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map(m => m[1]);
  assert.ok(donutFills.includes(FLAKY_COLOR), `flaky donut segment (got: ${donutFills.join(',')})`);
});

test('coverage counts flaky as exercised', () => {
  // exercised = passed+failed+blocked+warnings+viewMismatch+flaky = 4 of 5 -> 80%
  const html = render(FLAKY_RUN);
  assert.match(html, />80%</, 'coverage 80%');
});
// ---------------------------------------------------------------------------
// schemaVersion 2 — the persistent run-summary contract
// (references/run-summary-schema.md). Absence of `schemaVersion` = the legacy
// path, pinned byte-safe by the tests above plus the extended purity test here.
// ---------------------------------------------------------------------------

// 1x1 PNG — real bytes, so base64 embedding round-trips through fs.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64');

function tmpRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-extent-v2-'));
}
function writePng(dir, rel) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG_1X1);
  return rel;
}
// Render with the JSON placed inside `dir`, so relative evidence paths resolve
// against the run folder root exactly as in a real executions/execu_<ts>/ tree.
function renderIn(dir, data) {
  const inFile = path.join(dir, 'run-summary.json');
  const outFile = path.join(dir, 'extent-report.html');
  fs.writeFileSync(inFile, JSON.stringify(data));
  execFileSync(process.execPath, [SCRIPT, inFile, outFile], { encoding: 'utf8' });
  return fs.readFileSync(outFile, 'utf8');
}

function v2Base() {
  return {
    schemaVersion: 2,
    title: 'Suite1 Regression — 2026-08-28', date: '2026-08-28',
    run: {
      startedAt: '2026-08-28T14:02:11+02:00', endedAt: '2026-08-28T14:14:45+02:00',
      durationMs: 754000, mode: 'parallel', environment: 'qc',
      targetUrl: 'https://app.example.com', loginMode: 'session',
      sessions: [{ session: 'cart-140211-a3f2', spec: 'test/suite1/cart.md', label: 'cart' }],
      tools: { node: { ok: true, version: 'v22.1.0' }, 'playwright-cli': { ok: true, version: '1.2.3' } },
    },
    summary: { total: 2, passed: 1, failed: 1, blocked: 0, naDescoped: 0, notRun: 0 },
    testCases: [
      { name: 'cart-add-item', spec: 'test/suite1/cart.md', status: 'passed', durationMs: 42000,
        steps: [{ desc: 'Add to cart', status: 'passed', note: '' }] },
      { name: 'product-search', spec: 'test/suite1/product-search.md', status: 'failed', durationMs: 9000,
        steps: [{ desc: 'Search nonsense term', status: 'failed', note: 'no empty-state text' }] },
    ],
  };
}

test('v2: legacy purity extended — legacy fixture has no context block, duration markup, img or data URI', () => {
  const html = render(OLD_STYLE);
  assert.ok(!html.includes('class="ctx'), 'no context block in legacy render');
  assert.ok(!html.includes('tc-time'), 'no duration chip markup in legacy render');
  assert.ok(!html.includes('<th>Duration</th>'), 'no step Duration column in legacy render');
  assert.ok(!html.includes('<img'), 'no img tag in legacy render');
  assert.ok(!html.includes('data:image'), 'no data URI in legacy render');
  assert.ok(!/>N\/A - DE-SCOPED</.test(html), 'no naDescoped stat card in legacy render');
  assert.ok(!/>NOT RUN</.test(html), 'no notRun stat card in legacy render');
});

test('v2: context block renders environment, target, login/run mode, sessions, tools and run timing', () => {
  const html = render(v2Base());
  assert.ok(html.includes('Environment</span>qc'), 'environment chip');
  assert.ok(html.includes('Target</span>https://app.example.com'), 'target URL chip');
  assert.ok(html.includes('Login mode</span>session'), 'login mode chip');
  assert.ok(html.includes('Run mode</span>parallel'), 'run mode chip');
  assert.ok(html.includes('Started</span>2026-08-28T14:02:11+02:00'), 'run started chip');
  assert.ok(html.includes('Ended</span>2026-08-28T14:14:45+02:00'), 'run ended chip');
  assert.ok(html.includes('Duration</span>12m 34s'), 'run duration chip');
  assert.ok(html.includes('node</span>v22.1.0'), 'node tool chip');
  assert.ok(html.includes('playwright-cli</span>1.2.3'), 'playwright-cli tool chip');
  assert.match(html, /<td>cart-140211-a3f2<\/td><td>test\/suite1\/cart\.md<\/td>/, 'session→spec row');
  // Donut-regex guardrail: every <path fill> in the document is a donut segment color.
  const donutColors = new Set(['#2E9E4F', '#EAC54F', '#D6293E', '#F2A93B', '#E0619B', '#4D9DE0', '#8B5CF6', '#B0B0B0']);
  for (const m of html.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)) {
    assert.ok(donutColors.has(m[1]), `non-donut <path fill> leaked into the markup: ${m[1]}`);
  }
});

test('v2: evidence images are base64-embedded from paths relative to the JSON', () => {
  const dir = tmpRunDir();
  const rel = writePng(dir, 'browser-sessions/cart-140211-a3f2/screenshots/s1-cart.png');
  const data = v2Base();
  data.testCases[0].screenshots = [{ path: rel, caption: 'cart after add' }];
  const html = renderIn(dir, data);
  assert.ok(html.includes('data:image/png;base64,'), 'data URI present');
  assert.ok(!html.includes('file://'), 'no file:// reference');
  assert.ok(!html.includes('src="browser-sessions'), 'no raw path used as src');
  assert.ok(html.includes('cart after add'), 'caption rendered');
});

test('v2: missing evidence file renders a labeled placeholder, exit 0, report intact', () => {
  const dir = tmpRunDir();
  const data = v2Base();
  data.testCases[0].screenshots = [{ path: 'browser-sessions/x/screenshots/nope.png', caption: 'gone' }];
  const html = renderIn(dir, data); // execFileSync throws on non-zero exit
  assert.ok(html.includes('evidence not found: browser-sessions/x/screenshots/nope.png'), 'labeled placeholder');
  assert.ok(html.includes('cart-add-item'), 'rest of the report intact');
  assert.ok(html.includes('product-search'), 'other cards intact');
});

test('v2: ui-check block embeds baseline and actual with mode, baseline id and cached caveat', () => {
  const dir = tmpRunDir();
  const base = writePng(dir, 'browser-sessions/s/screenshots/s3-ui-check-baseline.png');
  const act = writePng(dir, 'browser-sessions/s/screenshots/s3-ui-check-actual.png');
  const data = v2Base();
  data.testCases[0].steps[0].uiCheck = {
    mode: 'reference', baseline: { source: 'figma', id: '12:34' }, verdict: 'warning',
    cached: true, cachedReason: 'Figma unreachable; cache of 2026-08-20',
    baselineImage: base, actualImage: act,
  };
  const html = renderIn(dir, data);
  const embeds = (html.match(/data:image\/png;base64,/g) || []).length;
  assert.ok(embeds >= 2, `baseline+actual both embedded (got ${embeds})`);
  assert.ok(html.includes('reference'), 'mode rendered');
  assert.ok(html.includes('figma 12:34'), 'baseline identity rendered');
  assert.ok(html.includes('Figma unreachable; cache of 2026-08-20'), 'cached caveat verbatim');
  assert.ok(html.includes('Baseline'), 'baseline labeled');
  assert.ok(html.includes('Actual'), 'actual labeled');
});

test('v2: flaky block carries the attempt-1 symptom and both attempts embedded', () => {
  const dir = tmpRunDir();
  const a1 = writePng(dir, 'browser-sessions/s/screenshots/s2-attempt1.png');
  const a2 = writePng(dir, 'browser-sessions/s/screenshots/s2-attempt2.png');
  const data = v2Base();
  data.summary.flaky = 1;
  data.testCases[0].status = 'flaky';
  data.testCases[0].flaky = {
    attempt1Symptom: 'net::ERR_CONNECTION_RESET before the page loaded',
    attempt1Evidence: [a1], attempt2Evidence: [a2],
  };
  const html = renderIn(dir, data);
  assert.ok(html.includes('net::ERR_CONNECTION_RESET before the page loaded'), 'attempt-1 symptom verbatim');
  const embeds = (html.match(/data:image\/png;base64,/g) || []).length;
  assert.ok(embeds >= 2, `both attempts embedded (got ${embeds})`);
  assert.ok(html.includes('Attempt 1'), 'attempt 1 labeled');
  assert.ok(html.includes('Attempt 2'), 'attempt 2 labeled');
});

test('v2: defects section renders severity chip, expected vs actual and embedded evidence', () => {
  const dir = tmpRunDir();
  const ev = writePng(dir, 'bugs/screenshots/search-empty.png');
  const data = v2Base();
  data.defects = [{
    id: 1, title: "Empty search shows no 'no results' text", severity: 'Medium',
    scenario: 'product-search', steps: ['Open the shop', "Search for 'zzzxqq'"],
    expected: "A 'no results' message", actual: 'Empty grid, no message', evidence: [ev],
  }];
  const html = renderIn(dir, data);
  assert.match(html, />Medium</, 'severity chip');
  assert.ok(html.includes('Expected'), 'Expected label');
  assert.ok(html.includes('Actual'), 'Actual label');
  assert.ok(html.includes('A &#39;no results&#39; message'), 'expected text rendered escaped');
  assert.ok(html.includes('Empty grid, no message'), 'actual text rendered');
  assert.ok(html.includes('data:image/png;base64,'), 'defect evidence embedded');
});

test('v2: naDescoped and notRun stat cards render on v2 and stay absent on legacy', () => {
  const html = render(v2Base());
  assert.match(html, />N\/A - DE-SCOPED</, 'naDescoped stat card on v2');
  assert.match(html, />NOT RUN</, 'notRun stat card on v2');
  const legacy = render(OLD_STYLE);
  assert.ok(!/>N\/A - DE-SCOPED</.test(legacy), 'no naDescoped stat card on legacy');
  assert.ok(!/>NOT RUN</.test(legacy), 'no notRun stat card on legacy');
});

test('v2: partial input (schemaVersion + timing only) renders timing and no empty sections', () => {
  const data = {
    schemaVersion: 2, title: 'Partial Run', date: '2026-08-28',
    run: { startedAt: '2026-08-28T14:02:11+02:00', endedAt: '2026-08-28T14:14:45+02:00', durationMs: 754000 },
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, naDescoped: 0, notRun: 0 },
    testCases: [{ name: 'only-case', spec: 'test/a.md', status: 'passed',
      steps: [{ desc: 'step one', status: 'passed', note: '' }] }],
  };
  const html = render(data);
  assert.ok(html.includes('Duration</span>12m 34s'), 'run duration renders');
  assert.ok(html.includes('Started</span>2026-08-28T14:02:11+02:00'), 'run start renders');
  assert.ok(!html.includes('class="ctx-sessions"'), 'no empty session table');
  assert.ok(!html.includes('class="ctx-chip ctx-tool"'), 'no empty tool chips');
  assert.ok(!html.includes('Environment</span>'), 'no empty environment chip');
  assert.ok(!html.includes('<img'), 'no images');
  assert.ok(!html.includes('class="defects-h"'), 'no defects section');
  assert.ok(!html.includes('class="tc-card defect-card"'), 'no defect cards');
});

test('v2: duration chip sits AFTER the verdict pill; step Duration column only when a step has durationMs', () => {
  const data = v2Base();
  const html = render(data);
  // name→pill markup byte-identical to the legacy card header, chip appended after.
  assert.match(html, /<span class="tc-name">cart-add-item<\/span>\s*<span class="tc-spec">test\/suite1\/cart\.md<\/span>\s*<span class="tc-status"><span class="pill"/,
    'name→spec→pill order and markup preserved');
  assert.ok(html.includes('</span><span class="tc-time">42s</span>'), 'duration chip directly after the pill span');
  assert.ok(!html.includes('<th>Duration</th>'), 'no step Duration column when no step carries durationMs');

  const withStepDur = v2Base();
  withStepDur.testCases[0].steps[0].durationMs = 3200;
  const html2 = render(withStepDur);
  assert.ok(html2.includes('<th>Duration</th>'), 'step Duration column when some step carries durationMs');
  assert.match(html2, /<td class="step-dur">3s<\/td>/, 'step duration cell rendered');
});

test('v2: gate pin — verifyReports holds ok:true over the enriched markup (name→pill window)', () => {
  // Preferred fork of the design's test 11: require the release-gate checker itself,
  // so any widening of the name→pill gap fails here mechanically.
  const { verifyReports } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'release-gate', 'verify-reports.js'));
  const proj = tmpRunDir();
  const execDir = path.join(proj, 'executions', 'execu_2026-08-28_14-02-11');
  fs.mkdirSync(execDir, { recursive: true });
  const rel = writePng(execDir, 'browser-sessions/cart-140211-a3f2/screenshots/s1-cart.png');
  const data = v2Base();
  data.summary = { total: 3, passed: 1, failed: 1, blocked: 1, naDescoped: 0, notRun: 0 };
  data.testCases[0].screenshots = [{ path: rel, caption: 'cart after add' }];
  data.testCases.push({ name: 'checkout-blocked', spec: 'test/suite1/cart.md', status: 'blocked',
    durationMs: 4000, blockedBy: 'cart-add-item',
    steps: [{ desc: 'Proceed to checkout', status: 'blocked', note: 'upstream: cart-add-item' }] });
  const inFile = path.join(execDir, 'run-summary.json');
  fs.writeFileSync(inFile, JSON.stringify(data));
  execFileSync(process.execPath, [SCRIPT, inFile, path.join(execDir, 'extent-report.html')], { encoding: 'utf8' });
  fs.writeFileSync(path.join(execDir, 'report.md'), [
    '# Suite1 Regression — 2026-08-28', '',
    '- cart-add-item — PASS',
    '- product-search — FAIL',
    '- checkout-blocked — BLOCKED', '',
    '**Interactive report:** [extent-report.html](./extent-report.html)',
    '**Run summary (JSON):** [run-summary.json](./run-summary.json)', '',
  ].join('\n'));
  const res = verifyReports({ dir: proj, scenarios: [
    { name: 'cart-add-item', verdict: 'PASS' },
    { name: 'product-search', verdict: 'FAIL' },
    { name: 'checkout-blocked', verdict: 'BLOCKED' },
  ] });
  assert.deepStrictEqual(res.findings, [], `gate findings: ${JSON.stringify(res.findings)}`);
  assert.strictEqual(res.ok, true, 'release-gate reporting lane holds on enriched markup');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
