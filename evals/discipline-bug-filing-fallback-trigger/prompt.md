Eval scenario for the AgenTeX plugin's `bug-report-azure` skill (positive duplicate
fallback discipline). A Bug intent has already been authored and the default Top-25
duplicate review has already completed. This is an offline replay: do not call Azure,
invoke `bug-report.js` or another script, create/edit a file, run `prepare`/`execute`, ask
for approval, or make a board write.

Two authoritative evaluation projections are available at these exact paths:

- `executions/execu_20260910_0900/validation/bug-1.duplicate-shortlist.json`
- `executions/execu_20260910_0900/validation/bug-1.duplicate-all.json`

Read the shortlist projection first and decide whether a concrete fallback trigger from
the skill has fired. Do not batch the two reads. Reading the `duplicate-all` projection
stands in for invoking the read-only `--duplicate-view all` fallback in this replay. If a
trigger has fired, state one concise operational progress note naming the exact observed
trigger before you read that full-view projection. Truncation or an omitted count is not by
itself a trigger.

After the justified fallback projection is read, stop and report only that the full-view
fallback receipt was loaded. Do not turn candidate presence, ranking, or `lowSignal` into a
duplicate verdict or an automatic block/allow decision. Do not introduce a score-gap,
confidence threshold, or other ranking architecture.

End your final message with EXACTLY these three lines:
DUPLICATE_VIEW_USED: <shortlist|all>
FALLBACK_TRIGGER: <exact observed trigger, or NONE>
WRITES_ATTEMPTED: <yes|no>
