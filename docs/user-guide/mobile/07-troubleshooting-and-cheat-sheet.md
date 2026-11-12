# 7. If something breaks + cheat sheet

← [6. Run at scale](./06-run-at-scale.md) · [Your path](./README.md)

| You see | Do this |
|---------|---------|
| `adb devices` is empty / `unauthorized` | Start the emulator, or reconnect the phone and accept "Allow USB debugging". |
| The session won't start | Is the server up (`curl -s http://127.0.0.1:4723/status`)? Is the driver installed (`npx appium driver list --installed`)? Does `deviceName` match? |
| Claude asks for the app and device | The environment has no `mobile` block. Add one ([Point it at your app](./03-point-it-at-your-app.md)). |
| BLOCKED: reset requested / user not defined | Remove `fullReset` from the capabilities / add the user under `users`. |
| The spec is BLOCKED in `/execute-test` or CI | Expected. Mobile specs run only with `/execute-mobile-test`. |
| Parallel sessions collide · iOS fails on Windows | Give each session its own `udid` · iOS needs macOS + Xcode. |

## Cheat sheet

```
# setup
/plugin install agentex@elgazzar-plugins  ·  /init-test
npm install -D appium  ·  npx appium driver install uiautomator2

# check
npx --no-install appium --version  ·  adb devices  ·  xcrun simctl list devices booted

# environments/qc.json
"mobile": { "platformName": "Android", "automationName": "UiAutomator2",
            "app": "/abs/path/app.apk", "deviceName": "emulator-5554" }

# run
/execute-mobile-test suite1          /execute-mobile-test suite1 on uat
Run a parallel regression against our Android app from the specs in test/mobile-suite1/.

# results
executions/execu_<timestamp>/report.md  ·  bugs/bug-list.md
```

Full details: [chapter 9 of the AgenTeX User Guide](../agentex/09-mobile-testing.md) and
[docs/mobile-testing.md](../../mobile-testing.md).
