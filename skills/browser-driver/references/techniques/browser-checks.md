# Techniques: verifying browser steps

- **Refs:** `snapshot` before interacting. Refs change after every navigation, so re-snapshot after each page load.
- **Evidence:** `screenshot` on every PASSED and FAILED scenario, e.g. `npx playwright-cli -s=<session> screenshot --filename=<SESSION_DIR>/screenshots/s1-home.png`. Use descriptive names (`sX-<what>.png`).
- **Console:** `npx playwright-cli -s=<session> console error > <SESSION_DIR>/logs/s1-console.log`. Errors are defects even when the UI looks fine.
- **Visibility:** for success or visibility checks, verify the element's computed display/visibility via `eval`. Text existing in the DOM may be static markup.
- **Network capture:** there is no `requests` subcommand. Attach a listener through `run-code`, on one line (the shell mangles multi-line code):
  `npx playwright-cli -s=<s> run-code "async (page) => { const r=[]; page.on('request',q=>r.push(q.method()+' '+q.url())); await page.click('#x'); await page.waitForTimeout(1500); return JSON.stringify(r); }"`
  Save the capture to `<SESSION_DIR>/logs/` like console output.
- **Viewport** (ui-check steps): `run-code "async (page) => { await page.setViewportSize({ width: 1440, height: 900 }); }"`.
- **Arabic / RTL:** `getByRole` locators with Arabic names work through `run-code` (UTF-8 passes through the shell). Prefer `run-code` plus the documented locators for complex RTL flows.
