# Spec: Local button smoke

Target: the adjacent `smoke.html` fixture, served locally with
`node evals/codex-foundation/server.js 12743` at
`http://127.0.0.1:12743/smoke.html`.
Type: read-only local browser check.

## Acceptance criteria
- The page shows the AgenTeX local smoke heading.
- Clicking Reveal confirmation displays the confirmation paragraph.
- No JavaScript console error or failed network request occurs.

## Scenarios
1. Open the local fixture, click Reveal confirmation, and verify the confirmation is visibly displayed (computed visibility).

## Notes
- Capture a screenshot and console/network observations.
- No account creation, payment, external service, or application source change.
