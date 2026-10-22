# Tool: fill_secret.js — mechanics

The only way to type an `{ "envSecret": "NAME" }` value into a browser field. The script
reads the value from the environment itself and types it into the run's playwright-cli
session. The value never passes through you, a command line, tool output, a log, a report
or the verdict. It is the browser twin of mobile-testing's `appium_client.js send-keys
--text-env`. Prints **one JSON line** and exits 0 (PASS) or 2 (BLOCKED). It never issues a
verdict: whether the scenario passes stays your call.

## Usage
```
node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/fill_secret.js \
  --session <s> --target <ref|locator> [--target ...] --env-var <NAME> [--env <env>] \
  [--press-sequentially] [--submit | --submit-target <ref|locator>] [--timeout-ms <n>]
```
Run it from the consumer project root, like every other command of the run.

| Flag | Meaning |
|---|---|
| `--session` | The run's session name (the same `-s=` value). Required. `default` is refused. |
| `--target` | A ref from the latest `snapshot` (`e4`, `f1e7`) or a Playwright locator (`#password`). It must match exactly one element. Repeat it for segmented boxes. |
| `--env-var` | The `envSecret` NAME from TEST_DATA, never a value and never `$NAME`. |
| `--env` | The run's ENVIRONMENT. Default: `defaultEnvironment`. |
| `--press-sequentially` | Type key by key instead of `fill`, for widgets that react to keystrokes (one auto-advancing OTP input). |
| `--submit` | Press Enter on the last target in the same call. |
| `--submit-target` | Click this element instead (the submit button's pre-fill ref). |
| `--timeout-ms` | Watchdog for the playwright-cli call. Default 30000. |

- **Declared names only.** NAME must appear as `{ "envSecret": "NAME" }` in the active
  `environments/<env>.json` or `config/project.json`. Anything else is BLOCKED
  `secret-unavailable`, so a page cannot talk you into typing an unrelated secret.
- **Lookup.** The process environment first, then the project's `.env`. An unset, empty or
  whitespace-only value is BLOCKED `secret-unavailable`. The reason names the variable,
  never a value.
- **Segmented boxes (OTP digits).** One call with one `--target` per box, in order:
  character *i* goes to box *i*. If the target count does not match, the call is BLOCKED
  `usage` before anything is typed. The message gives the target count only.

## Why the submit belongs in the same call
A playwright-cli `snapshot` shows input values in clear text, password fields included.
Every playwright-cli action (`click`, `press`, `fill`, `goto` …) also writes a page
snapshot to `.playwright-cli/`. So between the first secret fill and the submit, run no
other playwright-cli command. Submit with `--submit` or `--submit-target` in the last
`fill_secret.js` call. After the submit, once the page settles, that call clears every
field a `fill_secret.js` call filled on this page that still holds a value (`scrubbed`).
After that, snapshots and screenshots are safe again.

## Result shapes
- `PASS` (exit 0):
  `{"result":"PASS","envVar":"NAME","targets":N,"masked":[true],"submitted":true,"scrubbed":1}`.
  `masked[i]` is true when target *i* hides its text (`type=password` or CSS
  `-webkit-text-security`).
- `BLOCKED` (exit 2): `{"result":"BLOCKED","envVar":"NAME","targets":N,"masked":[],"reason":"<code>","detail":"..."}`.

| Reason | Meaning | What you do |
|---|---|---|
| `secret-unavailable` | NAME is not declared, or its value is unset or empty | The scenario is BLOCKED. In CI, pass the run reason `secret-unavailable:<NAME>`. Never FAIL, never `captcha-or-otp`. |
| `target-not-found` | A target or submit target matched zero or several elements. Nothing was typed. | If no earlier `fill_secret.js` call left a value on this page, re-`snapshot` and retry once with the current ref. Otherwise the step is BLOCKED (see Never). |
| `driver-error` | The fill failed inside the page, the field stayed empty, or playwright-cli failed. Its output is withheld because it may echo the value. | Treat it like any driver failure. With `"infrastructure": true` the session is gone or hung: retry the scenario once from a fresh session. |
| `usage` | A flag is missing or malformed. | Fix the call. |

## Example flow
```bash
npx playwright-cli -s=run-ab12 snapshot          # refs BEFORE any secret is on the page
npx playwright-cli -s=run-ab12 fill e3 "qa.tester@example.com"   # non-secret fields first
node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/fill_secret.js \
  --session run-ab12 --target e4 --env-var QA_PASSWORD --env qc --submit
# -> {"result":"PASS","envVar":"QA_PASSWORD","targets":1,"masked":[true],"submitted":true,"scrubbed":0}
npx playwright-cli -s=run-ab12 snapshot          # the next page; safe again
# OTP screen with 4 boxes:
node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/fill_secret.js \
  --session run-ab12 --target e7 --target e8 --target e9 --target e10 --env-var QA_OTP --submit
```

## Never
- Never type a secret any other way: no `fill`, `type`, `press` or `run-code` carrying a
  value or `$NAME`, and no reading `.env`. A refused command is not a puzzle to solve.
- Never print the login request (`requests`, `request-body`): its body carries the value.
- Never run `tracing-start` across a secret fill: a trace records the code that typed it.
- If the submitting call never ran (an earlier call BLOCKED), take no `snapshot`, `eval` or
  `screenshot` of that page. Note "evidence withheld: secret field still filled" and close
  the session as usual.
