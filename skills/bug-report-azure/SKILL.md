---
name: bug-report-azure
description: "After a completed test/regression run where one or more defects were found, file them as Azure DevOps Bugs following a configurable bug template — through bundled Node scripts that talk to the ADO REST API directly (no Azure CLI needed). Product/team-agnostic: org, project, area path, template, assignees, and test plan resolve from config, never hardcoded. ONE gate per filing: all reads and validation run first with zero board writes, then a single consolidated screen (validated fields + the exact write plan) and one approval before anything is written. Severity/priority recommended from the run's findings, screenshots validated in two passes, writes fail closed with an exact per-write ledger — the board never silently differs from what the user confirmed."
---

# Report Azure Bug (Generic)

Turn defects found during a run into Azure DevOps **Bugs** that mirror a configurable
team template and hang off the right User Story — behind **exactly one approval**. This is
the closing gate of a test run, and its whole promise is: *nothing lands on the board
beyond what you confirmed, and nothing silently.*

This skill is **decoupled from any specific team or product**. Everything team-specific is a
placeholder resolved at runtime from `config/project.json`'s `azure` block or legacy `AZURE_*`
keys in `.env` (never hardcoded in the skill):

| Placeholder | Meaning | Resolved from |
|---|---|---|
| `{{ORG_URL}}` | Azure DevOps org (URL or bare org name) | `azure.org` (`config/project.json`) → `AZURE_URL` |
| `{{PROJECT_NAME}}` | Project | `azure.project` (`config/project.json`) → `AZURE_PROJECT` |
| `{{TEAM_NAME}}` | Team | `azure.team` (`config/project.json`) → `AZURE_TEAM` |
| `{{AREA_PATH}}` | Area Path | `azure.areaPath` → `AZURE_AREA_PATH` or inherited from the parent story |
| `{{ITERATION_PATH}}` | Iteration Path | `azure.iterationPath` → `AZURE_ITERATION_PATH` or inherited from the parent story |
| `{{TEMPLATE_BUG_ID}}` | Reference bug the template mirrors | `azure.bugTemplateId` → `AZURE_BUG_TEMPLATE_ID` (optional) |
| `{{ASSIGNEE_EMAIL}}` | Bug assignee options | `azure.assignee` → `AZURE_ASSIGNEE` (comma-separated) |
| `{{TEST_PLAN_ID}}` / `{{TEST_SUITE_ID}}` | Related test plan / suite | `azure.testPlanId` → `AZURE_TEST_PLAN_ID` |
| `{{ENVIRONMENT}}` / `{{BUG_CATEGORY}}` | Custom picklist fields | `azure.environment` / `azure.bugCategory` or the run's environment |

The **PAT** is read from `.env` by the bundled scripts themselves (`AZURE_PAT`, legacy
`AZURE_DEVOPS_EXT_PAT` / `AZURE_DEVOPS_PAT`) and sent only in the Authorization header —
never printed, logged, or placed on a command line. No shell export, no `az login`, no
Azure CLI install is needed for bug filing.

## Tooling: bundled scripts over the ADO REST API

Every lookup, validation, and write goes through bundled Node scripts built on the
plugin's tracker layer (`scripts/lib/tracker/` — direct REST over Node's built-in fetch).
**Never run `az` for any part of bug filing, and never compose REST calls yourself** — the
scripts own transport, auth, and validation; you own judgment and the user conversation.

- `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js` — validate a bug
  spec (dry run) and, behind `--execute`, run the fail-closed write sequence with a ledger.
- `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/read-workitem.js` — read-only:
  `show --id <id> [--expand all]` (template bug, story validation), `find --type --title`.
- `${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/testplan.js` — test-plan mechanics
  (cross-skill, owned by test-design): `list-suites` / `list-cases` / `find-case` /
  `create-case` / `fail`. Same dry-run default and ledger discipline.
- `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/check-image.js` — structural
  screenshot validation (Pass 1 of the evidence gate; local, no tracker access).

Each script prints **one JSON line** and exits 0/1/2. Dry run is the default; nothing is
written without `--execute`. You render the plan and the ledger for the user — the scripts
never talk to them.

### Field/picklist cache & the refresh path

Valid picklist values (severity, priority, `Custom.*` fields) vary per ADO project. The
scripts build a per-project metadata cache on first use —
`.agentex/cache/tracker-fields-ado.json` (gitignored; committing it is an explicit opt-in:
add a `!.agentex/cache/` line to `.gitignore`) — and validate every supplied value against
the **project's real values** before the gate. When the user asks to refresh (or the
server rejects a value the cache accepted), re-run the validating script with
`--refresh-fields`; a stale-cache rejection comes back with the real current options and
`cacheStale: true` — surface those options, never substitute a value silently.

## Hard constraints (never violate — these are the point of the skill)

1. **Write nothing on Azure DevOps beyond what the user explicitly approved on the one
   consolidated screen** — the bug, its single parent link, the validated attachments, and
   the explicitly chosen test-case action. Nothing else, ever.
2. **Reads and validation run freely; writes only behind the one approval.** Exactly ONE
   approval interaction sits between the user's filing request and the board writes.
3. **One link type only:** User Story → (parent) → Bug (`System.LinkTypes.Hierarchy-Reverse`).
   No related / duplicate / any other link. Never edit the User Story itself.
4. **Never edit a Test Plan / Suite / Test Case** except the two explicit, user-chosen
   actions: record a *Failed outcome* on an existing case, or create a new case.
5. **The duplicate check fails CLOSED.** If it cannot complete, the filing blocks — it
   never proceeds on a dup-check failure. A found duplicate is surfaced and needs the
   user's explicit go-ahead (`--allow-duplicate`).
6. **Never infer or auto-fill required fields** (severity, priority, parent story,
   assignee). Recommend with reasoning where the skill says so; the user's choice wins.
7. **Every partial failure is reported as a FAILURE with the exact ledger** — every
   intended write shown as done (ID + URL) or not-done (reason). Created work-item IDs are
   always reported, even when a later step threw. **No auto-retry, no cleanup writes** —
   remediation is the user's call on the board.
8. **Never rewrite the consumer's config.** An invalid config-supplied value blocks the
   run and is corrected *for this run only*.

## When to run

At the end of any run/task that surfaced one or more issues. Offer it proactively: "N
issues were found — want to file any as Azure Bugs?" If the user declines, stop. Nothing
touches the board.

## Workflow — three phases, one gate

### Phase A — collect & read (no user interaction, no writes)

1. **Defects:** take them from the run's report. The user's ask usually names which to
   file; if it is genuinely ambiguous, that question joins the Phase-B bundle — it never
   stands alone.
2. **Resolve from config + run context** (ask for nothing that is already known):
   - Template: `{{TEMPLATE_BUG_ID}}` →
     `node read-workitem.js show --id {{TEMPLATE_BUG_ID}} --expand all` to mirror its shape.
   - Parent story: from the ask or the run's story context; validate via
     `node read-workitem.js show --id <storyId>` — it must exist and be a **User Story**.
   - Assignee options (`azure.assignee`), environment/category (`azure.*` or the run's
     environment), test-plan intent (`azure.testPlanId`).
3. **Screenshot evidence (two passes, unchanged discipline):**
   - Pass 1 — structural: `node check-image.js --dir <screenshots-folder>` drops
     corrupt / 0×0 / too-small / likely-blank images.
   - Pass 2 — content relevance (your vision): Read each surviving image and judge it
     against this bug's summary/expected/actual. An unrelated or unsupportive screenshot
     is flagged (Phase-B bundle), never silently attached.
4. **Severity + priority recommendation** from the observed impact in this run (the user
   still decides — the recommendation and its one-line reasoning go on the consolidated
   screen, where approving the screen approves the values):

| Observed impact in the run | Recommended Severity | Recommended Priority |
|---|---|---|
| Blocks the flow, no workaround (can't advance / pay / issue) | `1 - Critical` | `1` |
| Wrong/missing data in an issued artifact, or broken core path w/ workaround | `2 - High` | `1` or `2` |
| Localized functional error, visible but non-blocking | `3 - Medium` | `2` or `3` |
| Minor cosmetic / edge polish | `4 - Low` | `3` or `4` |

### Phase B — ONE bundled input round, only if needed

Everything still unresolved after Phase A is asked in **one** `AskUserQuestion` carrying
all open questions at once — never a series of separate questions:

- severity + priority, only when the impact is too ambiguous for a confident
  recommendation (recommended option first, alternatives listed);
- assignee (configured options + "other"), only when config gives none or several with no
  steer;
- parent story ID, only when unresolvable from the ask/run;
- test-case decision: link-existing / create-new / skip, only when unresolvable;
- evidence exceptions (a screenshot flagged irrelevant in Pass 2).

When config + run context answer everything, **skip Phase B entirely** — the happy path
has exactly one interaction: the approval.

### Phase C — validate, one screen, one approval, write

1. **Dry-run validation** (build one spec JSON per issue — shape below):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js --spec <spec>.json
   ```
   This runs the whole gate: parent is a User Story, duplicate check (fails closed),
   cache-based picklist validation, attachment structural re-check, and a server-side
   `validateOnly` create. Exit 2 = blocked: surface the reasons (they include the valid
   options), get the correction — a failure-path round, not part of the happy path — and
   re-run the dry run. If a test-case action was chosen, dry-run it too
   (`testplan.js create-case …` / `testplan.js fail …` without `--execute`).
2. **Render THE consolidated screen** from the plan JSON — one message covering:
   template choice · parent story (id, title, state — validated) · severity + priority
   with the one-line reasoning · assignee · test-case decision · the ATTACH/REJECT list
   with reasons · **the exact write plan** (every intended write, in order, with its
   target route) · the explicit note that **nothing has been written yet**.
3. **One approval.** On the user's "yes":
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js --spec <spec>.json --execute
   node ${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/testplan.js create-case --plan <plan> --suite <suite> --title "<t>" --execute   # only if chosen
   node ${CLAUDE_PLUGIN_ROOT}/skills/test-design/scripts/testplan.js fail --plan <plan> --testcase <tc> --bug <bugId> --execute          # only if chosen
   ```
   On anything else: stop — zero writes. The write order inside `--execute` is fixed and
   fail-closed: re-validate → upload attachments → create Bug → link parent → one
   json-patch setting ReproSteps + evidence relations. First failure stops the sequence.
4. **Render the ledger.** Report every intended write as done (ID + URL) or not-done
   (reason), straight from the ledger JSON. A partial failure is reported as a **failure**
   with the exact board state — e.g. *"Bug #4711 was created (…/edit/4711) but the parent
   link was not added: <server message>. Nothing was retried; remediation is your call on
   the board."* Never soften a partial write into a success. If the failure JSON carries
   `cacheStale: true`, show the real options it contains and offer `--refresh-fields`.

## Spec JSON shape (for create-bug.js)

```json
{
  "title": "Concise defect statement",
  "severity": "2 - High",
  "priority": 1,
  "parentStoryId": 0,
  "assignedTo": "{{ASSIGNEE_EMAIL}}",
  "summary": "One-line summary shown in the Repro header",
  "steps": ["Step 1", "Step 2", "Step 3"],
  "expected": "What should happen",
  "actual": "What actually happened",
  "environment": "{{ENVIRONMENT}}",
  "bugCategory": "{{BUG_CATEGORY}}",
  "areaPath": "{{AREA_PATH}}",
  "iterationPath": "{{ITERATION_PATH}}",
  "testConfig": "Windows 11 / Chrome",
  "timestamp": "1/1/2026 3:00 PM",
  "attachments": ["executions/.../screenshots/ERROR.png"]
}
```

- `severity` / `priority` come from the gate (recommendation approved or user's pick) and
  are validated against the **project's** picklists — the script never invents them.
- `areaPath` / `iterationPath` default to the parent story's when omitted.
- Flags: `--allow-duplicate` (after the user's explicit go-ahead), `--no-screenshots`
  (deliberate, user-confirmed evidence waiver), `--force` (attachment structural-check
  override), `--refresh-fields` (rebuild the field cache).

## Notes

- The scripts need only Node (built-in modules) — no Azure CLI, no npm installs, works the
  same on Windows/macOS/Linux. Details of the REST routes and the field schema live in
  `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/references/azure-devops.md`.
- Keep spec files out of committed state (write them to a temp/execution folder).
- All board flows (bug filing, `/estimate-story`, `/design-test`) share the tracker scripts
  and the `.env` PAT — one setup covers them all.
