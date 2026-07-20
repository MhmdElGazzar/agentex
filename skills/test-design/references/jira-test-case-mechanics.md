# Tool: Test Case mechanics (`acli jira workitem` — Jira test issues)

Test-Case-specific `acli` mechanics. Read this before creating or linking test cases, or when a
command behaves unexpectedly. For shared basics (install, auth, JQL, current-sprint fetch), see
the jira-integration skill's `references/jira-issues-cli.md`.

## Fetch a story for analysis

```bash
acli jira workitem view --key <STORY_KEY> --json
```

Key field reference names (Jira REST/`acli` JSON output):
- Acceptance Criteria → usually in `fields.description` (custom "Acceptance Criteria" field if
  the project has one — confirm the field name/ID once per project) or a dedicated field like
  `customfield_1xxxx`
- Description → `fields.description` (Atlassian Document Format — read the ADF nodes, or request
  `--json` and look for plain-text fallback)
- Title → `fields.summary`
- Sprint → `fields.sprint` / `fields.customfield_xxxxx` (board-dependent)

Description/AC content comes back as **ADF** (Atlassian Document Format), not HTML — walk the
`content` nodes to extract the design link (`type: inlineCard` / `type: link` mark) and any
translation tables.

## No native "Test Case" work-item type

Unlike ADO, Jira has no built-in Test Case type or Steps field. Two situations, confirm which
applies **once per project** (see Configuration in the parent skill):

1. **Test-management plugin installed** (Xray, Zephyr Scale, etc.) — a real `Test` / `Test Case`
   issue type exists with a dedicated steps field (often a custom field or a plugin-specific
   `acli`/REST endpoint). Ask the user for the issue type name and, if `acli` doesn't expose the
   plugin's step field directly, use the plugin's REST API instead (see its docs) — do not
   guess a custom field ID.
2. **No plugin** — use a plain issue type (commonly `Task`, sometimes a custom `Test Case` type
   your team created) and put the steps in the **description** as a structured Markdown table
   (converted to ADF by `acli`):

```
| # | Step | Expected Result |
|---|---|---|
| 1 | Given the customer lands on the homepage | Homepage loads |
| 2 | When the customer clicks Next | Step 2 form is shown |
```

Rules:
- Keep Action and Expected Result in separate columns — mirrors ADO's ActionStep/ValidateStep
  split so coverage stays easy to audit.
- To reference a design link, add a step row like:
  `Open the design for reference: [DESIGN_URL]` before the validation rows.
- Escape any literal `|` inside step text as `\|` so the Markdown table doesn't break.

## Create a Test Case (file + description — avoid inlining long text)

For long step tables, write the description to a file first, then load it, same reasoning as
the ADO skill's `$STEPS` trick — long multi-line text with pipes/quotes breaks command-line
parsing:

```bash
# 1. Write the steps table to a temp file (use the scratchpad dir)
cat > "$SCRATCH/tc_steps.md" <<'EOF'
| # | Step | Expected Result |
|---|---|---|
| 1 | ... | ... |
EOF

# 2. Load it and create the Test Case
STEPS=$(cat "$SCRATCH/tc_steps.md")
NEW_KEY=$(acli jira workitem create --project "$JIRA_PROJECT" --type "<confirmed Test Case type>" \
  --summary "<Persona> || <Feature> || [condition]" \
  --assignee "$JIRA_ASSIGNEE" \
  --description "$STEPS" \
  --json | jq -r '.key')
```

Notes:
- The heredoc uses `'EOF'` (quoted) so `$` and backticks in the steps text are not expanded.
- On Windows run via the **Bash** tool (Git Bash); quote values containing spaces/backslashes.
- `--json | jq -r '.key'` returns just the new issue key — capture it for linking.
- If a call returns a transient `5xx`, wait a couple of seconds and retry once.

## Link test cases to the story

After ALL test cases are created, link each to the parent story with the **confirmed link
type** (see Configuration in the parent skill — commonly `Tests` from Xray, or `relates to` if
no plugin is installed).

```bash
# --key = the STORY (source), --target-key = the TEST CASE
acli jira workitem link --key <STORY_KEY> --link-type "Tests" --target-key <TC1_KEY>
acli jira workitem link --key <STORY_KEY> --link-type "Tests" --target-key <TC2_KEY>
```

**Critical direction rule:** `--key` is the STORY, `--target-key` is the TEST CASE, using the
outward name of the link type (e.g. `Tests`, not its inward complement `is tested by`).
Reversing them flips the relationship as it reads on the story.

Verify the links landed correctly:

```bash
acli jira workitem view --key <STORY_KEY> --json | jq '.fields.issuelinks'
```

## Deleting / removing Test Cases

Unlike ADO's blocked Test Case delete, plain Jira issues (and most plugin Test types) CAN be
deleted via `acli jira workitem delete --key <TC_KEY>` — but treat it as **destructive**:
confirm with the user first, since it also removes its links and any execution history a
test-management plugin tracked against it.

If deletion is restricted by permissions, fall back to marking for manual cleanup:
```bash
acli jira workitem update --key <TC_KEY> --summary "ZZZ DELETE ME - <reason>"
```

## Quick reference

| Task | Command |
|---|---|
| Read a story | `acli jira workitem view --key <KEY> --json` |
| Create a test case | `acli jira workitem create --type "<Test Case type>" --description "$STEPS" …` |
| Link story → TC | `acli jira workitem link --key <STORY> --link-type "Tests" --target-key <TC>` |
| Verify links | `acli jira workitem view --key <STORY> --json \| jq '.fields.issuelinks'` |
| Delete a test case | `acli jira workitem delete --key <TC>` (confirm first) |
| Mark TC for manual delete | `acli jira workitem update --key <TC> --summary "ZZZ DELETE ME - …"` |
