# Azure DevOps QA

If your team tracks work in Azure DevOps, AgenTeX can estimate QA effort, generate test cases
from a story's acceptance criteria, file bugs it finds during a run, and reach Azure resources
mid-test — all through the `az` CLI, with your confirmation before anything is written.

## One-time setup

1. Install `az` (see `skills/azure-integration/references/azure-cli.md`), then add the DevOps
   extension:
   ```bash
   az extension add --name azure-devops
   ```
2. Fill the `azure` block in `config/project.json` — `org`, `project`, `team`, `assignee` (legacy
   `AZURE_*` keys in `.env` still work).
3. Authenticate: `az login`, or for non-interactive use export a PAT in your shell:
   ```bash
   export AZURE_DEVOPS_EXT_PAT=<your-pat>
   ```
   Claude never prints or passes the PAT anywhere.

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
**Bugs**. For each one it:
- suggests a **severity + priority** based on what was observed (you pick the final values),
- links it to the parent **User Story** (the only relation it ever adds, and only after
  validating the story exists),
- attaches and validates the screenshot evidence (structural check + a vision pass),
- optionally marks the related test case **Failed**,

then shows you everything as **one** consolidated confirmation before writing anything. Reads
run freely without confirmation; every write is first shown as the exact `az` command it would
run (a dry run) — nothing executes until you approve it, then it runs with the `--execute`
flag. Configuration comes from the `AZURE_*` keys in `.env`; anything unset is asked, never
guessed.

## Reaching Azure resources mid-run

Beyond DevOps, Claude can also read Azure resources directly during a run — logging in, discovering
resources, and checking a deployment, tailing App Service logs, reading a Storage blob or Key Vault
secret, getting AKS credentials — through the same `az` CLI, e.g. "check if the latest deployment
succeeded" or "tail the app's logs."

## Quick reference

| Capability | Skill | Reference |
|---|---|---|
| Estimate QA effort (`/estimate-story`) | `skills/task-estimation/SKILL.md` | — |
| Design test cases (`/design-test`) | `skills/test-design/SKILL.md` | `skills/test-design/references/test-case-mechanics.md` |
| File bugs (`bug-report-azure`) | `skills/bug-report-azure/SKILL.md` | `skills/bug-report-azure/references/azure-devops.md` |
| Azure resources | `skills/azure-integration/SKILL.md` | `skills/azure-integration/references/azure-cli.md`, `azure-devops-cli.md` |

Configuration: see [configuration](./configuration.md)
