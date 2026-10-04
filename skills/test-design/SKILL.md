---
name: test-design
description: >
  Designs test cases for Azure DevOps User Stories: analyze a story's acceptance criteria into
  test conditions, map them to test case titles, create the test cases in ADO with structured
  steps, and link them to the parent story (Tested By) — validated first, then ONE consolidated
  approval, through bundled REST scripts (no Azure CLI). Use this skill whenever the user wants to:
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
the one approval gate). The mechanics live in the bundled scripts — never run `az` or compose
REST calls for board operations:

- **`${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/create-cases.js`** — the story read and
  the test-case creation/linking (dry run by default, `--execute` behind the one approval;
  the script builds the Steps XML from structured steps). Read
  **`${CLAUDE_PLUGIN_ROOT}/skills/test-design/references/test-case-mechanics.md`** for the
  spec shape, XML doctrine, and failure paths before the first spec of a session.
- **`${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md`** — shared boards knowledge:
  field reference names, relation directions, the Test-Case no-delete constraint.
- **`${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/testplan.js`** — test-plan mechanics
  (list-suites / list-cases / find-case / create-case / fail), a separate concern with the
  same conventions; the bug-report-azure skill invokes it cross-skill.

## Configuration (never hardcode)

Org, project, and assignee resolve from `config/project.json`'s `azure` block (legacy
`AZURE_*` keys in `.env` as fallback) — the scripts read them themselves, and the PAT
(`AZURE_PAT` in `.env`) never leaves them: Authorization header only, never printed or on a
command line. Never bake an organization, project, team, or email into anything. Anything
genuinely missing joins the ONE bundled question round below.

## Project conventions file

Everything that varies per project lives in the **consumer project**, not in this skill:
persona, feature map, standard setup steps, project-specific condition categories, and
the languages text checks must cover.

- Look for **`./.agentex/test-template.md`** in the current project and read it before
  designing anything.
- If it doesn't exist, offer to scaffold it: create the `./.agentex/` folder if needed and
  copy `${CLAUDE_PLUGIN_ROOT}/skills/test-design/templates/test-template.md` there, then ask
  the user to fill in (or dictate) the values before proceeding. (A consumer-file write with
  its own consent — it happens before any board work and is outside the board-write gate.)
- If a needed convention is missing from the file, that question joins the one bundled round
  — do not guess.

## Step 1 — Fetch the User Story

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/create-cases.js story --id <STORY_ID>
```

Read the description + acceptance criteria from the JSON (HTML — extract any design link,
e.g. Figma, and translation tables from the tags yourself).

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

The mapped conditions table (with a "covers" column) is presented **on the consolidated
screen** (Step 6) — not as its own confirmation round.

## Step 3 — Determine the Feature

Each title includes the feature the story belongs to. A feature can be a step in a flow
(e.g. `Step5`) but not always — it can also be any feature name (e.g. `Login`). Read the
feature map from the conventions file; if the story isn't in the map, infer from the
story's context — or add the question to the one bundled round.

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

You write step *content* as structured JSON (`{type, text, expected}` — see the mechanics
reference); the script owns the XML, IDs, and escaping.

## Step 6 — Validate, one screen, ONE approval

**Bundled input round (only if needed):** anything genuinely unresolvable — a feature not in
the map, a persona missing because the conventions file is incomplete, no assignee anywhere —
is asked in ONE AskUserQuestion **before** validation, never as a series of asks. When the
conventions file + config answer everything, the approval is the only interaction.

1. Build the spec (`storyId`, `assignee`, `cases` with structured steps), write it to the
   **OS temp dir**, and dry-run:
   ```bash
   node …/create-cases.js --spec "$TMP/cases.json" [--allow-duplicate]
   ```
   Exit 2 = blocked: surface the reasons (duplicate Test Case IDs, bad steps, stale-cache
   options with a `--refresh-fields` offer), correct for the run, re-run — a failure-path
   round, not a second gate.
2. Render **the consolidated screen**: the conditions table (with its "covers" column and
   "is anything missing?" framed as part of this one screen), the titled cases with a
   per-case step summary, the duplicate-check results, and **the exact write plan** (one
   atomic create per case, Tested By inline, routes listed) — plus the explicit statement
   that **nothing has been written yet**. Additions/removals edit the spec and re-run the
   dry run; the corrected screen still ends in exactly one approval.
3. **One approval** → re-run with `--execute`. Anything else → stop, zero writes.

## Step 7 — Report from the ledger

Every intended case done (ID + URL) or not-done (reason), straight from the script's ledger.
Linking happened inside each create (`TestedBy-Reverse` → story), so there is no separate
link step to verify or forget. A partial failure is a **failure** — name exactly which cases
now exist; no retry, no cleanup (Test Cases can't be deleted via the API — portal cleanup is
the user's call).

## Step 8 — Coverage Check

Map every AC scenario to a created test case **from the ledger**, re-read the story
(`story --id <id>` — a free read) to show the Tested By links landed, and show the table.
Flag anything uncovered and ask whether to add a test case for it (a new spec → a new gate).

## Common Mistakes to Avoid

- ❌ Creating a test case for something the AC marks "handled separately" / out of scope
- ❌ Merging text and UI into one test case
- ❌ Creating input test cases when the story has no input fields
- ❌ Skipping non-primary-language text checks when the project is multilingual
- ❌ Using a feature that doesn't match the feature map
- ❌ Asking the condition-table question and the approval as two separate rounds — they are
  ONE screen, one approval
- ❌ Running `az` or composing REST calls for board operations — the scripts own transport
  and auth (and the old XML/quoting/link-direction mistakes died with them)
