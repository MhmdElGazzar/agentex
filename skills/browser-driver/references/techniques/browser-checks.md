# Techniques: verifying browser steps

- **Refs:** `snapshot` before interacting. Refs change after every navigation, so re-snapshot after each page load.
- **Evidence:** `screenshot` on every PASSED and FAILED scenario, e.g. `npx playwright-cli -s=<session> screenshot --filename=<SESSION_DIR>/screenshots/s1-home.png`. Use descriptive names (`sX-<what>.png`).
- **Console:** `npx playwright-cli -s=<session> console error > <SESSION_DIR>/logs/s1-console.log`. Errors are defects even when the UI looks fine.
- **Visibility:** for success or visibility checks, verify the element's computed display/visibility via `eval` in its function form: `eval "() => getComputedStyle(document.querySelector('#msg')).display"`, or with a snapshot ref `eval "(el) => getComputedStyle(el).visibility" e21`. Text existing in the DOM may be static markup.
- **Network capture**, two paths that capture the same evidence:
  - Everything since the page loaded: act with the plain command, then `npx playwright-cli -s=<s> requests --filter "/api/orders" > <SESSION_DIR>/logs/s1-network.log`. `request <n>` shows one request in full.
  - What one click sends: a listener through `run-code` around that click (never across a secret fill — see `references/tools/fill-secret.md`). One line inline, e.g.
    `npx playwright-cli -s=<s> run-code "async (page) => { const r=[]; page.on('request',q=>r.push(q.method()+' '+q.url())); await page.getByRole('button', { name: 'Place order' }).click(); await page.waitForTimeout(1500); return JSON.stringify(r); }"`,
    or the same function written multi-line to `<SESSION_DIR>/logs/<scenario>-capture.js` and run with `run-code --filename=<that file>` (`references/tools/playwright-cli.md`, run-code contract).
  Save the capture to `<SESSION_DIR>/logs/` like console output.
- **Viewport** (ui-check steps): `npx playwright-cli -s=<s> resize 1440 900`. Only where `--help resize` shows no such command, use `run-code "async (page) => { await page.setViewportSize({ width: 1440, height: 900 }); }"`.
- **Arabic / RTL:** prefer the snapshot refs (Arabic names show in the snapshot). When no ref fits, a `getByRole` locator with an Arabic name works through `run-code` (UTF-8 passes through the shell).
