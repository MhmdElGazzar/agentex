---
description: Estimate QA effort for Azure DevOps User Stories and create [Testing] tasks on them (5 per story) — per-story analysis, then ONE consolidated approval for the whole run. Pass story IDs to target specific stories; defaults to the current sprint's stories.
---

Use the **task-estimation** skill to estimate and create QA testing tasks on Azure DevOps.

Scope / notes: $ARGUMENTS

- All board reads and writes go through the skill's bundled script
  (`skills/task-estimation/scripts/create-tasks.js`) — never `az`, never hand-composed REST.
  Org/project/PAT resolve from the project's config and `.env` by the script itself.
- If the arguments name specific story IDs, limit the run to those (`stories --ids …`);
  otherwise use the current sprint's User Stories (`stories --current-sprint`).
- Follow the skill's three phases: read + analyze every story first, bundle any genuinely
  open questions (missing team/assignee, skip-vs-add on stories with existing `[Testing]`
  tasks) into at most ONE question round, then show ONE consolidated screen — per-story
  estimates plus the exact write plan — and wait for the user's approval
  ("yes" / "تمام" / "approved") before running `--execute`. Never write without it.
- Report the result from the script's ledger: every task done (ID + URL) or not-done
  (reason); a partial result is a failure, and remediation is the user's call.
