---
description: Design test cases for User Stories on the configured tracker — Azure DevOps or Jira — analyze ACs into test conditions, create titled test artifacts with structured steps (ADO Test Cases linked Tested By; on Jira the issue type the user chooses, linked back to the story), all behind ONE consolidated approval. Pass one or more story IDs.
---

Use the **test-design** skill to design and create test cases on the configured tracker
(Azure DevOps or Jira).

Story IDs / scope: $ARGUMENTS

- All board reads and writes go through the skill's bundled scripts
  (`skills/test-design/scripts/create-cases.js`; `testplan.js` for plan/suite/run work —
  ADO only, it refuses Jira configs upfront) — never `az` or `acli`, never hand-composed
  REST. Org/site/project/credentials resolve from the project's config and `.env` by the
  scripts themselves, for whichever tracker is configured.
- Read the project conventions from `./.agentex/test-template.md`; if it doesn't exist,
  scaffold it from the skill's template and ask the user to fill it in before designing.
- Fetch each story with `create-cases.js story --id <id>`, map its ACs to test conditions
  per the skill, and bundle anything genuinely unresolvable (feature not in the map,
  missing persona/assignee — and on Jira the what-to-create artifact choice, since Jira has
  no native Test Case type) into at most ONE question round.
- Validate with the dry run, then show ONE consolidated screen — the conditions table, the
  titled cases with step summaries, the duplicate-check results, and the exact write plan
  (Tested By inline on ADO; create + link intents on Jira) — and wait for the user's
  approval before running `--execute`. Never write without it.
- Finish with the coverage table built from the ledger plus a fresh story read showing the
  links landed; offer to add cases for anything uncovered (a new spec → a new gate).
