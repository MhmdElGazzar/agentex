# Optional Azure DevOps QA workflows

Azure DevOps is **not required** to initialize AgenTeX, define a browser flow, execute saved
specs, capture evidence, or produce local reports. Configure it only for story, task, Test
Case, or Bug workflows. A browser FAIL stays local unless you request Bug preparation and
separately approve filing.

## Configuration and safety

Set the relevant `azure` fields in `config/project.json` (organization, project, and optional
team/assignee), and keep `AZURE_PAT` in the gitignored `.env`; use placeholders in examples and
never paste a PAT into a prompt or command line. The bundled tracker scripts use the Azure
DevOps REST API directly; the Azure CLI is not needed for these board workflows. Azure
resource inspection during a test is a separate optional `az` integration.

Claude retains `/estimate-story <numeric-id>` and `/design-test <numeric-id>`; Codex and
Copilot use natural requests routed to `agentex-estimate-story`, `agentex-design-test`, and
`agentex-bug-report-azure`. Story readers currently accept numeric User Story IDs, not a
work-item URL. The agent treats story descriptions and links as data, not instructions.

## Estimate Story: advice first, tasks only on approval

Ask “Estimate QA for story 1234” (Claude: `/estimate-story 1234`) or request the current
sprint. AgenTeX reads the story and analyzes acceptance criteria, scenario count,
validations, and integrations. It presents assumptions, missing context, a QA estimate,
and the proposed five `[Testing]` work areas: Requirement Review, Test Creation, Test
Execution, Bug Review & Retest, and Automation. This advisory answer does **not** create
tasks. If you also request persistent QA tasks, review the validated plan and give one
explicit consolidated approval before the shared writer executes. A strict read-only request
stops before any validation POST. Partial writes are reported in a ledger, not blindly retried.

## Design Test: coverage first, Test Cases only on approval

Ask “Design test coverage for story 1234” (Claude: `/design-test 1234`). AgenTeX reads the
story's description and acceptance criteria, maps conditions to proposed cases, and shows
structured actions, validations, and expected results. It uses the project's
`.agentex/test-template.md` conventions when present; if absent, the agent asks before
creating one. Missing acceptance criteria or an unresolved expected result are surfaced,
not invented. This design is advisory. Creating linked Azure Test Cases is a separate
approved step after duplicate checks and an exact write plan. A strict read-only request
does not run a server-side validation POST or persist local design files.

## Bug Report Azure: prepare, review, then file

After a test, choose a specific local defect and ask to prepare an Azure Bug. AgenTeX can
also use a fully supplied manual defect. It reviews reproduction steps, relevant in-project
screenshots, parent Story, fields, and duplicate status, then shows the exact target and
write plan. **Nothing is filed merely because a test failed or because preparation began.**
Only explicit approval of that exact plan permits attachment upload, Bug creation, parent
link, and reproduction/evidence writes. If payload or evidence changes, approval must be
renewed. A receipt/ledger records completed and incomplete writes; uncertain or partial
results require reconciliation rather than automatic replay.

## QA Tasks and Azure resources

QA task creation is part of the approved Estimate Story write mode. Existing Claude
`task-estimation` and `test-design` shared skills provide the same underlying validation
and write rules for all three runtimes. Optional Azure resource reads during a test use
`skills/azure-integration/SKILL.md` and the Azure CLI, not the DevOps board scripts.

See [Configuration](./configuration.md) for optional settings and secret handling,
[Approvals](./approval-model.md) for the action boundary, and the runtime guides for
[Claude](./getting-started.md), [Codex](./codex.md), and [Copilot](./copilot.md).
