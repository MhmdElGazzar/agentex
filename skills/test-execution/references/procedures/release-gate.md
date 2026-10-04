# Offline release gate over finalized AgenTeX runs

`scripts/evaluate_release_gate.js` is a provider-neutral policy layer. It reads an
existing `executions/execu_*/run-summary.json` v2 and its referenced evidence.
It never starts a browser, Codex, Claude, CI job, approval, or deployment, and
never changes execution results. The older `ci_gate.js` is a separate
Claude-specific execute-and-verdict entry point; its contract is unchanged.

From the consumer project root:

```text
node <plugin-root>/skills/test-execution/scripts/evaluate_release_gate.js --summary executions/execu_<id>/run-summary.json [--flaky-policy review|fail|allow]
```

The default flaky policy is `review`. The output is a new, exclusively created
`gate-result.json` beside the summary. Re-evaluation never overwrites a prior
decision; use a fresh run or remove the output only after explicitly deciding
to discard that gate record. The evaluator checks schema, nonempty sessions and
results, unique session ownership, scenario/count reconciliation, defect
shape, and that referenced screenshot/log/defect files exist inside the run.
Integrity failure cannot pass. The decision is reproducible from the saved
summary and policy; no evaluation timestamp is used. `sourceSha256` pins the
exact summary bytes used.

| Decision | Exit | Rule | Release/approval |
|---|---:|---|---|
| `PASS` | 0 | All required results passed; explicitly de-scoped results do not gate. `flakyPolicy=allow` can also pass with a visible `flaky-allowed` reason. | No approval required. |
| `FAIL` | 1 | Product failures or warnings (matching the existing CI warning default), or `flakyPolicy=fail`. Reasons distinguish `product` from `instability`. | Release blocked. |
| `REVIEW` | 2 | Blocked, not-run, view-mismatch, integrity errors, or default `flakyPolicy=review`. | Release blocked; human investigation/rerun required. |

When product and infrastructure problems coexist, both reason categories appear;
the product-failure decision takes precedence, as in the existing verdict
mapping. A flaky policy failure is never labeled a product defect. Missing or
malformed input is `REVIEW`/2, never PASS. Invalid invocation or an existing
`gate-result.json` is also exit 2 without overwriting it. The JSON result uses
`schemaVersion:1`, `runId`, `decision`, `exitCode`, reconciled `counts`, ordered
`reasons`, resolved `policy`, `sourceSummary`, `sourceSha256`, and `approval`.
It copies no URL, secret, auth state, worker transcript, or case/step text.

Retention guidance for a future CI integration:

| Class | Artifacts |
|---|---|
| Always retain | `run-summary.json`, `gate-result.json`, `report.md`, `extent-report.html`, and validation diagnostics when generated. |
| Retain on failure/review | `browser-sessions/**/executor-result.json`, referenced screenshots/logs, `bugs/bug-list.md`, defect evidence, and `parallel-timing.json` when present. |
| Optional | Additional traces and nonreferenced diagnostic logs, after privacy review. |
| Never retain/publish | `test/.auth/**`, `.env*`, tokens/credentials, raw Codex/Claude transcripts, and temporary auth copies. |

Codex parallel workers may retain only fixed-vocabulary, sanitized process
diagnostics in their assigned `browser-sessions/<session>/logs/worker-stdout.log`
and `worker-stderr.log`. These local files contain stream byte counts, exit
status, and allowlisted error signals; they are not raw transcripts and must
not be copied into run summaries, manifests, release bundles, or public reports.

Future CI wiring is: install dependencies in the consumer project, execute its
chosen saved specs with the existing sequential or parallel path, validate the
finalized v2 run, invoke this script on that exact run, publish the allowlisted
artifacts even on nonzero exit, and gate downstream release steps on the exit
code. Do not select “latest run” by timestamp when a run path can be passed
directly. No workflow is installed by this reference.
