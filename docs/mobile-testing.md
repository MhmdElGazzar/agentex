# Mobile Testing

The native-app counterpart to [Browser Testing](./browser-testing.md): instead of clicking
through an Android/iOS app by hand, you describe what to test and Claude drives it for you
through a real [Appium](https://appium.io/docs/en/latest/) session — taking screenshots,
watching the device log, and reporting back what passed and what didn't. It never touches your
application's code — only test artifacts get written.

## Walkthrough: your first run (sequential)

You type something like:

> Test the login screen of our Android app — happy path plus wrong password and empty fields.

Here's what happens, step by step:

1. **Plan** — Claude restates what it understood (app, platform, device) and proposes a
   numbered list of scenarios. It stops here — nothing runs yet until you approve.
2. **Drive** — once you approve, Claude starts (or reuses) an Appium session against your
   configured device/emulator and runs each scenario one at a time, taking a screenshot
   whether it passes or fails, and watching the device log (`adb logcat` / simulator log) for
   crashes or unexpected errors — these count as defects even if the screen looks fine.
3. **Checkpoint** — after each scenario, Claude reports pass/fail with evidence and pauses
   before moving to the next one, so you can stop or redirect at any point.
4. **Report** — at the end, everything is written to a new `executions/execu_<timestamp>/`
   folder: a summary (`report.md`), an interactive dashboard (`extent-report.html`), and the
   screenshots/logs backing up every result.

## Walkthrough: a full regression (parallel)

For a bigger run — many spec files, no need to babysit each one — ask for it explicitly:

> Run a parallel regression against our Android app from the specs in `test/mobile-suite1/`.

This time Claude doesn't stop for approval at each step. It spins up one independent Appium
session **per spec file, per available device/emulator**, then merges every session's results
into one final report when they're all done.

**Mobile concurrency is bounded by real devices, not CPU/RAM** — unlike browser-testing's
cheap headless Chromium instances, each mobile session needs its own physical
device/emulator/simulator. Confirm how many are actually provisioned before asking for a
parallel run; often that's 1-2, not 6-8.

**One spec file = one device session** — so keep a flow that depends on earlier steps (like
login → action → assert) together in a single file rather than splitting it across files.

## Writing your own specs

A spec is a markdown file: the app under test, what "correct" looks like, and a numbered list
of scenarios, written in plain language — same shape as a browser-testing spec, adapted for a
native app (no URLs; elements are found by accessibility id / resource id rather than CSS
selectors):

```markdown
# Spec: Login validation

App under test: (path to .apk/.ipa, or installed appPackage/bundleId — see environments/<env>.json)
Type: login / validation — no real account is created

## Acceptance criteria
- A valid disposable test user reaches a visible logged-in state.
- Invalid input is rejected with a specific, visible error; the app must not proceed.

## Scenarios
1. **Happy path** — log in as a disposable test user; expect the home screen's landmark
   element to become visible.
2. **Wrong password** — expect a visible "invalid credentials" error, still on login.
3. **Empty fields** — expect an inline "required" error on each field.

## Notes
- Screenshot every scenario (pass and fail).
- Treat any app crash or unexpected device-log error as a defect even if the UI looks fine.
```

Start from the samples in [`test/mobile-suite1/`](../test/mobile-suite1/) — `/execute-mobile-test`
copies them into your project automatically on first run. To add more coverage, drop another
`.md` file next to them; in parallel mode each becomes its own device session.

## Configuring a target app/device

Mobile targets live in the `mobile` block of `environments/<env>.json` (alongside the existing
`portalUrl`/`db`/`api` blocks used by browser testing) — see
[Configuration](./configuration.md#environmentsenvjson):

```json
"mobile": {
  "platformName": "Android",
  "automationName": "UiAutomator2",
  "app": "/absolute/path/to/app.apk",
  "deviceName": "emulator-5554"
}
```

There's no legacy `.env`-only fallback for mobile targets (unlike `QA_TARGET_URL` for
browser testing) — an environment file with no `mobile` block means Claude asks you for the
app path and device capabilities rather than guessing.

## Quick reference

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Sequential** (default) | A natural-language request or `/execute-mobile-test <scope>` | Human-in-the-loop. Claude pauses for your approval at each checkpoint. Best for exploratory / first-run testing. |
| **Parallel** (autonomous) | "Run a parallel regression … from the specs in `test/mobile-suite1/`" | Spawns one `mobile-qa-executor` subagent per spec file, each on its own device/emulator, then merges their defect lists into one report. Best for regression suites — bounded by how many devices you actually have. |

**Output layout:**
```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── extent-report.html                 # interactive dashboard (see extent-report skill)
├── mobile-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md,screenshots/}
```

**Setup:**
```bash
npm install -D appium
npx appium driver install uiautomator2   # Android
npx appium driver install xcuitest       # iOS (macOS + Xcode only)
```
Optionally, for the bundled wrapper script instead of raw `curl`:
```bash
npm install -D webdriverio
```
Copy the `permissions` block from [`settings.example.json`](../settings.example.json) into your
project's `.claude/settings.json` to pre-approve `appium` and the read-only `adb`/`xcrun`
commands, and to prompt (rather than block) before destructive device actions like uninstall
or reboot.

**Driving a session — two options:**
- Raw WebDriver REST via `curl` against the running Appium server — no extra dependency.
- The bundled `appium_client.js` wrapper (needs `webdriverio`) — simpler flag-driven commands.

Pick whichever fits your project; both are documented in the skill's `references/` folder.

**Reference:**
- Skill: `skills/mobile-testing/SKILL.md`
- Subagent: `agents/mobile-qa-executor.md`
- Driver notes: `skills/mobile-testing/references/appium-server-cli.md` and
  `references/appium-client-wrapper.md`
- HTML dashboard: see [extent-report](./extent-report.md)
