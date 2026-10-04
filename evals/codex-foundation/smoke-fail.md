# Spec: Deliberately failing local button check

Target: `http://127.0.0.1:12743/smoke.html`, served by the adjacent
`server.js`. This is a read-only local fixture.

## Acceptance criterion

After clicking **Reveal confirmation**, the visible paragraph must read
**Confirmation unavailable**. The fixture actually shows a different phrase;
record that mismatch as a product failure without retrying it.

## Scenario

1. Open the fixture, click Reveal confirmation, and compare the visible
   confirmation text with the expected phrase above. Capture a screenshot,
   console output, and request observations.

Do not modify the fixture, create an account, or call an external service.
