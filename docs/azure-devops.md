# Azure DevOps QA

Skills that bring AgenTeX into Azure DevOps: **QA effort estimation**, **test-case design**, and
**bug filing** — plus an **Azure resource** helper for reaching cloud resources mid-run. All go
through the `az` CLI.

## Setup (one-time)

1. Install `az` (see `skills/azure-integration/references/azure-cli.md`), then add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
2. Fill the `AZURE_*` keys in `.env` — `AZURE_URL` (org URL), `AZURE_PROJECT`, `AZURE_TEAM`, `AZURE_ASSIGNEE`.
3. Authenticate: `az login`, or for non-interactive use export a PAT in your shell:
   ```bash
   export AZURE_DEVOPS_EXT_PAT=<your-pat>
   ```
   The agent never prints or passes the PAT.

## Estimate QA effort — `/estimate-story`

Analyzes your sprint's User Stories, proposes an hours estimate per story (based on scenarios,
fields, validations, integrations…), and — **after you confirm each one** — creates 5 `[Testing]`
tasks on it, iteration-inherited and assigned:

> Requirement Review · Test Creation · Test Execution · Bug Review & Retest · Automation

```
/estimate-story                 # the current sprint's stories
/estimate-story 12345 12346     # specific stories
```

The agent processes **one story at a time** and never creates tasks without your confirmation.

- Skill: `skills/task-estimation/SKILL.md`

## Design test cases — `/design-test`

Analyzes a story's acceptance criteria into test conditions, maps them to titled test cases, creates
them in ADO with structured steps (Steps XML), and links them **Tested By** to the story — ending
with a coverage check.

```
/design-test 12345
```

Project conventions (persona, journey step map, setup steps, languages, extra categories) live in
your project at `.agentex/test-template.md`, scaffolded from the bundled template on first run.

- Skill: `skills/test-design/SKILL.md`
- Mechanics: `skills/test-design/references/test-case-mechanics.md`

## File bugs found during a run — `bug-report-azure`

After a test/regression run turns up defects, this skill files them as Azure DevOps **Bugs** via the
`az` CLI — with one human confirmation before anything is written. For each selected defect it:

- recommends a **severity + priority** from the observed impact (you choose the final values),
- links the bug to its parent **User Story** (validated first — the only relation it ever adds),
- validates screenshots (structural check + a vision pass) and **attaches** them,
- optionally records a **Failed** outcome on the related test case,

all rolled into **one** consolidated confirmation. Reads run freely; every write is a dry run that
prints the exact `az` command until you approve, then executes with `--execute`. Config comes from
the `AZURE_*` keys in `.env`; anything unset is asked, never guessed.

- Skill: `skills/bug-report-azure/SKILL.md`
- Reference: `skills/bug-report-azure/references/azure-devops.md`

## Reach Azure resources mid-run

The `azure-integration` skill lets a test/QA run reach Azure via `az` — login/auth, discovery, and
reading App Service, Storage, Key Vault, and AKS resources (e.g. verify a deployment, tail app logs,
read a blob/secret, get AKS credentials).

- Skill: `skills/azure-integration/SKILL.md`
- Reference: `skills/azure-integration/references/azure-cli.md`, `azure-devops-cli.md`

## Reference

- Configuration: see [configuration](./configuration.md)
