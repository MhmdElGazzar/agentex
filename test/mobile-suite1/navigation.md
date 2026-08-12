# Spec: Primary navigation

App under test: (fill in — `.apk`/`.ipa` path or installed `appPackage`/`bundleId`, via the
`mobile` block in `environments/<env>.json`)
Type: navigation — read-only, stateful chain

## Acceptance criteria
- Each primary tab/menu item opens its expected screen (checked by a landmark element).
- Using the device back gesture/button from a secondary screen returns to the previous one
  without crashing or losing app state.

## Scenarios (stateful — run in order, in one session)
1. Launch the app; expect the home screen's landmark element to be visible.
2. Open each primary tab/menu item in turn; expect that screen's landmark element to become
   visible after each tap.
3. From the last tab opened, use back; expect a return to the previous screen (not a crash or
   blank screen).

## Notes
- Stateful: keep these steps in the same session, in the order above.
- Screenshot each step; flag any app crash, ANR, or unexpected error in the device log as a
  defect.
