# Tool: playwright-cli

The browser driver for all QA browser actions. Read this before driving a browser, or
when a `playwright-cli` command behaves unexpectedly.

## Setup & preflight
- `playwright-cli` is provided by the npm package **@playwright/cli** (the bare
  `playwright-cli` package is **deprecated** — do NOT install it).
- Preflight before testing: `npx playwright-cli --version`.
  - If missing: `npm install -D @playwright/cli` then `npx playwright-cli install-browser chromium`.
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

## Sessions
- `-s=<session>` selects a named browser session. **Parallel runs MUST each use their own
  `-s=<session>`** so browsers don't collide; sequential runs may use the default session.
- `list` — list sessions · `close` — close one (`-s=<session> close`) · `close-all` /
  `kill-all` — close/kill all (kill for stale/zombie processes).
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
