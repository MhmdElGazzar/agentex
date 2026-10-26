# Tool: login_state.js — mechanics

The only way a run loads or saves a saved login (`login.mode: "session"`). It moves the login file
through the driver's own `state-load` / `state-save` in the run's playwright-cli session, and checks
a signed-in landmark in the page. It never reads the file, never prints a cookie or storage value, and
never puts one on a command line: its output is paths and result words. Do not run `state-load` or
`state-save` yourself, and never open, print, copy or edit a `*-state.json` or its `*-state.meta.json`.
Prints **one JSON line** and exits 0, 1 or 2. It never issues a verdict.

## Usage
```
node <agentex-root>/skills/browser-driver/scripts/login_state.js load \
  --session <s> --user <U> [--env <env>] [--url <url> --present <selector>] [--timeout-ms <n>]
node <agentex-root>/skills/browser-driver/scripts/login_state.js save \
  --session <s> --user <U> --present <selector> [--env <env>] [--timeout-ms <n>]
```
Run it from the consumer project root, like every other command of the run.

| Flag | Meaning |
|---|---|
| `--session` | The run's session name (the same `-s=` value). Required. `default` is refused. |
| `--user` | A key of `users` in `environments/<env>.json`. Required. |
| `--env` | The run's ENVIRONMENT. Default: `defaultEnvironment`. |
| `--present` | The landmark: a selector true only when signed in (an account menu), never a URL. Required by `save`; `load` reads it from the sidecar. |
| `--url` | `load` only: the page to open and check, used with `--present` when no sidecar exists. |
| `--timeout-ms` | Watchdog for each playwright-cli call. Default 30000. |

## Files
- `test/.auth/<env>-<user>-state.json`: the saved login (mode 0600, gitignored).
- `test/.auth/<env>-<user>-state.meta.json`: the sidecar `{ schemaVersion: 1, url, landmark, savedAt }`.
  `url` is origin + path only (no query, no fragment). `load` checks the landmark `save` proved.
- A user handle outside `[A-Za-z0-9_.-]{1,64}` is named `u-<8 hex>` in both files.

## `load`
Order: usage; the user must exist in the environment; no environment, no file or no landmark ends
here without a browser call; then `state-load`, `goto` the sidecar URL, and poll the landmark for 15 s.
It never writes or deletes the file.

| Result | Exit | Meaning and what to do |
|---|---|---|
| `RESUME_PASS` | 0 | Signed in from the saved login. Continue the steps. |
| `RESUME_FAIL` `no-environment` / `no-state` / `no-landmark` | 1 | Nothing usable saved. Log in through the UI. |
| `RESUME_FAIL` `cli-unsupported` | 1 | The CLI is older than 0.0.63 (no `state-load`). Log in through the UI. |
| `RESUME_FAIL` `state-unreadable` | 1 | The driver could not read the file. Log in through the UI. |
| `RESUME_FAIL` `landmark-failed` | 1 | The saved login is expired or invalid. Cookies and localStorage were cleared, then the page is reloaded (so a form's CSRF cookie and token match again; if the reload fails, `detail` says so, reload before the form login); log in through the UI. The old file stays until the next save replaces it. |
| `BLOCKED` `session-not-open` / `driver-error` + `infrastructure: true` | 2 | The session is gone or the CLI hung. Scenario BLOCKED; one retry per the driver's infrastructure rule. |
| `BLOCKED` `usage` / `unknown-user` | 2 | A wrong flag, or a user not in the environment. Scenario BLOCKED, reason verbatim. |

## `save`
Call it only after a UI login proven by a landmark, in session mode, when the login is not the thing
under test. Order: usage; the user must exist; `AGENTEX_CI=1` or no environment is SKIPPED; `test/.auth/`
must be gitignored; the landmark must hold on the current page; `state-save` to a temp file in
`test/.auth/`, chmod 0600, atomic rename; then the sidecar.

| Result | Exit | Meaning and what to do |
|---|---|---|
| `SAVED` | 0 | The login and its sidecar are stored. |
| `SKIPPED` `ci-mode` / `no-environment` | 0 | Nothing written (CI never saves; a legacy project has no saved login). |
| `NOT_AUTHENTICATED` | 1 | The landmark does not hold on the current page. Nothing written. |
| `BLOCKED` `not-ignored` | 2 | `test/.auth/` is not in `.gitignore`. Nothing written; tell the tester to run `/update-agentex`. |
| `BLOCKED` `cli-unsupported` / `session-not-open` / `driver-error` / `usage` / `unknown-user` | 2 | Nothing written. |

A failed save never changes a verdict: add one report note, "saved login not stored: <reason>", and
go on.

Every result line carries `result`, a `reason` where one applies, a `detail` sentence, and the paths;
the driver's own output is never relayed.
