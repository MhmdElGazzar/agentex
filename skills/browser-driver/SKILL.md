---
name: browser-driver
description: The browser driver for test-execution runs. It drives a real browser through playwright-cli for unprefixed (prose) spec steps and covers isolated sessions, screenshot and console evidence, login modes, and the failure signatures that decide retry versus defect. Use when a test-execution run's drivers include browser, before the first browser action; the test-execution orchestrator and qa-executor read it. Not a standalone entry point.
user-invocable: false
---

# Browser Driver

## Role
You execute browser steps for a test-execution run through `playwright-cli` (via Bash), inside
the run's own session. You never modify application code. The run itself (modes, verdicts,
reports) belongs to the **test-execution** skill.

## Principles
- Every command carries `-s=<session>`, with the name `init_run.js` generated for this run. The `default` session is prohibited: a bare command lands there and collides with other executions (another Claude Code window on the same machine).
- Never invent a bare session name like `test`, and never reuse another execution's name.
- Close only the session this run created: `-s=<session> close`, even on failure. Never run `close-all` / `kill-all`: they kill every session on the machine. The one exception is a global cleanup the user explicitly asks for, after confirming no other execution is running.
- Console errors and failed network calls are defects, even when the UI looks fine.
- Screenshot every scenario, pass and fail, with `--filename=` (never a positional path).
- A "success" check reads the element's computed display/visibility. Text existing in the DOM is not proof.
- Run headless unless told otherwise. `--headed` is for demos only.

## Executing a browser step
1. Before the first command in a session, read `references/tools/playwright-cli.md`.
2. `snapshot` to get element refs before interacting. Refs change on navigation: re-snapshot after each page load.
3. Act, then verify with the techniques in `references/techniques/browser-checks.md`.
4. Save evidence under `SESSION_DIR`: screenshots in `screenshots/<scenario>.png`, console and network captures in `logs/<scenario>.log`.
5. When a command fails or behaves unexpectedly, read `references/experience/gotchas.md` before deciding retry versus defect.

## Login mode
The orchestrator resolves `LOGIN_MODE`. For a browser it means:
| Mode | Do |
|---|---|
| `fresh` | Drive the login UI in this session. |
| `session` | Reuse the saved login first: read `${CLAUDE_PLUGIN_ROOT}/skills/optimize-login/SKILL.md` and resume `test/.auth/<app>-<ENVIRONMENT>-state.json` via its `session.js`. Log in through the UI only if the resume reports RESUME_FAIL. |

Either way, verify you are in by a landmark element, never by the URL.

## Output
Per browser step, hand back: the screenshot path, console and network notes, and observed vs. expected.

## Resources
| File | Knowledge | Read when |
|---|---|---|
| `references/tools/playwright-cli.md` | Tool | Before the first command in a session |
| `references/techniques/browser-checks.md` | Technique | Verifying a step: visibility, console, network, RTL |
| `references/experience/gotchas.md` | Experience | A command fails or behaves unexpectedly |
