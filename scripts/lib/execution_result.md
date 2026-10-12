# Shared executor result contract (v1)

This host-neutral ingestion contract is used by the Codex host integration and is available to other host entrypoints.
It does not alter the existing Claude executor, `run-summary.json`, `verdict.json`, or CI gate.

## Integration

Before dispatch, retain the original saved spec or ad hoc request as a file beneath an
explicit absolute `sourceRoot`. Interpret the prose in the executing host and declare every required
step, its assertion IDs, and whether evidence is required. Call:

```js
const { freezeAssignment, validateExecutionResult } = require('./execution_result');
const assignment = freezeAssignment({
  runId: 'run-1', attemptId: 'attempt-1', assignmentId: 'scenario-1',
  sessionId: 'session-1', scope: { kind: 'spec', value: 'test/sample.md' },
  source: { kind: 'saved-spec', path: 'test/sample.md' },
  requiredSteps: [{ id: 'step-1', assertionIds: ['assertion-1'], evidenceRequired: true }],
  cleanupRequired: true,
  policy: { warningsFailGate: true, flakyFailsGate: false },
}, { sourceRoot });
// Persist `assignment` outside executor control before execution begins.
const validation = validateExecutionResult({ assignment, result, sourceRoot, runRoot });
```

`freezeAssignment` computes the SHA-256 of the retained source, adds `schemaVersion: 1`
and `assignmentDigest`, and freezes nested scope, source, policy, and required steps.
The v1 assignment digest hashes JSON with object keys sorted recursively and array order
preserved, excluding `assignmentDigest` itself. Ingestion requires and recomputes that
digest. Assignments frozen by the earlier staged implementation used insertion-order
JSON hashing; regenerate them before dispatch. The Codex host adapter in
`scripts/codex/host.js` freezes assignments during `prepare` and validates results
during `finalize` and `report`.

The trusted host must persist and later supply the original assignment independently
of the executor result. The unkeyed digest detects drift in that trusted copy; it
does not authenticate an assignment against a caller able to replace both the copy
and its digest. `validateExecutionResult` also rehashes the source. Neither function
interprets the prose or proves the declaration captured all its meaning.

The executor result has `schemaVersion`, `runId`, `attemptId`, `assignmentId`,
`assignmentDigest`, `sourceDigest`, `scope`, `sessionId`, `steps`, `cleanup`,
`scenarioOutcome`, `summary`, `verdict`, and `exitCode`.

Every step result has `stepId`, the four ownership IDs (`runId`, `attemptId`,
`assignmentId`, `sessionId`), `outcome`, `assertions`, and `evidence`. Each assertion
is `{id, passed}`. Outcomes are `PASS`, `FAIL`, `BLOCKED`, `NOT_ATTEMPTED`,
`WARNING`, or `FLAKY`. Evidence entries are `{path, sha256}` with paths relative
to an explicit absolute `runRoot` beneath `browser-sessions/<sessionId>/`. The session
directory must resolve to its canonical location within that run; an alias to another
session is rejected. The referenced regular file must exist, remain within that
session after symlink resolution, and match its hash.
An executor supplied hash detects later artifact changes; it is not proof of the
underlying observation's truth.

`cleanup` is `{runId, attemptId, assignmentId, sessionId, status}` with status
`completed`, `failed`, or `not-required`. Required cleanup must be `completed`.
`summary` describes **one scenario**, not required-step counts, and must exactly
equal `{total:1, passed, failed, blocked, warnings, flaky}` with one matching
outcome count set to 1 and the rest to 0.

The validator returns `{ok, verdict, exitCode, coverage:{required,recorded},errors}`.
Errors contain codes only, never raw source, evidence, or secret-bearing input.
Missing, duplicate, unknown, unattempted, or blocked steps cannot authorize PASS.
Failed assertions produce FAIL when their declared identity, ownership, and required
evidence are valid, even if unrelated required work is incomplete. Invalid assertion
records cannot establish a product failure. Other invalid or incomplete results
produce BLOCKED. Policy considers every observed warning and flaky step, including
mixed outcomes; `warningsFailGate` takes precedence over `flakyFailsGate`, matching
the existing gate defaults when the caller uses `{true,false}`. The result's
reported verdict and exit code must agree with the derived outcome and policy.

The optional CLI accepts four positional arguments: assignment JSON, result JSON,
source root, run root. It prints one JSON line and exits 0/1/2 for PASS/FAIL/BLOCKED.
It is an integration fixture and host adapter, not a replacement for the
legacy Claude verdict writer. Codex uses the validator through its host adapter;
other hosts require their own integration.
