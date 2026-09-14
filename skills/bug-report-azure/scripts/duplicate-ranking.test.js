'use strict';
// Focused tests for the duplicate-ranking helper used by the public workflow.
// Run: node skills/bug-report-azure/scripts/duplicate-ranking.test.js
const assert = require('node:assert');
const { rankDuplicateCandidates, projectShortlist } = require('./duplicate-ranking.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL - ${name}: ${error.stack || error.message}`); }
}

const HISTORICAL_INTENT_413075 = {
  title: "Invoice.ExpiryDate is set 3 hours earlier than the quote's expiry (QuotationRequests.ExpireAt)",
  summary: 'Invoices.ExpiryDate is written exactly 3 hours (10800s) before QuotationRequests.ExpireAt for card and SADAD payments.',
  steps: ['Complete a cargo purchase on QC', 'Compare Invoices.ExpiryDate with QuotationRequests.ExpireAt'],
  expected: 'Invoices.ExpiryDate equals QuotationRequests.ExpireAt.',
  actual: 'Invoices.ExpiryDate is exactly QuotationRequests.ExpireAt minus 3 hours; DiffSeconds = -10800 on every sample.',
};

const HISTORICAL_DUPLICATE_410437 = {
  id: 410437,
  type: 'Bug',
  title: 'Invoice expiry is 3 hours earlier than quote expiry (card + SADAD) — US 402386 AC not met',
  state: 'New',
  reproductionSummary: 'Invoices.ExpiryDate and SadadExpiryTime are exactly 3 hours (10800s) earlier than QuotationRequests.ExpireAt on every sample tested. Confirmed across card and SADAD on QC.',
};

function candidate(id, title, reproductionSummary = '', state = 'Closed') {
  return { id, type: 'Bug', title, state, reproductionSummary };
}

test('keeps the confirmed #413075 -> #410437 duplicate inside recall@15', () => {
  const distractors = Array.from({ length: 48 }, (_, index) => candidate(
    500000 + index,
    `Marine regression ${index + 1}`,
    'Open the customer portal, complete the configured flow, and compare expected with actual results.',
    index % 3 === 0 ? 'New' : 'Closed',
  ));
  const result = rankDuplicateCandidates(HISTORICAL_INTENT_413075, [
    ...distractors,
    candidate(413076, 'SADAD bill generation fails when registration number is not the QC placeholder',
      'SADAD is unavailable during bill generation on QC; no bill is created.'),
    HISTORICAL_DUPLICATE_410437,
  ]);
  const duplicate = result.ranked.find((entry) => entry.candidate.id === 410437);
  assert.ok(duplicate);
  assert.ok(duplicate.rank <= 15, `expected #410437 in top 15, got rank ${duplicate.rank}`);
  assert.ok(duplicate.match.matchedReproductionTerms.includes('10800'));
});

test('normalizes Unicode punctuation and retains technical code components', () => {
  const result = rankDuplicateCandidates(
    { title: 'Payment — HTTP‑500 E-11000', actual: 'The gateway returned HTTP-500 and E11000.' },
    [candidate(2, 'Payment HTTP500 E11000'), candidate(1, 'Logo alignment issue')],
  );
  assert.strictEqual(result.ranked[0].candidate.id, 2);
  for (const token of ['http', '500', 'e', '11000']) {
    assert.ok(result.ranked[0].match.matchedReproductionTerms.includes(token), `missing ${token}`);
  }
});

test('uses IDF to favor rare defect signals over common boilerplate', () => {
  const intent = {
    title: 'Visa submission returns HTTP 500 at checkout',
    actual: 'A valid Visa submission returns HTTP 500.',
  };
  const common = Array.from({ length: 40 }, (_, index) => candidate(
    600000 + index,
    'Checkout payment page error',
    'The checkout payment page shows an error during the customer flow.',
  ));
  const rare = candidate(610, 'Valid card submission returns a server error', 'Submitting a valid Visa returns HTTP 500.');
  const result = rankDuplicateCandidates(intent, [...common, rare]);
  assert.strictEqual(result.ranked[0].candidate.id, 610);
});

test('is deterministic, input-order independent, and does not mutate input', () => {
  const intent = { title: 'Same signal', actual: 'Same signal' };
  const candidates = [candidate(12, 'Same signal'), candidate(4, 'Same signal'), candidate(9, 'Same signal')];
  const snapshot = JSON.stringify({ intent, candidates });
  const forward = rankDuplicateCandidates(intent, candidates).ranked.map((entry) => entry.candidate.id);
  const reverse = rankDuplicateCandidates(intent, [...candidates].reverse()).ranked.map((entry) => entry.candidate.id);
  assert.deepStrictEqual(forward, [4, 9, 12]);
  assert.deepStrictEqual(reverse, forward);
  assert.strictEqual(JSON.stringify({ intent, candidates }), snapshot);
});

test('does not filter or penalize Closed and Resolved candidates and emits no verdict', () => {
  const candidates = [
    candidate(30, 'Exact defect signal', 'Rare code ZX-991', 'Closed'),
    candidate(10, 'Exact defect signal', 'Rare code ZX-991', 'Active'),
    candidate(20, 'Exact defect signal', 'Rare code ZX-991', 'Resolved'),
  ];
  const result = rankDuplicateCandidates({ title: 'Exact defect signal', actual: 'Rare code ZX991' }, candidates);
  assert.deepStrictEqual(result.ranked.map((entry) => entry.candidate.id), [10, 20, 30]);
  assert.deepStrictEqual(new Set(result.ranked.map((entry) => entry.candidate.state)), new Set(['Active', 'Resolved', 'Closed']));
  for (const entry of result.ranked) {
    for (const forbidden of ['isDuplicate', 'verdict', 'decision', 'blocked']) {
      assert.ok(!(forbidden in entry) && !(forbidden in entry.match));
    }
  }
});

test('top-15, top-25, and top-40 are stable prefixes with explicit projection counts', () => {
  const candidates = Array.from({ length: 287 }, (_, index) => candidate(
    700000 + index,
    `Candidate ${index + 1}`,
    `Reproduction ${index + 1} for shared flow`,
    index % 2 ? 'Closed' : 'New',
  ));
  const result = rankDuplicateCandidates({ title: 'Candidate 200', actual: 'Reproduction 200' }, candidates);
  const top15 = projectShortlist(result, 15);
  const top25 = projectShortlist(result, 25);
  const top40 = projectShortlist(result, 40);
  assert.deepStrictEqual(top25.candidates.slice(0, 15), top15.candidates);
  assert.deepStrictEqual(top40.candidates.slice(0, 25), top25.candidates);
  assert.deepStrictEqual(
    [top15.totalCandidates, top15.shownCandidates, top15.omittedCandidateCount],
    [287, 15, 272],
  );
});

test('shortlist projection pins every normalized exact-title match beyond the cap', () => {
  const exacts = Array.from({ length: 27 }, (_, index) => candidate(
    800000 + index,
    index % 2 ? '  PAYMENT   FAILS AT CHECKOUT  ' : 'Payment fails at checkout',
  ));
  const distractors = Array.from({ length: 10 }, (_, index) => candidate(
    810000 + index,
    `Payment checkout diagnostic ${index + 1}`,
    'A valid card produces an HTTP 500 error.',
  ));
  const result = rankDuplicateCandidates({ title: 'Payment fails at checkout' }, [...distractors, ...exacts]);
  const shortlist = projectShortlist(result, 25);
  assert.strictEqual(shortlist.defaultShortlistSize, 25);
  assert.strictEqual(shortlist.pinnedExactTitleCount, 27);
  assert.strictEqual(shortlist.shownCandidates, 27);
  assert.strictEqual(shortlist.omittedCandidateCount, 10);
  assert.strictEqual(shortlist.truncated, true);
  assert.deepStrictEqual(
    new Set(shortlist.candidates.map((item) => item.id)),
    new Set(exacts.map((item) => item.id)),
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
