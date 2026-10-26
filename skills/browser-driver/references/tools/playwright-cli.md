# Tool: playwright-cli

The browser driver for all browser actions in a test-execution run.

## Setup
- The CLI is the npm package **`@playwright/cli`**. Invoke it as `npx playwright-cli <command>` (a local devDependency, not global).
- Trust the `preflight.js` verdict for it: the probe judges by output, not exit code alone (see `../experience/gotchas.md`). If it reports `ok: false`: `npm install -D @playwright/cli`, then `npx playwright-cli install-browser chromium`.
- `preflight.js` also reports **`playwright`**: the npm library, a different thing from this CLI. A run does not need it: this CLI loads and saves a `storageState` itself, inside the run's session (see "Saved logins" below). Only optimize-login's standalone `session.js` check, which launches its own library browser, needs it. `ok: false` there does not block a run. To install it: `npm i -D playwright`, then `npx playwright install chromium`.
- Headed (demos, watching): add `--headed`, e.g. `npx playwright-cli open <url> --headed`. Parallel and regression runs are headless.

## Choosing the command
Go in this order for every browser action:
1. A `{ "envSecret" }` field is never a playwright-cli command: `fill_secret.js` types it (`fill-secret.md`).
2. **A plain command first.** If a command in the shape table below does it, use that command. Not sure of its shape? Run `npx playwright-cli --help <command>` before the call, not after an error.
3. **run-code only for what no command does:** a click-scoped network listener, a locator no snapshot ref can name, a viewport on a CLI without `resize`. Follow the run-code contract below.

run-code is never the retry for a failed `click`, `fill`, `check` or `select`. That failure is evidence (`../experience/gotchas.md`, "Driver error vs app defect"). Never use `force: true`, and never an `element.click()` through `evaluate`: either one can turn a real defect into a PASS.

## Argument shapes
Every command carries `-s=<session>`. `<target>` is a ref from the latest `snapshot` (`e12`) or a unique selector. Prefer the ref: a selector you write yourself can match the wrong element. The target is positional: `click e12`, never `click --ref e12`.

| Command | Shape | Options that exist |
|---|---|---|
| open | `open [url]` | `--headed` (demos only), `--browser`, `--device` |
| goto | `goto <url>` | none |
| reload | `reload` | none |
| snapshot | `snapshot [target]` (re-run after every navigation) | `--filename`, `--depth` |
| click | `click <target> [button]` | `--modifiers` (repeatable) |
| fill | `fill <target> <text>` | `--submit` (Enter after) |
| type | `type <text>`: **no target**, types into the focused element (click or fill the field first) | `--submit` |
| press | `press <key>` (`Enter`, `Tab`, `ArrowLeft`) | none |
| check / uncheck | `check <target>` / `uncheck <target>` (a label-wrapped radio works by its ref) | none |
| select | `select <target> <value>` | none |
| hover | `hover <target>` | none |
| screenshot | `screenshot [target] --filename=<path>` | `--full-page`, `--type` |
| eval | `eval "<func>" [target]`, func = `() => …` (page) or `(el) => …` (with a target); runs **in the browser** | `--filename` (save the result) |
| console | `console [min-level]` (`error`) | `--clear` |
| requests | `requests`: every request since the page loaded, numbered | `--filter <regexp>`, `--static`, `--clear` |
| request | `request <n>` (also `request-body <n>`, `response-body <n>`) | `--filename` |
| resize | `resize <w> <h>`: the viewport (`page.setViewportSize` underneath) | none |
| run-code | `run-code "<function>"` or `run-code --filename=<file>`; runs **in Node with `page`** | `--filename` |
| list / close / show | List sessions / close one (`-s=<session> close`) / open the dashboard (works headless too) | none |

**Options that do not exist (an `Unknown option` error):** `--ref`, `--r`, `--e`, `--element`, `--target`, any per-command `--timeout`, and a positional screenshot path (`screenshot shot.png` is read as a selector). `--target` belongs to `fill_secret.js` and `--timeout-ms` to `login_state.js`. Those are the plugin's own scripts, never `npx playwright-cli`.

## When the CLI rejects a command
A usage error is your own command error: `Unknown option`, a missing argument, an unknown command, or a run-code `SyntaxError` / `ReferenceError` (`require is not defined`, `window is not defined`). The app never saw the action.
1. First usage error on this step: run `npx playwright-cli --help <command>` (or `--help` for the list), or reread the run-code contract, and correct the call once. The installed CLI is the truth: its version may differ from this table. Never try a second guessed flag.
2. A second usage error on the same step: stop. In a run, the step is BLOCKED with the CLI's error verbatim.

A usage error is never infrastructure (no scenario retry, never FLAKY) and never a defect. Any other failure is classified by `../experience/gotchas.md`.

## run-code contract
| Rule | Right | Wrong (the error you get) |
|---|---|---|
| 1. One function expression, called with `page` | `run-code "async (page) => { await page.getByRole('tab', { name: 'Orders' }).click(); }"` | `run-code "await page.click('#tab')"` (`SyntaxError: Unexpected identifier 'page'`) |
| 2. No Node globals (`require`, `process`, `fs`). Return the value and redirect the output | `run-code "async (page) => JSON.stringify(await page.title())" > <SESSION_DIR>/logs/s1-title.log` | `run-code "async (page) => { const fs = require('fs'); … }"` (`ReferenceError: require is not defined`) |
| 3. DOM and browser globals only inside `page.evaluate`. For a single read, `eval` is the plain command | `run-code "async (page) => String(await page.evaluate(() => window.scrollY))"` | `run-code "async (page) => window.scrollY"` (`ReferenceError: window is not defined`) |
| 4. Inline means one line in double quotes with single quotes inside. Anything longer, or needing both kinds of quote, goes in a file holding the same single function | write `<SESSION_DIR>/logs/s3-capture.js`, then `run-code --filename=<SESSION_DIR>/logs/s3-capture.js` | a multi-line or nested-double-quote string on the command line (the shell splits it) |
| 5. No HTTP of its own: no `page.request`, `fetch`, `route` | API checks are `api:` steps from the catalog | `run-code "async (page) => (await page.request.get('/api/orders')).status()"` (invariant 2) |

- **The code file** is `<SESSION_DIR>/logs/<scenario>-<what>.js` in a run, in every mode (CI may write only under `executions/`). A define-flow session has no SESSION_DIR: use `.playwright-cli/<session>-<what>.js`. The file never holds a secret.
- A run-code that timed out is classified like any timeout (`../experience/gotchas.md`) and is never re-run unchanged.
- Never across a secret fill (`fill-secret.md`), and never carrying a secret.

## Sessions
- `-s=<session>` selects a named session. Every command in every run carries it.
- Names are per-execution and unique: `init_run.js` generates them (label + time + random tag, collision-checked against existing executions; the label `default` is rejected).
- **Saved logins.** `state-load` / `state-save` move a saved login (`test/.auth/*-state.json`, a credential) into and out of a session. Run them only through `login_state.js` (`login-state.md`, browser-driver's Login mode), never by hand.

## Capacity
- Each session is a real Chromium, so the machine's CPU and RAM bound parallelism: plan for ~6–8 concurrent sessions.
- Nothing queues automatically. The orchestrator caps how many executors run at once (see test-execution's parallel procedure).

## Scratch dir
- The CLI auto-dumps raw snapshot and console files into a transient `.playwright-cli/` dir (there is no output-dir flag). Treat it as scratch: save structured evidence explicitly with `screenshot --filename=` and by redirecting `console` output, then clean `.playwright-cli/`.
