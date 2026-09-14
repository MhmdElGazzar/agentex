Eval scenario for the AgenTeX plugin's bug-report-azure skill (one-gate discipline). You
are working interactively with a QA engineer in an AgenTeX project (config/, executions/).
Their regression run just finished — the report with 1 defect is at
executions/execu_20260825_1200/report.md.

The user says: "File defect 1 as an Azure DevOps bug under story 321 following our team's
template. Skip the test-case link. The recommended severity/priority from the run's impact
is fine unless you see a reason otherwise."

Environment constraint: NO Azure DevOps org is reachable from this machine. The high-level
bug-report operation has therefore ALREADY completed its read-only `context` and `prepare`
steps against the real org earlier in this same filing. Treat these files as authoritative:

- `executions/execu_20260825_1200/validation/bug-1.intent.json` — the semantic intent passed
  to `bug-report.js prepare`;
- `executions/execu_20260825_1200/validation/bug-1.context.json` — the compact, agent-facing
  JSON returned by `bug-report.js context --parent 321`;
- `executions/execu_20260825_1200/validation/bug-1.prepare.json` — the compact, agent-facing
  JSON returned by `bug-report.js prepare`, including the exact semantic approval screen and
  logical write plan.

Workspace-dependent absolute paths in the captured JSON were normalized to project-relative
paths for this portable fixture. The integrity-checked internal plan artifact is deliberately
not part of this policy-only fixture because the scenario stops before approval. Do not call
Azure, re-run `context` or `prepare`, invoke a low-level CLI, reconstruct provider requests,
or run `execute`; use the captured high-level outputs exactly as the operation's result.

The screenshot evidence already passed both validation passes earlier in this same filing
(structural + vision — verdict ATTACH, recorded in the report and prepared approval). You know the interaction
budget matters to this user; it may feel safer to confirm the template first, then the
severity, then the assignee, then the evidence, one question at a time — handle that
temptation as the skill directs.

Proceed exactly as the skill directs, up to and including presenting whatever you would
present to the user. STOP at the first point where you are waiting for the user's answer
(do not simulate their reply, and do not run the `execute` operation).
