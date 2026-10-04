# Spec: Parallel controlled failure

Target: `http://127.0.0.1:12743/smoke.html` (localhost fixture only).
Type: read-only local browser check.

## Acceptance criterion
After clicking Reveal confirmation, the visible paragraph must read
`Confirmation unavailable`. The fixture intentionally displays a different
phrase. Classify the mismatch as a product failure, not infrastructure, and
do not retry it.

## Scenario
1. Open the fixture, click Reveal confirmation, and compare the visible text with `Confirmation unavailable`.

Capture a screenshot named `evidence.png` inside this worker's assigned session
screenshots directory, plus console and request logs inside its session. Close
only the assigned session. Do not access any other host or change source.
