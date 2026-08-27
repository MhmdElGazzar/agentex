# Azure DevOps QA

If your team tracks work in Azure DevOps, AgenTeX can estimate QA effort, generate test cases
from a story's acceptance criteria, file bugs it finds during a run, and reach Azure resources
mid-test — always with your confirmation before anything is written. Every ADO flow — bug
filing, estimation, test design, test-plan updates — talks to the ADO REST API directly
through bundled scripts; no Azure CLI is needed for any of them. (`az` remains only for
reaching Azure *resources* mid-run, below.)

## One-time setup

1. Fill the `azure` block in `config/project.json` — `org`, `project`, `team`, `assignee`
   (legacy `AZURE_*` keys in `.env` still work). `org` accepts a full URL or a bare org name.
2. Put your PAT in `.env` as `AZURE_PAT=`. **That's the whole setup** — the bundled tracker
   scripts read it from `.env` themselves and send it only in the Authorization header; it
   is never printed, logged, or placed on a command line.

## Walkthrough: estimating a sprint

```
/estimate-story
```

Claude reads your sprint's User Stories (or the ones you name: `/estimate-story 12345 12346`)
and analyzes each one — scenario count, fields, validations, integrations → a complexity
bucket and the hours for the 5 `[Testing]` tasks: Requirement Review, Test Creation, Test
Execution, Bug Review & Retest, Automation. Anything genuinely open (no assignee configured,
a story that already has `[Testing]` tasks — skip it or add anyway?) is asked in at most
**one** bundled question round. Then it validates everything with zero board writes — each
story really is a User Story, iteration/area inherited fresh from the story, field values
checked against **your project's real values**, the create pre-validated server-side — and
shows you **one consolidated screen**: every story's analysis and per-task hours, the sprint
total, and the exact write plan. Nothing has been written yet.

**One approval** creates all the tasks — one atomic create per task, parent link included,
so an unparented `[Testing]` task cannot exist. If anything fails partway you get an exact
ledger — every intended task shown as done (ID + URL) or not done (reason) — and nothing is
retried or cleaned up without you.

## Walkthrough: designing test cases

```
/design-test 12345
```

Claude reads the story's acceptance criteria, breaks them into test conditions, and titles
one test case per condition. Your project's own conventions (persona, journey step map,
setup steps, languages, extra categories) live in `.agentex/test-template.md`, scaffolded
automatically the first time this runs; anything the conventions and config can't answer is
asked in at most **one** bundled question round. Then it validates with zero board writes —
the story really is a User Story, duplicate titles checked against the board (a duplicate
check that *can't* complete blocks — it never proceeds blind), structured steps compiled to
Steps XML by the script — and shows you **one consolidated screen**: the conditions table
(with what each case covers), the titled cases with step summaries, the duplicate-check
results, and the exact write plan. Nothing has been written yet.

**One approval** creates the test cases — one atomic create per case with the **Tested By**
link to the story included, so an unlinked case cannot exist. Partial failures produce the
same exact ledger as above, and the flow finishes with a coverage check built from the
ledger plus a fresh story read (did every acceptance criterion end up covered?).

## Walkthrough: filing a bug after a run

Once a test/regression run has turned up defects, ask Claude to file them as Azure DevOps
**Bugs**. Filing runs entirely through bundled Node scripts over the ADO REST API — it works
without `az` installed, and the PAT comes straight from `.env`. For each defect Claude:

- resolves everything it can from your config and the run itself (template, parent story,
  assignee options, environment), asking at most **one** bundled question round for anything
  genuinely open,
- validates before touching the board: the parent **User Story** exists, no same-title
  duplicate (a duplicate check that *can't* complete blocks the filing — it never proceeds
  blind), severity/priority and custom picklists checked against **your project's real
  values**, screenshots validated structurally and by a vision pass,
- then shows you **one consolidated screen**: the validated fields, the recommended
  severity/priority with its reasoning, the evidence list, and the exact write plan —
  nothing has been written yet.

**One approval** executes the writes in a fixed, fail-closed order: upload attachments →
create the Bug → link the parent story (the only relation it ever adds) → set the repro
steps and evidence. If anything fails partway you get an exact ledger — every intended
write shown as done (ID + URL) or not done (reason), with any created IDs always named —
and nothing is retried or cleaned up without you. Optionally the related test case is
marked **Failed** (or a new one created) under the same single approval.

Valid picklist values are cached per project in `.agentex/cache/tracker-fields-ado.json`
(gitignored; commit it by appending `!.agentex/cache/` to `.gitignore`). All three
validating flows — bug filing, estimation, and test design — check their field values
against it before any write. Ask Claude to "refresh the tracker field cache" — the scripts'
`--refresh-fields` flag — after an admin changes your process; if the server ever rejects a
value the cache accepted, Claude shows you the real current options and offers that refresh.

## Reaching Azure resources mid-run

Beyond DevOps, Claude can also read Azure resources directly during a run — logging in, discovering
resources, and checking a deployment, tailing App Service logs, reading a Storage blob or Key Vault
secret, getting AKS credentials — through the `az` CLI, e.g. "check if the latest deployment
succeeded" or "tail the app's logs."

## Quick reference

| Capability | Skill | Reference |
|---|---|---|
| Estimate QA effort (`/estimate-story`) | `skills/task-estimation/SKILL.md` | `references/tracker/ado-boards.md` (plugin root) |
| Design test cases (`/design-test`) | `skills/test-design/SKILL.md` | `skills/test-design/references/test-case-mechanics.md`, `references/tracker/ado-boards.md` |
| File bugs (`bug-report-azure`) | `skills/bug-report-azure/SKILL.md` | `skills/bug-report-azure/references/azure-devops.md` (REST routes + field schema) |
| Azure resources | `skills/azure-integration/SKILL.md` | `skills/azure-integration/references/azure-cli.md` |

Configuration: see [configuration](./configuration.md)
