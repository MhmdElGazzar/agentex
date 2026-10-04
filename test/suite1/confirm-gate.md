# Spec: Apply change confirmation (defined live)

Target: http://127.0.0.1:12744/confirmation-button.html
Type: confirmation gate — read-only UI toggle

## Acceptance criteria
- Clicking Apply change reveals the confirmation paragraph.
- The revealed text is exactly "Change applied" and it is computed-visible.
- No JavaScript console error or failed network request occurs.

## Scenarios
1. Open the confirm-gate fixture and click Apply change; expect the "Change applied" paragraph to become visible.
