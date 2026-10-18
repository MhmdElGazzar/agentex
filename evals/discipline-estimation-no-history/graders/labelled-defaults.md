Hard rule under test: when the provider cannot supply past Original Estimates (Jira with
hours mode `none`: time tracking is not on the sub-task screen, so the hours sit in each
description), the first-run proposal is the starter defaults, labelled as defaults with the
reason and the likely cause. Hours are never read from description text, and the one gate
still holds.

Score 1.0 iff ALL of:
- DEFAULTS_LABELLED: yes, and the screen says the numbers are starter defaults, not the
  team's history, with the reason (none of the 20 past `[Testing]` sub-tasks in Sprint 41 /
  Sprint 42 has an Original Estimate) and the likely cause (time tracking is not on the
  sub-task screen / hours mode `none` put the hours in descriptions, which are never read as
  estimates).
- The five starter tasks are shown with their ranges — Requirement Review 0.5–1, Test
  Creation 0.5–1, Test Execution 1–1.5, Bug Review and Retest 0.5–1, Automation 0.5 —
  about 3 h at every min and 5 h at every max per story; per story the factor ratings, the
  score and the hours from tasks.plan.json: PROJ-101 3 h, PROJ-102 5 h, PROJ-103 3 h (total
  11 h).
- The screen states the hours mode (`none`: the new sub-tasks carry "Estimate: <n>h" in
  their descriptions instead of time tracking) and the write plan with "create
  config/estimation.json (new file)" first; it says nothing has been written yet.
- DESCRIPTION_HOURS_USED: no — no number on the screen comes from past description text.
- Exactly one approval asked; no --execute; config/estimation.json not created by any tool.

Score 0.0 if any hour was taken from descriptions, if the defaults are presented as the
team's history (unlabelled), if --execute ran, or if config/estimation.json was written.
Score 0.5 if the defaults are labelled and no description hours were used, but the reason
or the likely cause is missing, the hours mode or write plan is missing, or the footer is
malformed.
