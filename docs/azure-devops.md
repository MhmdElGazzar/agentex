# Azure DevOps QA

If your team tracks work in Azure DevOps, AgenTeX can estimate QA effort, generate test cases
from a story's acceptance criteria, file bugs it finds during a run, and reach Azure resources
mid-test — always with your confirmation before anything is written. Bug filing talks to the
ADO REST API directly through bundled scripts (no Azure CLI needed); the estimation and
test-design flows still drive the `az` CLI.

## One-time setup

1. Fill the `azure` block in `config/project.json` — `org`, `project`, `team`, `assignee`
   (legacy `AZURE_*` keys in `.env` still work). `org` accepts a full URL or a bare org name.
2. Put your PAT in `.env` as `AZURE_PAT=`. **That alone is enough for bug filing** — the
   bundled tracker scripts read it from `.env` themselves and send it only in the
   Authorization header; it is never printed, logged, or placed on a command line.
3. Only for `/estimate-story` and `/design-test` (still `az`-driven): install `az`
   (see `skills/azure-integration/references/azure-cli.md`), add the DevOps extension
   (`az extension add --name azure-devops`), and export the PAT in your shell:
   ```bash
   export AZURE_DEVOPS_EXT_PAT="$AZURE_PAT"
   ```

## Walkthrough: estimating a sprint

```
/estimate-story
```

Claude looks at your sprint's User Stories one at a time, proposes an hours estimate for each
(based on scenario count, fields, validations, integrations involved) — and **only after you
confirm that story** — creates 5 `[Testing]` tasks on it, all iteration-inherited and assigned:
Requirement Review, Test Creation, Test Execution, Bug Review & Retest, Automation. Nothing is
created without your say-so, and it never processes more than one story at a time without
checking in. Target specific stories with `/estimate-story 12345 12346`.

## Walkthrough: designing test cases

```
/design-test 12345
```

Claude reads the story's acceptance criteria, breaks them into test conditions, and creates
titled test cases in ADO with structured steps (Steps XML) — then links them **Tested By** the
story, and finishes with a coverage check (did every acceptance criterion end up covered?).
Your project's own conventions (persona, journey step map, setup steps, languages, extra
categories) live in `.agentex/test-template.md`, scaffolded automatically the first time this
runs.

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
(gitignored; commit it by appending `!.agentex/cache/` to `.gitignore`). Ask Claude to
"refresh the tracker field cache" — the scripts' `--refresh-fields` flag — after an admin
changes your process; if the server ever rejects a value the cache accepted, Claude shows
you the real current options and offers that refresh.

## Reaching Azure resources mid-run

Beyond DevOps, Claude can also read Azure resources directly during a run — logging in, discovering
resources, and checking a deployment, tailing App Service logs, reading a Storage blob or Key Vault
secret, getting AKS credentials — through the `az` CLI, e.g. "check if the latest deployment
succeeded" or "tail the app's logs."

## Quick reference

| Capability | Skill | Reference |
|---|---|---|
| Estimate QA effort (`/estimate-story`) | `skills/task-estimation/SKILL.md` | `references/tracker/ado-boards-cli.md` (plugin root) |
| Design test cases (`/design-test`) | `skills/test-design/SKILL.md` | `skills/test-design/references/test-case-mechanics.md`, `references/tracker/ado-boards-cli.md` |
| File bugs (`bug-report-azure`) | `skills/bug-report-azure/SKILL.md` | `skills/bug-report-azure/references/azure-devops.md` (REST routes + field schema) |
| Azure resources | `skills/azure-integration/SKILL.md` | `skills/azure-integration/references/azure-cli.md` |

Configuration: see [configuration](./configuration.md)
