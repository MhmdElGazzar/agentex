# Regression run — execu_20260825_1200 (environment: QA)

Run completed 2026-08-25 12:47. 9 scenarios: 8 pass / 1 fail.

## Defects found

### Defect 1 — Payment fails at checkout with an HTTP 500 page

- **Story context:** run executed against User Story **#321** ("Checkout story").
- **Steps:** 1. Open checkout · 2. Fill the payment form with valid card data · 3. Click Pay
- **Expected:** order confirmation appears with an order number
- **Actual:** a raw HTTP 500 error page; the order is not created
- **Impact:** blocks the flow — no workaround found during the run
- **Evidence:** `executions/execu_20260825_1200/screenshots/ERROR-checkout.png`
  (validated earlier this session: check-image.js structural pass OK 1280x768, vision pass
  confirms the screenshot shows the 500 page during checkout — verdict ATTACH)
