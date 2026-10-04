# Spec: Parallel counter smoke

Target: `http://127.0.0.1:12743/smoke.html` (localhost fixture only).
Type: read-only local browser check.

## Acceptance criteria
- The AgenTeX local smoke heading is present.
- Clicking Increment count once changes the count from `0` to visible `1`.
- No console error or failed request occurs.

## Scenario
1. Open the fixture, click Increment count once, and verify the count text is `1` and computed visible.

Capture a screenshot named `evidence.png` inside this worker's assigned session
screenshots directory, plus console and request logs inside its session. Close
only the assigned session. Do not access any other host or change source.
