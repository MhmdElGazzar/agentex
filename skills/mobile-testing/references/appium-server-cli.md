# Tool: Appium server + raw WebDriver REST (via curl)

Driving a mobile session directly against a running Appium server, using `curl` — no extra
project dependency beyond `appium` itself. Read this before the first Appium action in a
session, or when a call behaves unexpectedly. See
[appium.io/docs](https://appium.io/docs/en/latest/) for the full upstream reference.

## Setup & preflight
- Install: `npm install -D appium` (local devDependency, invoked via `npx`).
- Install the platform driver(s) you need:
  - Android: `npx appium driver install uiautomator2`
  - iOS (macOS + Xcode only): `npx appium driver install xcuitest`
- Preflight: `npx appium --version`, `npx appium driver list --installed`.
- Android also needs `adb` on PATH (from the Android SDK platform-tools) and either a running
  emulator (`emulator -avd <name>`) or a connected device with USB debugging enabled — check
  with `adb devices`.
- iOS also needs a booted Simulator (`xcrun simctl list devices booted`) or a provisioned real
  device; iOS automation only runs on macOS.
- Start the server: `npx appium server` (defaults to `http://127.0.0.1:4723`). Appium 2.x
  serves the WebDriver protocol at the base path `/` (no `/wd/hub` prefix, unlike Appium 1.x).
  Run it in the background before driving any session; check it's up with
  `curl -s http://127.0.0.1:4723/status`.

## Capabilities
Every session is created with a JSON payload of **capabilities**. Per W3C, vendor-specific
capabilities are prefixed `appium:`. These map directly to the `mobile` block in
`environments/<env>.json` (see `docs/configuration.md`):

| `environments/<env>.json` field | W3C capability |
|---|---|
| `platformName` | `platformName` |
| `automationName` | `appium:automationName` |
| `app` | `appium:app` (path to `.apk`/`.ipa`, or an `http(s)://` URL) |
| `appPackage` / `appActivity` | `appium:appPackage` / `appium:appActivity` (Android, already installed) |
| `bundleId` | `appium:bundleId` (iOS, already installed) |
| `deviceName` | `appium:deviceName` |
| `platformVersion` | `appium:platformVersion` |
| `udid` | `appium:udid` (target one specific real device/simulator) |

Android example (`caps.json`):
```json
{ "capabilities": { "alwaysMatch": {
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:app": "/absolute/path/to/app.apk",
  "appium:deviceName": "emulator-5554"
} } }
```

iOS example:
```json
{ "capabilities": { "alwaysMatch": {
  "platformName": "iOS",
  "appium:automationName": "XCUITest",
  "appium:app": "/absolute/path/to/app.app",
  "appium:deviceName": "iPhone 15",
  "appium:platformVersion": "17.5"
} } }
```

## Session handling
Unlike `playwright-cli`'s named `-s=<session>` sessions, the Appium server has no server-side
session names — `POST /session` returns a `sessionId` in the response body, and **you must
capture and pass it in every subsequent call's URL** for that device session. Keep it in a
shell variable for the duration of the scenario run:
```bash
SID=$(curl -s -X POST http://127.0.0.1:4723/session -H 'Content-Type: application/json' -d @caps.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).value.sessionId')
```

## Core commands (W3C WebDriver REST)
All examples assume `$BASE=http://127.0.0.1:4723` and `$SID` holds the active session id.

- **Create session** — `POST $BASE/session` with the capabilities payload above. Response:
  `{"value":{"sessionId":"...", "capabilities": {...}}}`.
- **Find element** — `POST $BASE/session/$SID/element`
  `{"using":"accessibility id","value":"login-button"}`. Common `using` strategies: `accessibility id`
  (preferred — stable, cross-platform), `id` (Android resource-id), `-android uiautomator`
  (Android UiSelector expression), `-ios predicate string` / `-ios class chain` (iOS), `xpath`
  (slow, last resort). Response: `{"value":{"ELEMENT":"<id>"}}` (or `{"value":{"element-...":"<id>"}}`
  depending on server version — read whichever key is present).
- **Click / tap** — `POST $BASE/session/$SID/element/<elementId>/click`.
- **Type text** — `POST $BASE/session/$SID/element/<elementId>/value` `{"text":"hello"}`.
- **Get text** — `GET $BASE/session/$SID/element/<elementId>/text`.
- **Screenshot** — `GET $BASE/session/$SID/screenshot` → `{"value":"<base64 PNG>"}`. Decode and
  save, e.g.: `curl -s $BASE/session/$SID/screenshot | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));require("fs").writeFileSync(process.argv[1],Buffer.from(d.value,"base64"))' <out.png>`.
- **Page source** (accessibility tree, for locating elements) — `GET $BASE/session/$SID/source`.
- **Back** — `POST $BASE/session/$SID/back`.
- **Swipe** — no dedicated endpoint; use the W3C Actions API,
  `POST $BASE/session/$SID/actions` with a single pointer input performing move→down→move→up,
  e.g. a vertical swipe from (500,1500) to (500,500):
  ```json
  {"actions":[{"type":"pointer","id":"finger1","parameters":{"pointerType":"touch"},
    "actions":[
      {"type":"pointerMove","duration":0,"x":500,"y":1500},
      {"type":"pointerDown","button":0},
      {"type":"pointerMove","duration":300,"x":500,"y":500},
      {"type":"pointerUp","button":0}
    ]}]}
  ```
- **Close session** — `DELETE $BASE/session/$SID`. Always run this at the end of a scenario
  run, even on failure, so the device/emulator is free for the next session.

## Logs & defects
- Android: `adb logcat -d` (or filtered by package) for app crashes/errors; treat unexpected
  stack traces or ANRs as defects even if the screen looks fine.
- iOS: `xcrun simctl spawn booted log stream --level info` for simulator logs.
- The Appium server's own stdout/stderr is also useful evidence — redirect it to a log file
  under the run's `mobile-sessions/<session>/logs/` when starting the server for a session.

## Concurrency
Each session needs its own real emulator/device/simulator — there is no equivalent of
headless-browser cheapness. Confirm how many are actually provisioned
(`adb devices` / `xcrun simctl list devices booted`) before planning a parallel run; one
session per device, never two sessions sharing one device.
