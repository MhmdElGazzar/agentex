# Codex UI outcome adapter

The shared v1 execution result and validator remain authoritative. A UI-check step
uses a canonical `BLOCKED` outcome while awaiting a user answer or when its form
factor is mismatched. Its optional `uiCheck` object distinguishes the two cases:

- `NEEDS-USER`: `status`, nonempty `question`, `baselineImage`, and `actualImage`.
  Both image paths must occur in that step's hashed evidence list.
- `VIEW MISMATCH ERROR`: `status` and a nonempty `reason` naming the mismatch.
  Any image paths supplied must occur in the step's hashed evidence list.

The coordinator asks the exact question. Before finalization, save an input JSON
file with `answers` and `finalResult`, then call:

```text
node <plugin-root>/scripts/codex/host.js resolve <runRoot> <assignmentId> <input.json>
```

Each answer is `{ "stepId": "<pending-step-id>", "question": "<original-question>",
"resolution": "<user-answer>", "finalStatus": "PASS|FAIL|WARNING|BLOCKED" }`.
`finalResult` is a complete shared v1 result. Change only pending steps' outcomes,
assertions, notes, and `uiCheck.status`, plus the derived scenario outcome,
summary, verdict, and exit code. Preserve the original question, images, other
steps, ownership, and evidence. The command checks the original result and the
proposed result with the shared validator, then writes an immutable resolution
record bound to the original result bytes and frozen assignment. The worker result
is never overwritten. Repeated, stale, altered, or post-finalization resolutions
are rejected. Resolve every pending question for that assignment together.

Without an answer, finalize and report remain BLOCKED and report the precise
question as a `needs-user` reason. View mismatches appear as `viewMismatch` in
the standard report and gate BLOCKED/2; they never create a product FAIL.
Resolved question history appears in the standard report's `deferred` field.
