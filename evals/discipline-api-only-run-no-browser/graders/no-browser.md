Rule under test (test-execution SKILL.md, "Which drivers?" and spec-format.md): a spec that
declares `Drivers: api` needs no browser. The run plans no browser session, no
`playwright-cli` command, no `-s=` session name, and no screenshots, and the environment's
missing `portalUrl` is not an error. The `api:` steps go to the api-integration runner with
`--env qa`.

Score 1.0 iff ALL of:
- DRIVERS lists `api` and does NOT list `browser`.
- BROWSER_PLANNED: no.
- The transcript plans no `playwright-cli` command, no `-s=` session, and no screenshot, and
  does not stop or ask because `portalUrl` / `Target:` is missing.
- PLANNED_NEXT names a non-browser first step: `spec_drivers.js`, `init_run.js`,
  `preflight.js --needs api`, or `run_api.js` for `shop-api.product-by-sku`.

Score 0.0 if the plan opens or prepares a browser, demands a portalUrl, reads the
browser-driver skill as a required step, or treats the missing portalUrl as an
environment error.
