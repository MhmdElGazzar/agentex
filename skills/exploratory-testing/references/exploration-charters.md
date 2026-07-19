# Exploration charters

A charter is a short mission for a slice of exploration — a goal plus guiding questions, not a
script. Run through the ones the user selected in SCOPE, one at a time, logging observations as
you go.

## Personas
Goal: see the app through different kinds of users.
- What can a first-time, unauthenticated visitor do or break?
- What can a returning/power user do faster or differently that a script wouldn't try?
- What would an admin/privileged view expose if reached without privilege (e.g. a direct URL)?
- What would a mildly adversarial user try (double-submit, tamper with a visible field, replay
  a request)?

## SFDPOT
Goal: sweep the app's dimensions systematically (Structure, Function, Data, Platform,
Operations, Time).
- **Structure** — is navigation, layout, and information architecture consistent and discoverable?
- **Function** — does every visible control do what its label promises?
- **Data** — what happens with empty, huge, duplicate, or oddly-formatted data?
- **Platform** — does behavior hold across viewport sizes / browser zoom?
- **Operations** — how is the app actually used in a realistic session (not just the happy path)?
- **Time** — what happens with slow networks, timeouts, or actions taken too fast/too slow?

## CRUD sweep
Goal: for each entity the app manages (e.g. cart item, account, address, comment), check
Create, Read, Update, Delete/Remove all work and stay consistent with each other afterward.

## Boundary / equivalence partitioning
Goal: for every input field, try the edges of its valid range and one value from each side —
empty, minimum, maximum, one-over-maximum, and a typical valid value.

## Error guessing
Goal: try the things a written spec wouldn't think to script.
- Submit a form twice quickly (double-click / double-submit).
- Use the browser back button mid-flow, then forward again.
- Refresh the page mid-flow (before/after a submit).
- Leave a required step incomplete and try to skip ahead via URL.

## Security-lite
Goal: non-invasive checks only — no real exploitation, no destructive actions.
- Does a script-like input (`<script>alert(1)</script>`) ever render unescaped?
- Can a logged-out session reach an authenticated page by direct URL?
- Do URLs/IDs look guessable in a way that suggests one user could see another's data (do not
  actually attempt access to another real account)?

## Accessibility-lite
Goal: quick, non-exhaustive accessibility sanity checks.
- Can the main flow be completed using keyboard only (Tab/Enter/Space)?
- Do images have alt text? Do inputs have associated labels?
- Is focus order logical, and is the currently-focused element visually obvious?

## Negative / destructive-lite
Goal: push on failure paths without causing real damage.
- Simulate a slow/offline network mid-action (devtools throttling) — does the UI fail gracefully?
- What does an empty state (no results, no items, no history) actually look like?
- Try resubmitting an action that already succeeded (e.g. re-click "Add to cart" many times).
