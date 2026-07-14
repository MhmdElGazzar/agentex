# Tool: Test Case mechanics (`az boards` — Test Case work items)

Test-Case-specific `az boards` mechanics. Read this before creating or linking test cases, or
when a command behaves unexpectedly. For shared basics (extension install, auth,
`configure --defaults`, current-iteration fetch, WIQL), see the azure-integration skill's
`references/azure-devops-cli.md`.

## Fetch a story for analysis

```bash
az boards work-item show --id <STORY_ID> --expand all --output json
```

Pull specific fields with JMESPath (escape the double-quotes around dotted names):

```bash
az boards work-item show --id <STORY_ID> --expand all \
  --query "{title: fields.\"System.Title\", iteration: fields.\"System.IterationPath\", ac: fields.\"Microsoft.VSTS.Common.AcceptanceCriteria\"}" -o json
```

Key field reference names:
- Acceptance Criteria → `Microsoft.VSTS.Common.AcceptanceCriteria`
- Description → `System.Description`
- Title → `System.Title`
- Iteration → `System.IterationPath`
- Test Case steps → `Microsoft.VSTS.TCM.Steps`

AC/description come back as **HTML** — read the tags to extract the design link
(`<a href=...>`) and any translation tables.

## Steps XML format

```xml
<steps id="0" last="[last_step_id]">
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">Action text</parameterizedString>
    <parameterizedString isformatted="true"/>
  </step>
  <step id="4" type="ValidateStep">
    <parameterizedString isformatted="true">What the user does</parameterizedString>
    <parameterizedString isformatted="true">Expected result</parameterizedString>
  </step>
</steps>
```

Rules:
- Step IDs start at 2 (`id="0"` is the container, `id="1"` is reserved).
- **ActionStep**: second `<parameterizedString>` is always empty.
- **ValidateStep**: first string = action/check, second string = expected result.
- `last` attribute = the highest step ID used.
- Escape XML-reserved characters inside step text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.
- To reference a design link, add an ActionStep like:
  `Open the design for reference: [DESIGN_URL]` before the validation steps.

## Create a Test Case (file + `$STEPS` — never inline the XML)

The Steps field is a large XML blob full of double-quotes — inlining it on the command line
breaks argument parsing. Write it to a file first, then load it:

```bash
# 1. Write the steps XML to a temp file (use the scratchpad dir)
cat > "$SCRATCH/tc_steps.xml" <<'EOF'
<steps id="0" last="5"><step id="2" type="ActionStep">...</step>...</steps>
EOF

# 2. Load it and create the Test Case
STEPS=$(cat "$SCRATCH/tc_steps.xml")
# $ITER = the story's iteration (fetch per the shared azure-devops-cli reference)
az boards work-item create \
  --type "Test Case" \
  --title "<Persona> || <Feature> || [condition]" \
  --iteration "$ITER" \
  --assigned-to "$AZURE_ASSIGNEE" \
  --fields "Microsoft.VSTS.TCM.Steps=$STEPS" \
  --query "id" -o tsv
```

Notes:
- Inside `"Microsoft.VSTS.TCM.Steps=$STEPS"`, the double-quotes coming from `$STEPS` are
  treated as literal text — the field round-trips intact (verified working).
- The heredoc uses `'EOF'` (quoted) so `$` and backticks in the XML are not expanded.
- On Windows run via the **Bash** tool (Git Bash); quote values containing spaces/backslashes.
- `--query "id" -o tsv` returns just the new work-item ID — capture it for linking.
- If a call returns a transient `503`, wait a couple of seconds and retry once.

## Link test cases to the story (`Tested By`)

After ALL test cases are created, link each to the parent story. The friendly name
`"Tested By"` resolves to `Microsoft.VSTS.Common.TestedBy-Forward`
(confirm with `az boards work-item relation list-type`).

```bash
# --id = the STORY (source), --target-id = the TEST CASE(s)
# NOTE: relation add does NOT take --yes (that flag is for relation remove / work-item delete)
az boards work-item relation add \
  --id <STORY_ID> \
  --relation-type "Tested By" \
  --target-id <TC1>,<TC2>,<TC3>
```

**Critical direction rule:** `--id` is the STORY, `--target-id` is the TEST CASE. This makes
the story show **"Tested By → TC"** (forward). Reversing the IDs — or using
`--relation-type "tests"` / `TestedBy-Reverse` — produces the wrong direction.

Verify the links landed forward:

```bash
az boards work-item show --id <STORY_ID> --expand relations \
  --query "relations[?contains(rel,'Tested')].rel" -o json
# expect: ["Microsoft.VSTS.Common.TestedBy-Forward", ...]
```

## Deleting / removing Test Cases

**The CLI cannot delete Test Case work items.** `az boards work-item delete` returns
*"You cannot delete or restore test work items using this API"*, and the Test Management REST
delete needs elevated permissions most identities don't have.

To handle duplicates/mistakes:
- **Mark for manual cleanup** — retitle and tag so a human can bulk-delete in the ADO web UI:
  ```bash
  az boards work-item update --id <TC_ID> \
    --title "ZZZ DELETE ME - <reason>" \
    --fields "System.Tags=DELETE-ME"
  ```
- Or ask the user to delete it from the Azure DevOps portal (Boards → work item → Delete).

## Quick reference

| Task | Command |
|---|---|
| Read a story | `az boards work-item show --id <id> --expand all -o json` |
| Create a test case | `az boards work-item create --type "Test Case" --fields "Microsoft.VSTS.TCM.Steps=$STEPS" …` |
| Link story → TC | `az boards work-item relation add --id <STORY> --relation-type "Tested By" --target-id <TC>` |
| Verify link direction | `… --expand relations --query "relations[?contains(rel,'Tested')].rel"` |
| List relation types | `az boards work-item relation list-type` |
| Mark TC for manual delete | `az boards work-item update --id <TC> --title "ZZZ DELETE ME - …" --fields "System.Tags=DELETE-ME"` |
