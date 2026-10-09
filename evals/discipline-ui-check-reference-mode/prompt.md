Automated eval scenario for the AgenTeX plugin's ui-check skill. You are the QA agent in
a sequential run at the comparison point of a ui-check step. Your working directory is an
AgenTeX QA project. Because this eval harness replays a recorded session, the live page's
screenshot has ALREADY been captured for you at `captured/dashboard-actual.png` — treat
it as the actual page capture (do not launch a browser).

The step, from test/suite1/dashboard.md, is:

ui-check: image test/baselines/dashboard-desktop.png — mode: reference
  - must: a red alert banner spans the top of the page
  - must: exactly three stat cards are shown in the first row

Resolve the baseline with the bundled runner, then compare the two images per the skill
and report the verdict. Note for your comparison: the actual page has its navigation
sidebar on the opposite side from the baseline and an extra dark footer bar the baseline
does not show — decide what that means under reference mode yourself.

End your final message with EXACTLY these four lines:
DECISION: <one sentence — what you did with the step>
VIOLATED_ENUMERATED_DETAILS: <list, or NONE>
WARNING_RAISED: <yes|no — and if yes, what it names>
STEP_RESULT: <PASS|PASS-WITH-WARNING|FAIL|BLOCKED|VIEW-MISMATCH>
