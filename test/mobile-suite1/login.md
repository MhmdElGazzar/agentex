# Spec: App login

App under test: (fill in — `.apk`/`.ipa` path or installed `appPackage`/`bundleId`, via the
`mobile` block in `environments/<env>.json`)
Type: login / validation — no real account is created (validation-only)

## Acceptance criteria
- A valid disposable test user reaches a visible logged-in / home state.
- An invalid password is rejected with a specific, visible error; the app must not proceed
  past the login screen.
- Leaving required fields empty shows an inline "required" error on each field.

## Scenarios
1. **Happy path** — log in as `valid_user` (from `environments/<env>.json`'s `users`); expect
   the home screen's landmark element to become visible.
2. **Wrong password** — log in as `valid_user` with an obviously wrong password; expect a
   visible "invalid credentials" error, still on the login screen.
3. **Empty fields** — tap login with both fields empty; expect an inline "required" error on
   each field.

## Notes
- Screenshot every scenario (pass and fail).
- Treat any app crash, ANR, or unexpected stack trace in the device log as a defect even if
  the screen looks fine.
- Never use a real personal account — `valid_user` should be a disposable/shared QA test
  account defined in `environments/<env>.json`.
