Eval scenario for the AgenTeX plugin's `bug-report-azure` skill (early bundled-input
discipline). You are working interactively with a QA engineer. A completed regression run
found one confirmed checkout defect, and the high-level bootstrap operation has ALREADY
completed its read-only work against Azure DevOps. Treat the captured bootstrap and settled
run facts below as authoritative. Do not call Azure, run a shell/script operation, inspect
other files, or create/modify any file in this scenario.

Settled run facts:

- File one Bug titled `Payment fails at checkout with an HTTP 500 page` under User Story
  #321, `Checkout story` (Active).
- Summary: `Clicking Pay with valid card data returns a raw HTTP 500 page; no order is
  created.`
- Steps: open checkout; enter valid card data; click Pay.
- Expected: an order confirmation with an order number.
- Actual: a raw HTTP 500 page and no created order.
- Classification is settled as severity `1 - Critical`, priority `1`, because checkout is
  blocked and the run found no workaround.
- Attach `ERROR-checkout.png`; it already passed structural and visual review and directly
  shows this defect. No evidence waiver or exception is needed.
- The user accepts all resolved runtime defaults below. No classification, assignee,
  parent, evidence, duplicate-exception, or field-value question remains.
- All conditional test-case details are already settled, so choosing an action cannot
  introduce a later details question:
  - `fail-existing`: Test Plan #3, existing Test Case #700, comment
    `Failed in regression: valid checkout returned HTTP 500.`, run name
    `Checkout regression 2026-09-10`;
  - `create-new`: Test Plan #3, suite #31 (`Checkout`), title
    `Shopper || Checkout || valid payment returns HTTP 500`;
  - `skip`: no test-case write.

Captured result of `bug-report.js context --parent 321 --emit-intent`:

```json
{
  "ok": true,
  "mode": "context",
  "template": {
    "configured": true,
    "id": 99,
    "type": "Bug",
    "title": "Team bug template",
    "state": "New"
  },
  "parent": {
    "id": 321,
    "type": "User Story",
    "title": "Checkout story",
    "state": "Active"
  },
  "defaults": {
    "assignedTo": "qa.engineer@example.com",
    "environment": "QA",
    "bugCategory": "Functional",
    "valueArea": "Business"
  },
  "choices": {
    "assignedTo": ["qa.engineer@example.com"],
    "severity": ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"],
    "priority": ["1", "2", "3", "4"],
    "environment": ["QA", "UAT", "Production"],
    "bugCategory": ["Functional", "UI", "Data"]
  },
  "requiredInputs": {
    "assignedTo": {
      "required": true,
      "resolved": true,
      "needsUserInput": false,
      "choices": ["qa.engineer@example.com"]
    }
  },
  "supported": {
    "environment": true,
    "bugCategory": true,
    "valueArea": true
  },
  "processRequirements": {
    "agentSupplied": [
      "title",
      "assignee",
      "priority",
      "severity",
      "reproduction details"
    ],
    "automatic": [],
    "unsupported": []
  },
  "testPlan": {
    "configured": true,
    "id": "3"
  },
  "metadata": {
    "refreshed": false,
    "builtAt": "2026-09-10T08:00:00Z"
  },
  "duplicateReview": {
    "status": "intent-required",
    "strategy": "lexical-idf-recall-v0",
    "view": "shortlist",
    "defaultShortlistSize": 25,
    "totalCandidates": 0,
    "shownCandidates": 0,
    "omittedCandidateCount": 0,
    "truncated": false,
    "pinnedExactTitleCount": 0,
    "shortlistCandidateIds": []
  },
  "intentTemplate": {
    "title": null,
    "summary": null,
    "steps": [],
    "expected": null,
    "actual": null,
    "severity": null,
    "priority": null,
    "classificationReason": null,
    "parentStoryId": 321,
    "assignedTo": null,
    "environment": null,
    "bugCategory": null,
    "valueArea": null,
    "testConfiguration": null,
    "observedAt": null,
    "evidence": {
      "attach": [],
      "reject": [],
      "waiveScreenshots": false,
      "allowInvalid": false
    },
    "duplicate": { "allow": false },
    "testCase": {
      "action": null,
      "planId": null,
      "testCaseId": null,
      "comment": null,
      "runName": null,
      "suiteId": null,
      "title": null,
      "allowDuplicate": false
    }
  },
  "nothingWritten": true
}
```

At this point the complete unresolved user-question set is closed: the only unresolved
explicit choice is `testCase.action`. An older workflow would author the intent, perform
duplicate review, and ask about the Test Case afterward. Follow the current skill instead.

Immediately issue the single bundled native user question now. It must be single-select
and offer the three permitted actions, clearly mapped to `fail-existing`, `create-new`, and
`skip`. Do not silently choose one. STOP at that unanswered question: do not author intent,
review duplicates, prepare, execute, or perform any other workflow call or write.
