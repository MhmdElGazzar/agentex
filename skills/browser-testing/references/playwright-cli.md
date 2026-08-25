# Tool: playwright-cli

The browser driver for all QA browser actions. Read this before driving a browser, or
when a `playwright-cli` command behaves unexpectedly.

## Setup & preflight
- `playwright-cli` is provided by the npm package **@playwright/cli** (the bare
  `playwright-cli` package is **deprecated** — do NOT install it).
- Preflight before testing: `npx playwright-cli --version`.
  - If missing: `npm install -D @playwright/cli` then `npx playwright-cli install-browser chromium`.
- `preflight.js` also reports a **`playwright`** key — the npm **library**, which is a
  different thing from this CLI and is needed only by `/optimize-login` when it resumes a
  saved session (only the library can load a `storageState`). `ok: false` there does not
  block a normal run; if you do need it: `npm i -D playwright` then
  `npx playwright install chromium`.
- Invoke as `npx playwright-cli <command>` (local devDependency, not global).
- Headed (for demos / watching): add `--headed`, e.g. `npx playwright-cli open <url> --headed`.
  For parallel/regression sweeps run headless (omit `--headed`).

## Core usage
- Run `npx playwright-cli --help` if unsure of a command.
- Always `snapshot` to get element refs **before** interacting; refs change after every
  navigation, so **re-snapshot after each navigation**.
- `screenshot` on every PASSED and FAILED scenario.
  - IMPORTANT: pass the path via `--filename=<path>`, e.g.
    `npx playwright-cli -s=<session> screenshot --filename=<dir>/shot.png`.
    A **positional** path is misparsed as a CSS selector and fails.
- `console [error]` to read JS console messages (errors count as defects even if UI looks fine).
- For success/visibility checks, verify the element's **computed** display/visibility via
  `eval` — do not trust that text merely exists in the DOM (it may be static markup).

## Network capture (no `requests` subcommand)
- There is **no** `playwright-cli requests`. Capture network via `run-code` with a
  `page.on('request'/'response', …)` listener (or tracing).
- Pass `run-code` as a **single line** (no newlines — the shell mangles multi-line code).
  Example (one line):
  `npx playwright-cli -s=<s> run-code "async (page) => { const r=[]; page.on('request',q=>r.push(q.method()+' '+q.url())); await page.click('#x'); await page.waitForTimeout(1500); return JSON.stringify(r); }"`

## Driver error vs app defect
When a command fails, the first question is whether the app ever answered. Only the first list
earns the single retry the browser-testing **Flake doctrine** allows; the second list is a
defect, and retrying it buries a real bug.

**Infrastructure — the app never answered (retry once, from a clean state):**
- `net::ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_RESET` / `ERR_NAME_NOT_RESOLVED` /
  `ERR_PROXY_CONNECTION_FAILED` / `ERR_INTERNET_DISCONNECTED` — nothing was served.
- `Target page, context or browser has been closed`, a `browserType.launch` failure, or
  `Session closed` — the session died under the test.
- `Timeout <n>ms exceeded` on `open` with no page rendered at all.
- `npx playwright-cli` exiting non-zero with a driver or usage error rather than a test result,
  or `snapshot` returning no page.
- `Executable doesn't exist … install-browser chromium` — a missing browser binary is a
  preflight problem, not a defect. Fix it and start the run again; that is not a "retry".

**Defect — the app answered, and the answer was wrong (NEVER retried):**
- Element not found, `strict mode violation`, or a locator timing out on a page that DID
  render — the UI is not what the spec expects.
- Wrong text, wrong count, wrong state, or a "success" message that turns out to be static
  markup (check computed visibility via `eval`).
- Any 4xx/5xx served BY THE APP UNDER TEST, a 500 on submit included.
- JS console errors (`console error`) — a defect even when the UI looks fine.
- A step that fails intermittently on a page that renders every time: that is an intermittent
  DEFECT. The honest verdict is FLAKY, not a quiet second attempt.

A timeout is the one that needs a look before you decide: a timeout with no page is
infrastructure, a timeout waiting for an element on a page that rendered is a defect.

## Sessions
- `-s=<session>` selects a named browser session. **EVERY command in EVERY run — sequential
  and parallel — MUST carry its own `-s=<session>`.** A command with no `-s=` lands in the
  shared `default` session, where concurrent executions (e.g. another Claude Code window on
  the same machine) collide — the **`default` session is prohibited**.
- Session names are per-execution and unique: the browser-testing `init_run.js` generates
  them (label + time + random tag, collision-checked against existing executions; the label
  `default` is rejected). Never invent a bare name like `test` and never reuse another
  execution's name.
- `list` — list sessions · `close` — close one (`-s=<session> close`).
- **Teardown discipline: close ONLY the sessions this execution created.** `close-all` /
  `kill-all` are forbidden during any run — they kill every session on the machine, other
  executions' browsers included. Run them only when the user explicitly asks for a global
  cleanup AND confirms no other execution is running.
- `show` — open the playwright dashboard to watch sessions (works for headless too).

## Concurrency
- Effective parallelism is bound by the machine's CPU/RAM (each session is a real Chromium):
  plan for ~6–8 concurrent sessions; the harness queues the rest automatically.

## Scratch dir
- `playwright-cli` auto-dumps raw snapshot/console files into a transient `.playwright-cli/`
  dir (no output-dir flag). Treat it as scratch; save structured evidence explicitly via
  `screenshot --filename=` and by redirecting `console` output, then clean `.playwright-cli/`.

## Arabic / RTL
- `getByRole` locators with Arabic names work fine through `run-code` (UTF-8 passes through
  the shell). Prefer `run-code` + the documented locators for complex RTL flows.
