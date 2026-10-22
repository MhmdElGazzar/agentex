---
description: Estimate QA effort for named User Stories (Azure DevOps IDs or Jira keys) and create the `[Testing]` tasks your project's `config/estimation.json` defines, proposed from your team's last closed sprints on the first run, behind ONE consolidated approval. No IDs → the current sprint (same as `/estimate-sprint`).
---

Use the **task-estimation** skill to estimate and create QA testing tasks on the configured
tracker (Azure DevOps or Jira).

Scope / notes: $ARGUMENTS

- All board reads and writes go through the skill's bundled script
  (`skills/task-estimation/scripts/create-tasks.js`) — never `az` or `acli`, never
  hand-composed REST. Org/site/project/credentials resolve from the project's config and
  `.env` by the script itself, for whichever tracker is configured.
- If the arguments name specific story IDs (or Jira issue keys), limit the run to those
  (`stories --ids …`); otherwise use the current sprint's User Stories
  (`stories --current-sprint`), exactly like `/estimate-sprint`.
- Run the script's `estimation` read first. With `config/estimation.json` present, its enabled
  tasks and factors drive the run; an invalid file stops the run naming every problem. With
  no file yet, the run proposes one from the team's last closed sprints (or labelled starter
  defaults) on the same screen. Never edit, repair or replace the file — it is the user's.
- Follow the skill's three phases: read + rate every story first, bundle any genuinely open
  questions (missing team/assignee, skip-vs-add on stories with existing `[Testing]` tasks, a
  multi-open-sprint, board or sub-task-type choice on Jira) into at most ONE question round,
  then show ONE consolidated screen — the file or the proposal (abnormal values with their
  three choices), per-story ratings and hours, and the exact write plan — and wait for the
  user's approval ("yes" / "تمام" / "approved") before running `--execute`. Never write without
  it.
- Report the result from the script's ledger: the file line on a first run and every task done
  (ID + URL) or not-done (reason); a partial result is a failure, and remediation is the
  user's call.
