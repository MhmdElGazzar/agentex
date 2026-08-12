# Tool: appium_client.js — mechanics

An optional alternative to driving the Appium server with raw `curl` (see
`appium-server-cli.md`): a small bundled wrapper around
[`webdriverio`](https://webdriver.io/)'s WebDriver client, exposing simple flag-driven
subcommands. Prints **one JSON line** per call — `{"result":"PASS|FAIL|BLOCKED", ...}` — and
exits 0/1/2. Use whichever driver mechanism the project already has set up; prefer this one
once `webdriverio` is already a project dependency, since it saves hand-writing REST calls for
find/tap/type/screenshot.

## Requirement
The project (not the plugin) needs `webdriverio` installed:
```bash
npm install -D webdriverio
```
The script resolves `webdriverio` from the **current working directory** at run time (the
plugin itself ships no npm dependencies). If it isn't installed, every subcommand prints
`{"result":"BLOCKED","reason":"webdriverio not found — run: npm install -D webdriverio"}`
and exits 2 — install it and retry, never work around it another way.

An Appium server must already be running (`npx appium server`, default
`http://127.0.0.1:4723`) — this script is a client, not a server launcher.

## Usage
```
node ${CLAUDE_PLUGIN_ROOT}/skills/mobile-testing/scripts/appium_client.js <subcommand> [flags]
```

| Subcommand | Flags | Result payload (on PASS) |
|---|---|---|
| `create-session` | `--caps-file <path.json>` `[--server <url>]` | `{"sessionId":"..."}` |
| `find` | `--session <id>` `--using <strategy>` `--value <selector>` `[--server <url>]` | `{"element":"<elementId>"}` |
| `click` | `--session <id>` `--element <elementId>` | `{}` |
| `send-keys` | `--session <id>` `--element <elementId>` `--text <text>` | `{}` |
| `get-text` | `--session <id>` `--element <elementId>` | `{"text":"..."}` |
| `screenshot` | `--session <id>` `--out <path.png>` | `{"path":"<path.png>"}` |
| `swipe` | `--session <id>` `--from <x>,<y>` `--to <x>,<y>` | `{}` |
| `back` | `--session <id>` | `{}` |
| `source` | `--session <id>` | `{"source":"<xml>"}` |
| `close-session` | `--session <id>` | `{}` |

- `--using` strategies: `accessibility id` (preferred), `id`, `-android uiautomator`,
  `-ios predicate string`, `-ios class chain`, `xpath`.
- `--server` defaults to `http://127.0.0.1:4723`; only needed if the server runs elsewhere.
- `create-session`'s `--caps-file` takes a W3C capabilities JSON file — see
  `templates/sample-android-caps.json` / `templates/sample-ios-caps.json` in this skill, or
  build one from the `mobile` block in `environments/<env>.json` per
  `appium-server-cli.md`'s capability table.

## Result shapes
- `PASS` (exit 0) — `{"result":"PASS", ...subcommand-specific fields above}`.
- `FAIL` (exit 1) — the Appium/WebDriver call itself failed (element not found, session
  invalid, request error): `{"result":"FAIL","reason":"..."}`.
- `BLOCKED` (exit 2) — a required flag is missing, `webdriverio` isn't resolvable, or the
  caps file doesn't exist/parse: `{"result":"BLOCKED","reason":"..."}`.

## Session handling
Same as the raw REST approach: `create-session` returns a `sessionId` — capture it and pass it
via `--session` to every subsequent call for that device session. Always call `close-session`
at the end of a scenario run, even on failure, so the device/emulator is released.

## Example flow
```bash
node appium_client.js create-session --caps-file caps.json
# -> {"result":"PASS","sessionId":"abc123"}
node appium_client.js find --session abc123 --using "accessibility id" --value login-button
# -> {"result":"PASS","element":"elem-1"}
node appium_client.js click --session abc123 --element elem-1
node appium_client.js screenshot --session abc123 --out s1-login.png
node appium_client.js close-session --session abc123
```
