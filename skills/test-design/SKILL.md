---
name: test-design
description: >
  Designs test cases for Azure DevOps User Stories: analyze a story's acceptance criteria into
  test conditions, map them to test case titles, create the test cases in ADO with structured
  steps, and link them to the parent story (Tested By). Use this skill whenever the user wants to:
  - Analyze a user story and identify test conditions (what to test)
  - Map AC scenarios to test case titles using a naming convention
  - Create test cases in ADO with proper steps
  - Link test cases to their parent story
  - Review whether a story's ACs are fully covered by test cases
  Trigger on phrases like: "create test cases for story", "design tests for", "what test cases
  do I need", "analyze story for testing", "map ACs to test conditions", or any time a user
  story ID is mentioned alongside test design/coverage work.
---

# Test Design — Azure DevOps

End-to-end methodology for designing, creating, and linking test cases to User Stories in
Azure DevOps. This file is the **workflow** (how to analyze ACs, what test cases to derive,
when to confirm). Command mechanics live in the references — **read them before the first
`az boards` command in a session**:

- **`${CLAUDE_PLUGIN_ROOT}/skills/test-design/references/test-case-mechanics.md`** — Test Case
  creation specifics: Steps XML format, the file+`$STEPS` quoting trick, `Tested By` link
  direction, the no-delete gotcha, retry notes.
- **`${CLAUDE_PLUGIN_ROOT}/skills/azure-integration/references/azure-devops-cli.md`** — shared
  `az devops` basics: extension install, auth, `configure --defaults`, fetching the current
  iteration, WIQL queries.

## Configuration (never hardcode)

Same resolution as the task-estimation skill — from the user's message, `.env` (`AZURE_*` keys),
or an existing `az devops configure --defaults`; **ask once** for anything missing and reuse it
all session. Never bake an organization, project, team, or email into commands.

| Setting | Source |
|---|---|
| Organization URL | `AZURE_URL` / ask |
| Project | `AZURE_PROJECT` / ask |
| Team | `AZURE_TEAM` / ask |
| Assignee | `AZURE_ASSIGNEE` / ask |
| PAT (auth) | `AZURE_DEVOPS_EXT_PAT` env in the user's shell — never print or pass it |

## Project conventions file

Everything that varies per project lives in the **consumer project**, not in this skill:
persona, feature map, standard setup steps, project-specific condition categories, and
the languages text checks must cover.

- Look for **`./.agentex/test-template.md`** in the current project and read it before
  designing anything.
- If it doesn't exist, offer to scaffold it: create the `./.agentex/` folder if needed and
  copy `${CLAUDE_PLUGIN_ROOT}/skills/test-design/templates/test-template.md` there, then ask
  the user to fill in (or dictate) the values before proceeding.
- If a needed convention is missing from the file, ask — do not guess.

## Step 1 — Fetch the User Story

Fetch with `--expand all` (see mechanics reference for the command and field names). Read the
description + acceptance criteria, extract any design link (e.g. Figma) and translation tables
from the HTML.

## Step 2 — Identify Test Conditions

Group the ACs into **test conditions**. Each test condition maps to ONE test case.

### Generic condition categories

| AC Content | Test Condition → Test Case Title |
|---|---|
| UI structure, layout, icons, design reference | `user checks the page UI` |
| All text labels, titles, subtitles (every supported language) | `user checks the page text` |
| Button click with action/navigation result | `user checks the [button name] functionality` |
| Valid input values accepted | `user checks valid input` |
| Invalid input (empty, special chars, wrong type, spaces) | `user checks invalid input` |
| Dropdown / selection logic | `user checks [dropdown name] selection` |
| Error / validation messages | `user checks the [feature] error message` |
| Counter/summary values | typically included in the UI check |

The conventions file may add project-specific categories (e.g. a helper panel, a read-only
info section) — treat each as its own test case whenever the story includes that element.

### Rules for identifying conditions

1. **One test case per condition** — never merge two conditions into one test case.
2. **Text is always separate from UI** — even a one-scenario story gets its own text test case.
3. **Each button gets its own test case** — e.g. Next and Back are separate.
4. **No inputs in the story? No input test cases** — only create what the AC specifies.
5. **Out-of-scope items** — if the AC says "handled separately" / "out of scope", do NOT
   create a test case for it.
6. **Conventions-file categories** — always a separate test case when the story includes that
   element.

### Confirm before creating

Present the mapped conditions and wait for approval:

```
## Test Conditions for Story [ID] — [Story Title]

| # | Test Case Title | Covers |
|---|---|---|
| 1 | user checks the page UI | [what it covers] |
| 2 | user checks the page text | [labels, languages] |
...

Is anything missing? Should I add or remove any test condition?
```

## Step 3 — Determine the Feature

Each title includes the feature the story belongs to. A feature can be a step in a flow
(e.g. `Step5`) but not always — it can also be any feature name (e.g. `Login`). Read the
feature map from the conventions file; if the story isn't in the map, infer from the
story's context or ask the user.

## Step 4 — Title Convention

```
<Persona> || <Feature> || [test condition]
```

- **Persona** comes from the conventions file (e.g. `SME User`).
- Feature comes from the feature map (a flow step like `Step5`, or a feature name — not the story ID).
- Test condition is lowercase, no punctuation at the end, no quotes around it.

Examples (with persona "SME User"): `SME User || Step5 || user checks the page UI`,
`SME User || Login || user checks the page UI`

## Step 5 — Test Case Steps

Every test case = the standard setup ActionSteps (from the conventions file, adjusted to the
prerequisites of the story's step) followed by ValidateSteps for the condition:

- **page UI** — open the story's design link (include it as an ActionStep so testers know the
  reference); verify stepper/header/content/buttons/side panels/spacing against the design.
- **page text** — one validate step per label per supported language (from conventions).
- **[button] functionality** — default state, click, expected outcome (navigation or error, in
  every supported language), and that the user stays/moves as expected.
- **valid input** — per field: enter a valid value → accepted.
- **invalid input** — per field: empty, special characters, unsupported type, leading/trailing
  spaces → error shown.
- **Conventions-file categories** — per the checks the conventions file defines for them.

XML structure, IDs, and quoting rules are in the mechanics reference.

## Step 6 — Create the Test Cases

Follow the mechanics reference exactly (file + `$STEPS` variable, iteration inherited from the
story, assignee from config). Capture each new ID.

## Step 7 — Link to the Story

Link every test case to the story with the **`Tested By`** relation — `--id` = STORY,
`--target-id` = test case(s). Direction matters; verify afterwards (commands in the mechanics
reference).

## Step 8 — Coverage Check

Map every AC scenario to a created test case and show the table. Flag anything uncovered and
ask whether to add a test case for it.

## Common Mistakes to Avoid

- ❌ Creating a test case for something the AC marks "handled separately" / out of scope
- ❌ Merging text and UI into one test case
- ❌ Reversing `--id`/`--target-id` on the link (must be `--id`=story, `--target-id`=TC)
- ❌ Inlining raw Steps XML on the command line instead of the file + `$STEPS` variable
- ❌ Forgetting to XML-escape `&`, `<`, `>` inside step text
- ❌ Putting a PAT on the command line (auth flows through the extension)
- ❌ Creating input test cases when the story has no input fields
- ❌ Skipping non-primary-language text checks when the project is multilingual
- ❌ Using a feature that doesn't match the feature map

## Jira (in addition to Azure DevOps)

This skill also works on **Jira** — the whole methodology above (condition mapping, title
convention, step derivation, coverage check, common mistakes) applies unchanged. Only the
Test Case creation/linking mechanics differ.

- **Detect the tracker**: a pasted link (`dev.azure.com/...` → Azure DevOps,
  `*.atlassian.net/...` → Jira), what the user names explicitly, or — if ambiguous — ask once
  and reuse the answer for the session.
- **Reference**: read
  `${CLAUDE_PLUGIN_ROOT}/skills/test-design/references/jira-test-case-mechanics.md` before
  creating or linking any Jira test case, plus the jira-integration skill's
  `references/jira-issues-cli.md` for shared `acli` basics.
- **Configuration (Jira)**: `JIRA_URL`, `JIRA_PROJECT`, `JIRA_BOARD_ID`, `JIRA_ASSIGNEE` /
  ask once each; `JIRA_API_TOKEN` env in the user's shell — never print or pass it. Additionally
  ask once (no ADO equivalent):
  - **Test Case issue type name** — Jira has no built-in Test Case type; it's usually a
    plugin's type (Xray: `Test`, Zephyr: `Test Case`) or a plain type the team designates.
  - **Story ↔ Test Case link type** — commonly `Tests` (Xray) or `relates to`.
- **Conventions file**: the same `./.agentex/test-template.md` — its "Jira-specific settings"
  section (added below the Design reference section) holds the two Jira-only values above.
- **Steps**: no native Steps XML field on Jira — put Action/Expected pairs in a Markdown table
  in the description instead (see the reference for the exact format and the file-based
  create trick for long tables).
- **Linking**: `--key` = the STORY, `--target-key` = the TEST CASE, using the link type's
  outward name (e.g. `Tests`, not its inward complement `is tested by`).
- Everything else — one test case per condition, confirm-before-create, coverage check —
  applies exactly as written above for ADO.