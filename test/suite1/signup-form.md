# Spec: Signup form validation

Target: https://example.com/signup   <!-- edit to your app's signup page -->
Type: form validation — NO real account is created (validation-only)

## Acceptance criteria
- Valid input reaches a visible success/confirmation state.
- Invalid input is rejected with a specific, visible error message; the form must not submit.
- No console errors or failed network calls during any scenario.

## Scenarios
1. **Happy path** — fill Name, a disposable email (`qa.tester@example.com`), and a valid
   password, then submit. Expect a visible success confirmation. Verify the confirmation is
   actually displayed (computed visibility), not just present in the DOM. Do NOT complete
   real account creation.
2. **Empty required fields** — submit with every field blank. Expect an inline "required"
   error on each field; the form must not submit.
3. **Bad email format** — enter `not-an-email` in the email field and submit. Expect a
   specific email-format validation error.
4. **Weak password** — enter a 3-character password and submit. Expect a
   password length/strength error.

<!-- Steps can also reach beyond the browser via the integration/ catalog — define the
     entry in integration/*_api.json / *_db.json first, then reference it by name:
5. api: sample-api.get-todo(id=1) → expect HTTP 200 and title present
6. db:  sample-db.todo-by-title(title=qa-test-item) → expect 1 row
-->

## Notes
- Screenshot every scenario (pass and fail).
- Treat any console error or failed request as a defect even if the UI looks fine.
