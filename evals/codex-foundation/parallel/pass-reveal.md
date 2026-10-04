# Spec: Parallel reveal smoke

Target: `http://127.0.0.1:12743/smoke.html` (localhost fixture only).
Type: read-only local browser check.

## Acceptance criteria
- The AgenTeX local smoke heading is present.
- Clicking Reveal confirmation displays `Confirmation visible` with computed visibility.
- No console error or failed request occurs.

## Scenario
1. Open the fixture, click Reveal confirmation, and verify the visible confirmation text.

Capture a screenshot named `evidence.png` inside this worker's assigned session
screenshots directory, plus console and request logs inside its session. Close
only the assigned session. Do not access any other host or change source.
