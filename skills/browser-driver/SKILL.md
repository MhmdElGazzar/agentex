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
- **Secret fields.** Type every `{ "envSecret": "NAME" }` value (password, OTP, national ID, any field) ONLY with `node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/fill_secret.js --session <s> --target <ref> --env-var NAME [--env <env>] --submit` (read `references/tools/fill-secret.md` first). Never resolve, read, echo, or pass the value yourself, and never try another way (`fill`, `type`, `run-code`, `$NAME`): a refused command is not a puzzle to solve. Snapshot BEFORE filling and fill secrets last. A snapshot shows input values in clear text, passwords included, and every playwright-cli action writes one to `.playwright-cli/`, so run no other playwright-cli command between the first secret fill and the submit: submit in the last call with `--submit` (Enter) or `--submit-target <pre-fill ref>`, which then clears every secret field still holding its value. Segmented boxes (OTP digits): one call, one `--target` per box, in order. If the submitting call never ran, take no `snapshot`, `eval` or `screenshot` of that page ("evidence withheld: secret field still filled"). `secret-unavailable` → the scenario is BLOCKED, never FAIL, never `captcha-or-otp`.

## Executing a browser step
1. Before the first command in a session, read `references/tools/playwright-cli.md`.
2. `snapshot` to get element refs before interacting. Refs change on navigation: re-snapshot after each page load.
3. Act, then verify with the techniques in `references/techniques/browser-checks.md`.
4. Save evidence under `SESSION_DIR`: screenshots in `screenshots/<scenario>.png`, console and network captures in `logs/<scenario>.log`.
5. When a command fails or behaves unexpectedly, read `references/experience/gotchas.md` before deciding retry versus defect.

## Login mode
The orchestrator resolves `LOGIN_MODE`. When a scenario needs user U signed in, go in this order:
| Mode | Do |
|---|---|
| `fresh` | Drive the login UI in this session (step 2 below). |
| `session`, the login itself under test (a negative login, login-form checks) | Start clean: `npx playwright-cli -s=<session> cookie-clear`, then `npx playwright-cli -s=<session> localstorage-clear`, then reload the login page (`npx playwright-cli -s=<session> reload`, or open the login URL again), because the form on screen just lost its own cookie. Only then drive the login UI (step 2). Never fill the form on the stale page. Never load or save a saved login here: a reused session would pass the scenario without testing the login. |
| `session`, any other scenario | Load the saved login (step 1). |

1. **Load.** Read `references/tools/login-state.md`, then run
   `node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/login_state.js load --session <session> --user <U> --env <ENVIRONMENT>`
   (leave out `--env` when ENVIRONMENT is empty). It loads the saved login into this session, opens the saved page and checks the saved landmark.
   - Exit 0 `RESUME_PASS`: you are signed in from the saved login. Continue with the steps.
   - Exit 1 `RESUME_FAIL` (with its reason): drive the login UI (step 2). For `landmark-failed` the script cleared the cookies and localStorage and then reloaded the page itself, so go on to the login UI on that reloaded page with no reload of your own. For any other reason (`no-state`, `no-landmark`, `cli-unsupported`, `state-unreadable`, `no-environment`) nothing was cleared.
   - Exit 2 `BLOCKED`: the scenario is BLOCKED with the script's reason verbatim. A result marked `infrastructure: true` gets the one retry the driver contract allows.
2. **Drive the login UI** in this session. A captcha, or an OTP you cannot obtain, is BLOCKED `captcha-or-otp`: surface it, never defeat it (the **optimize-login** skill's Limits). Then verify you are in by a landmark element, never by the URL. No landmark: the login step fails, FAIL or BLOCKED by the usual rules, with its evidence kept. Landmark held: in `fresh` mode, or when the login is under test, continue with the steps.
3. **Save** (`session` mode, login not under test), only after the landmark proved you in. `<landmark>` is the selector of an element only a signed-in user sees:
   `node ${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/scripts/login_state.js save --session <session> --user <U> --present <landmark> --env <ENVIRONMENT>`
   (leave out `--env` when ENVIRONMENT is empty). It checks the landmark on the current page again before it stores anything.
   - Exit 0 (`SAVED` or `SKIPPED`): continue with the steps.
   - Exit 1 or 2: add one report note, "saved login not stored: <reason>", and continue with the steps. A save that fails never changes a verdict.

Saved logins are credentials (`test/.auth/*-state.json` and their sidecars):
- Never open, print, copy or edit one. Never run `state-load` or `state-save` yourself, and never put a cookie or storage value on a command line: only `login_state.js` moves a saved login.
- Never claim RESUME_PASS without the script's exit 0.

## Output
Per browser step, hand back: the screenshot path, console and network notes, and observed vs. expected.

## Resources
| File | Knowledge | Read when |
|---|---|---|
| `references/tools/playwright-cli.md` | Tool | Before the first command in a session |
| `references/tools/fill-secret.md` | Tool | Before the first `{ "envSecret" }` field |
| `references/tools/login-state.md` | Tool | Before the first `login_state.js` call (`session` mode) |
| `references/techniques/browser-checks.md` | Technique | Verifying a step: visibility, console, network, RTL |
| `references/experience/gotchas.md` | Experience | A command fails or behaves unexpectedly |
