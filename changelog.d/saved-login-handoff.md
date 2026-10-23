### Added
- **A saved login now reaches the test browser.** With `login.mode: "session"` (the wizard's
  default), a run reloads the saved login into its own browser and starts signed in, and after a
  login through the UI it saves a fresh one. A new script, `browser-driver/scripts/login_state.js`
  (`load` / `save`), moves the file through `@playwright/cli`'s own `state-load` / `state-save`, so
  it needs no `playwright` library and never reads, prints or passes a cookie or storage value. It
  checks a signed-in landmark before saving and after loading (never the URL), refuses to save when
  `test/.auth/` is not gitignored, never saves in CI, and falls back to the UI login whenever a saved
  login is missing, expired or unreadable. Documented in `references/tools/login-state.md`.

### Changed
- **The saved login file is named per user.** `test/.auth/<env>-<user>-state.json` (plus a small
  `<env>-<user>-state.meta.json` with the page and landmark it was proven with), so a spec that
  logs in as `buyer` and as `admin` keeps both. A file saved under the old `<app>-<env>-state.json`
  name is not read: the first run logs in once and saves under the new name; delete the old file.
- **The "only the library can load a saved storageState" message is gone** from `session.js` and
  from preflight's `playwright` hint: a run's saved login does not need the library.
