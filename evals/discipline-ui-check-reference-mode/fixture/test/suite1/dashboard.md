# Spec: dashboard design conformance (reference)

Target: https://qa.eval-fixture.example/dashboard

## Acceptance criteria

- The dashboard generally follows the approved layout; the details that matter are
  enumerated on the ui-check step.

## Scenarios

1. Open the dashboard; expect the stat cards row.
2. ui-check: image test/baselines/dashboard-desktop.png — mode: reference
   - must: a red alert banner spans the top of the page
   - must: exactly three stat cards are shown in the first row
