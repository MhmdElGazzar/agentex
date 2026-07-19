# Exploration log

One row per observation — not just bugs. Keep this table as the running record through EXPLORE,
then carry it into TRIAGE unchanged (only the Priority column decides what moves on to DESIGN).
No screenshots or logs at this stage — this is a fast survey pass; evidence gets captured later,
in EXECUTE, once a finding has actually become a test case.

| # | Charter | Observation | Risk | Severity | Priority | Notes |
|---|---------|-------------|------|----------|----------|-------|
| 1 | Error guessing | Double-clicking "Place order" creates two orders | High | High | High | Reproduced 3/3 times |
| 2 | Accessibility-lite | Search input has no associated `<label>` | High | Low | Medium | Screen reader announces "edit text" only |
| 3 | Boundary | Quantity field accepts `-1` and reduces cart total | Medium | High | High | Price goes negative |

Columns:
- **Risk** — likelihood a real user hits this path (Critical/High/Medium/Low).
- **Severity** — impact if it happens (Critical/High/Medium/Low).
- **Priority** — looked up from the Severity × Risk matrix in
  `references/risk-priority-severity.md`.
- **Notes** — anything needed to design a good test case later (repro rate, exact input used,
  where it happened) — detailed enough to reproduce it later during EXECUTE without a
  screenshot to fall back on.
