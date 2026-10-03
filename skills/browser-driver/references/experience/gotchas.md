# Experience: known traps and failure signatures

## Known traps
| Trap | What happens | Do this |
|---|---|---|
| Windows + current Node: the CLI prints its version, then dies on its own exit path with a libuv assertion (`UV_HANDLE_CLOSING`) | The exit code says broken; the tool works | Trust `preflight.js`: it reports `ok: true` with the note "version confirmed; known benign exit-crash on this stack". Do NOT re-run `npx playwright-cli --version` yourself, see the non-zero exit or the assertion text, and re-conclude "broken". Proceed with the run. |
| `screenshot shot.png` (positional path) | Parsed as a CSS selector, and fails | Always `--filename=<path>` |
| `playwright-cli requests` | The subcommand does not exist | A `run-code` listener (see techniques) |
| Multi-line `run-code` | The shell mangles it | One line only |
| The bare `playwright-cli` npm package | Deprecated | Install `@playwright/cli` |
| A "success" message found in the DOM | May be static markup | Check computed visibility via `eval` |
| `Executable doesn't exist … install-browser chromium` | A missing browser binary | A preflight problem, not a defect. Fix it and start the run again. That is not a "retry". |

## Driver error vs app defect
When a command fails, the first question is whether the app ever answered. Only the first list earns the single retry the test-execution Flake rules allow. The second list is a defect, and retrying it buries a real bug.

**Infrastructure: the app never answered (retry once, from a clean state)**
- `net::ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_RESET` / `ERR_NAME_NOT_RESOLVED` / `ERR_PROXY_CONNECTION_FAILED` / `ERR_INTERNET_DISCONNECTED`: nothing was served.
- `Target page, context or browser has been closed`, a `browserType.launch` failure, or `Session closed`: the session died under the test.
- `Timeout <n>ms exceeded` on `open` with no page rendered at all.
- `npx playwright-cli` exiting non-zero with a driver or usage error rather than a test result, or `snapshot` returning no page.

**Defect: the app answered, and the answer was wrong (never retried)**
- Element not found, `strict mode violation`, or a locator timing out on a page that DID render: the UI is not what the spec expects.
- Wrong text, wrong count, wrong state, or a "success" message that turns out to be static markup.
- Any 4xx/5xx served by the app under test, a 500 on submit included.
- JS console errors (`console error`): a defect even when the UI looks fine.
- A step that fails intermittently on a page that renders every time: an intermittent DEFECT. The honest verdict is FLAKY, not a quiet second attempt.

**The ambiguous one: a timeout.** A timeout with no page is infrastructure. A timeout waiting for an element on a page that rendered is a defect.
