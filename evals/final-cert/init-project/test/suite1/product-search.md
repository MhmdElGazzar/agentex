# Spec: Product search

Target: https://example.com   <!-- edit to your app -->
Type: search / results — read-only, stateful chain

## Acceptance criteria
- A common query returns relevant, non-empty results.
- A nonsense query shows a graceful "no results" state (not a crash or blank page).
- Clearing the query restores the default listing.

## Scenarios  (stateful — run in order, in one session)
1. Search a common term (e.g. `shirt`); expect at least one result rendered.
2. Search a nonsense term (e.g. `zzzxqq`); expect a visible "no results" message.
3. Clear the search box; expect the default/full listing to return.

## Notes
- Stateful: keep these three steps in the same browser session, in the order above.
- Screenshot each step; flag any console/network errors as defects.
