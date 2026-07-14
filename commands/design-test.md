---
description: Design test cases for Azure DevOps User Stories — analyze ACs into test conditions, create titled test cases with steps in ADO, and link them Tested By to the story. Pass one or more story IDs.
---

Use the **test-design** skill to design and create test cases on Azure DevOps.

Story IDs / scope: $ARGUMENTS

- Resolve configuration first (organization, project, team, assignee) — from the arguments, the
  `AZURE_*` keys, or ask once. Never hardcode an org/project/team/email.
- Read the project conventions from `./.agentex/test-template.md`; if it doesn't exist, scaffold
  it from the skill's template and ask the user to fill it in before designing.
- Read the skill's `references/test-case-mechanics.md` before creating any Test Case, and the
  azure-integration skill's `references/azure-devops-cli.md` for shared `az devops` basics.
- Present the mapped test conditions and **wait for confirmation** before creating anything.
- After creating, link every test case to its story (`Tested By`, `--id` = story) and finish
  with the coverage check table.
