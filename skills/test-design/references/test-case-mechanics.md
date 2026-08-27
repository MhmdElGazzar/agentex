# Tool: Test Case mechanics (`create-cases.js` — Test Case work items)

Test-Case-specific mechanics: what the bundled script builds, what the agent supplies, and the
facts to check when something looks wrong. All board traffic goes through
`${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/create-cases.js` (tracker layer, ADO REST
over built-in fetch — no `az`, no shell). For shared boards knowledge (field reference names,
WIQL + current-iteration gotcha, relation directions, delete constraints), see
`references/tracker/ado-boards.md` (plugin root).

## Fetch a story for analysis

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/create-cases.js story --id <STORY_ID>
```

One JSON line: `{ok, story: {id, type, title, state, iterationPath, areaPath, url,
description, acceptanceCriteria, relations}}`. Description/AC come back as **HTML** — read the
tags to extract the design link (`<a href=...>`) and any translation tables. A non-User-Story
id exits 1 naming the actual type; ask the user for a valid story id.

## The spec file (agent judgment in, script mechanics out)

The agent writes a spec JSON to the **OS temp dir** (never into the consumer's repo) and runs
the dry run; step *content* is judgment, XML/quoting/IDs are the script's problem:

```json
{
  "storyId": 12345,
  "assignee": "qa.engineer@example.com",
  "cases": [
    { "title": "<Persona> || <Feature> || user checks the page UI",
      "steps": [
        { "type": "action",   "text": "Open the design for reference: <DESIGN_URL>" },
        { "type": "action",   "text": "…standard setup step from the conventions file…" },
        { "type": "validate", "text": "user checks the stepper/header/content", "expected": "matches the design" }
      ] }
  ]
}
```

- `type` is `action` or `validate`; every step needs `text`; every `validate` step needs
  `expected`. To reference a design link, put it in an ActionStep before the validations.
- `assignee` falls back to a single-valued `azure.assignee`; iteration/area are **always**
  inherited from the story by the script — do not put them in the spec.

```bash
# Dry run (default — the validation gate; writes NOTHING):
node …/create-cases.js --spec "$TMP/cases.json" [--allow-duplicate] [--refresh-fields]
# Only after the user's ONE approval of the consolidated screen:
node …/create-cases.js --spec "$TMP/cases.json" --execute
```

## Steps XML (built by the script — never write it by hand)

`create-cases.js` builds the `Microsoft.VSTS.TCM.Steps` value from the structured steps:

```xml
<steps id="0" last="[highest_step_id]">
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">Action text</parameterizedString>
    <parameterizedString isformatted="true"/>
  </step>
  <step id="3" type="ValidateStep">
    <parameterizedString isformatted="true">What the user does</parameterizedString>
    <parameterizedString isformatted="true">Expected result</parameterizedString>
  </step>
</steps>
```

Rules the script owns (so they can no longer be gotten wrong):

- Step IDs start at 2 and increment by 1 (`id="0"` is the container, `id="1"` is reserved) —
  the scheme portal-authored Test Cases use.
- **ActionStep**: second `<parameterizedString>` is always empty.
- **ValidateStep**: first string = action/check, second string = expected result.
- `last` attribute = the highest step ID used.
- XML-reserved characters in step text are escaped (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`).
- The XML travels as a **JSON request-body value** — there is no command line, no quoting
  trick, and no length ceiling involved.

## Linking (`Tested By`) — atomic, inside the create

Each Test Case is created with the relation `Microsoft.VSTS.Common.TestedBy-Reverse →
<storyId>` **in the same POST** — the story then shows **"Tested By →"** the test case
(its forward side). There is no separate link step, so "forgot to link" and "reversed the
direction" are not possible states. The post-write coverage check re-reads the story
(`story --id`, a free read) to show the links landed.

## Failure paths (the script's error JSON)

- **Duplicate titles** (`duplicate-title`, ids listed): an identically-titled Test Case
  already exists. Confirm with the user; only their explicit go-ahead justifies
  `--allow-duplicate`. A duplicate check that cannot complete (`dup-check-failed`) blocks —
  the script never creates blind.
- **`server-rejected-create`** after the cache passed: the field cache is stale — the JSON
  carries the live options and `cacheStale: true`; offer `--refresh-fields`. Nothing is
  retried automatically.
- **Transient `503` during `--execute`**: the failed case shows as `failed` in the ledger and
  later cases stay `not-attempted`. Report the exact ledger; re-running (with the already-created
  cases removed from the spec) is the **user's** call — never an automatic retry.
- **A wrong/duplicate Test Case that got created**: Test Cases cannot be deleted through the
  work-item APIs — ask the user to delete it from the Azure DevOps portal (Boards → work item
  → Delete). No cleanup writes.

## Quick reference

| Task | Command |
|---|---|
| Read a story | `node …/create-cases.js story --id <id>` |
| Validate a case spec (no writes) | `node …/create-cases.js --spec <file.json>` |
| Create the cases (after the one approval) | `node …/create-cases.js --spec <file.json> --execute` |
| Duplicate title, user said go | add `--allow-duplicate` |
| Picklists changed on the org | add `--refresh-fields` |
| Test plans / suites / runs | `node …/testplan.js` (separate concern, same conventions) |
