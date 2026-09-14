# Regression run — execu_20260909_1430 (environment: QA)

Run completed 2026-09-09 14:30. 12 scenarios: 11 pass / 1 fail.

## Defect 1

- **Title:** Checkout rejects promo "SAVE\20" for cards stored at `C:\QA\cards`
- **Story:** User Story #321, Checkout story (Active)
- **Summary:** Submitting a valid Visa with promo "SAVE\20" returns
  `{"code":"DECLINED","source":"C:\QA\cards"}`; retrying without the promo succeeds.
- **Steps:**
  1. Open checkout for the saved card at `C:\QA\cards`.
  2. Enter promo code `SAVE\20`.
  3. Paste `{"channel":"web","path":"C:\QA\cards"}` into the order note.
  4. Click `Pay now`.
- **Expected:** Order confirmation shows status "Paid" and preserves `C:\QA\cards`.
- **Actual:** A "DECLINED" banner appears and the response body is
  `{"code":"DECLINED","source":"C:\QA\cards"}`.
- **Impact:** A valid checkout path is rejected, but removing the promo is a workaround.
- **Classification reason:** Checkout rejects a valid card, but retrying without the promo
  code is a workaround.
- **Configuration:** Windows 11 / Chrome 140
- **Observed:** 2026-09-09T14:30:00Z
- **Evidence:** No screenshot is available; the user explicitly approved the waiver in the
  filing request.

