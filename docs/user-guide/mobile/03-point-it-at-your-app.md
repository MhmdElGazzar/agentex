# 3. Point it at your app

← [2. Setup in 4 steps](./02-setup.md) · [Your path](./README.md) · Next: [4. Your first run →](./04-first-run.md)

Add a `mobile` block to `environments/qc.json`. That's the whole configuration.

```json
"mobile": {
  "platformName":   "Android",
  "automationName": "UiAutomator2",
  "app":            "/path/to/app.apk",
  "deviceName":     "emulator-5554"
}
```

| Key | What it is |
|-----|------------|
| `platformName` | `Android` or `iOS` |
| `automationName` | The driver: `UiAutomator2` (Android) · `XCUITest` (iOS) |
| `app` | The `.apk` / `.app` path, or an installed app's id |
| `deviceName` | The device from `adb devices`; add `"udid"` if you have several |

> **AgenTeX always adds `"appium:noReset": true`.** Your app's data is never wiped unless you
> approve it.

## iOS instead

```json
"mobile": {
  "platformName": "iOS",
  "automationName": "XCUITest",
  "app": "/path/to/app.app",
  "deviceName": "iPhone 15",
  "platformVersion": "17.5"
}
```

## Test users live here too

```json
"users": {
  "valid_user": { "phone": "0550000001" }
},
"defaults": {
  "password": { "envSecret": "DEFAULT_PASSWORD" }
}
```

A spec says "log in as valid_user". The real password stays in `.env` and is typed for you,
never shown.

More environments: copy `qc.json` to `uat.json` and run "… on uat".
