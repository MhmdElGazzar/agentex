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

## Storage / auth state
- **Reusing a login across runs → `open --persistent --profile <dir>`.** A real on-disk
  Chromium user-data dir: log a user in once into the profile, and every later `open` with the
  same `--profile` starts already authenticated. This is the reliable mechanism for apps that
  keep their auth token in **localStorage** (SPA / Capacitor / JWT-in-localStorage), and it is
  driven by the same `playwright-cli` as the test. Caveat: one profile dir can't be opened by
  two browsers at once (dir lock) — for concurrent same-user sessions, copy the authed profile
  per session. This is how `session` login mode works (see browser-testing SKILL.md "Session
  reuse").
- **Do NOT rely on `state-load` for a localStorage-based login.** `state-save [file]` /
  `state-load <file>` round-trip a Playwright `storageState` JSON, but Playwright can only seed
  localStorage at context *creation* — the CLI's post-hoc `state-load` restores cookies while
  localStorage is wiped on the next `goto` (field-verified on a Capacitor/Angular app whose
  token lives in `localStorage`: it redirected to `/login` after `state-load` + navigate).
  `state-load` is fine for cookie-only sessions; and the `storageState` JSON that `state-save`
  produces still feeds a compiled `.spec.ts` `storageState:` option unchanged (that path DOES
  seed localStorage, at newContext).
- Granular access if you need it: `cookie-*`, `localstorage-*`, `sessionstorage-*`.
- The cleanest future fix for portable-JSON reuse in the CLI would be an open-time
  `--storage-state <file>` flag (seed at newContext) — not available in the CLI today.

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
