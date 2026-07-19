# Risk, Priority, and Severity

Every exploration finding gets rated on two independent axes; **Priority** is derived from them.

## Severity — impact if it happens
Same scale `browser-testing` uses for defects, so ratings stay consistent end to end:
- **Critical** — blocks the core flow entirely, data loss/corruption, or a security exposure.
- **High** — a major feature is broken or badly degraded; no reasonable workaround.
- **Medium** — a real problem with a workaround, or a secondary feature affected.
- **Low** — cosmetic, wording, or a very minor inconsistency.

## Risk (likelihood) — how likely a real user hits this
- **Critical** — happens on the primary/default path almost every user takes.
- **High** — a common path, or an edge case reached by a sizeable fraction of users.
- **Medium** — a less-common path or input combination.
- **Low** — a rare or contrived path unlikely to occur naturally.

## Priority matrix (Severity × Risk → Priority)

| Severity \ Risk | Critical | High | Medium | Low |
|---|---|---|---|---|
| **Critical** | Critical | Critical | High | High |
| **High** | Critical | High | High | Medium |
| **Medium** | High | High | Medium | Medium |
| **Low** | Medium | Medium | Low | Low |

## Triage rule
- **Priority = Critical or High → design a test case for it this round** (DESIGN phase).
- **Priority = Medium or Low → keep it in the exploration log as backlog**, surfaced in the
  final REPORT for a possible future round — do not write a spec for it now.

When in doubt between two adjacent ratings, ask the user rather than rounding up or down
silently — triage decisions determine what gets built into the suite.
