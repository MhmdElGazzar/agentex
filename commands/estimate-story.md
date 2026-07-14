---
description: Estimate QA effort for Azure DevOps User Stories and create [Testing] tasks on them (5 per story), one story at a time with confirmation. Pass story IDs to target specific stories; defaults to the current sprint's stories.
---

Use the **task-estimation** skill to estimate and create QA testing tasks on Azure DevOps.

Scope / notes: $ARGUMENTS

- Resolve configuration first (organization, project, team, assignee). Take any values named in
  the arguments; otherwise use the `AZURE_*` keys the user has set, and ask once for anything
  missing. Never hardcode an org/project/team/email.
- Read the skill's `references/azure-devops-cli.md` before the first `az boards` command. If `az`
  or the `azure-devops` extension isn't installed, follow the reference's preflight/install steps.
- Process **one story at a time**: show the estimate, wait for confirmation ("yes" / "تمام" /
  "approved"), then create the 5 tasks. Never batch-create without approval.
- If the arguments name specific story IDs, limit the run to those; otherwise use the current
  sprint's User Stories.
