### Fixed
- **Signing in by the form right after a cleared saved login no longer fails on sites that need a CSRF cookie.** `login_state.js load` now reloads the page after clearing the dead cookies and localStorage, so the form carries a fresh token.
