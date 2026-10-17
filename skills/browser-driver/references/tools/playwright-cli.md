# Tool: playwright-cli

The browser driver for all browser actions in a test-execution run.

## Setup
- The CLI is the npm package **`@playwright/cli`**. Invoke it as `npx playwright-cli <command>` (a local devDependency, not global).
- Trust the `preflight.js` verdict for it: the probe judges by output, not exit code alone (see `../experience/gotchas.md`). If it reports `ok: false`: `npm install -D @playwright/cli`, then `npx playwright-cli install-browser chromium`.
- `preflight.js` also reports **`playwright`**: the npm library, a different thing from this CLI. Only `/optimize-login` needs it, to resume a saved session (only the library can load a `storageState`). `ok: false` there does not block a normal run. To install it: `npm i -D playwright`, then `npx playwright install chromium`.
- Claude direct CLI workflow: for an explicitly requested headed run, use `npx playwright-cli -s=<session> open <url> --headed` with the assigned session name. Claude runs headless by default.
- For explicitly requested headed mode, the Codex host preflight adds `--headed` to `open about:blank`, then verifies the owned session with `list --json`. Subsequent Codex actions use `host.js browser`, which checks live metadata and the original launch PID before and after each action. Otherwise runs default to headless.

## Commands
| Command | Use |
|---|---|
| `open <url>` | Open the target in this session |
| `snapshot` | Get element refs (re-run after every navigation) |
| `screenshot --filename=<path>` | Save evidence |
| `console [error]` | Read JS console messages |
| `eval "<expr>"` | Read computed state |
| `run-code "<one line>"` | Run Playwright code: network listeners, viewport, complex locators |
| `list` / `close` / `show` | List sessions / close one (`-s=<session> close`) / open the dashboard (works headless too) |
| `--help` | When unsure of a command |

## Sessions
- `-s=<session>` selects a named session. Every command in every run carries it.
- Names are per-execution and unique: `init_run.js` generates them (label + time + random tag, collision-checked against existing executions; the label `default` is rejected).

## Capacity
- Each session is a real Chromium, so the machine's CPU and RAM bound parallelism: plan for ~6–8 concurrent sessions.
- Nothing queues automatically. The orchestrator caps how many executors run at once (see test-execution's parallel procedure).

## Scratch dir
- The CLI auto-dumps raw snapshot and console files into a transient `.playwright-cli/` dir (there is no output-dir flag). Treat it as scratch: save structured evidence explicitly with `screenshot --filename=` and by redirecting `console` output, then clean `.playwright-cli/`.
