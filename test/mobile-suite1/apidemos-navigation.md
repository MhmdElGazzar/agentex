# Spec: API Demos category navigation

App under test: `io.appium.android.apis` (ApiDemos-debug.apk — the official Appium sample app,
downloadable from the Appium project; a good target for a first smoke run)
Type: navigation — read-only, stateful chain

## Acceptance criteria
- The home screen lists the API Demos categories (Accessibility, Animation, App, Content,
  Graphics, Media, NFC, OS, Preference, Text, Views).
- Tapping a category opens its list screen.
- Using back from a category screen returns to the home category list without crashing.

## Scenarios (stateful — run in order, in one session)
1. Launch the app; expect the home screen listing all categories, including "Views".
2. Tap "Views"; expect a new screen (not the home category list) to open.
3. Use back; expect the home category list to return, "Graphics" visible again.
4. Tap "Graphics"; expect a new screen (not the home category list) to open.
5. Use back; expect the home category list to return.

## Notes
- Screenshot every scenario (pass and fail).
- Treat any crash/ANR in the device log as a defect even if the UI looks fine.
