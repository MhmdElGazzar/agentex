# Tool: azure-devops CLI (`az boards` / `az devops`)

The Azure DevOps extension for the Azure CLI. Read this before the first `az boards` / `az devops`
command in a session, or when one behaves unexpectedly. For installing/authenticating `az` itself,
see the sibling reference `azure-cli.md`. Used by the **task-estimation** and **test-design**
skills.

## Preflight & install
- Preflight: `az extension show --name azure-devops` (verify the extension is present).
- If missing: `az extension add --name azure-devops`.
- Base CLI: `az --version` (install per the azure-integration reference if absent).

## Auth (never put a PAT on the command line)
- Interactive: `az login`, then the extension uses that session.
- Non-interactive / CI: export a PAT as an env var **in the shell** — the extension reads it:
  `AZURE_DEVOPS_EXT_PAT` (set by the user; the agent never echoes or passes it).
- ⚠️ Do NOT pass a PAT as a flag — it leaks into history/logs and is blocked as a credential leak.

## Configure defaults (once per session)
Avoids repeating `--org` / `--project` on every command. Use the resolved config values:
```bash
az devops configure --defaults \
  organization="$AZURE_URL" \
  project="$AZURE_PROJECT"
```

## Current iteration (fetch dynamically — never hardcode)
```bash
ITER=$(az boards iteration team list --team "$AZURE_TEAM" \
  --timeframe current --query "[0].path" -o tsv)
echo "$ITER"   # e.g. My Project\Sprint 24
```
Iteration path format is `<Project>\<Sprint Name>`. Child tasks inherit the parent story's iteration.

## Fetch sprint stories (WIQL)
```bash
az boards query --wiql "SELECT [System.Id], [System.Title], [System.State], [Microsoft.VSTS.Scheduling.StoryPoints] FROM WorkItems WHERE [System.WorkItemType] = 'User Story' AND [System.IterationPath] = @CurrentIteration('[<Project>]\<Team>') ORDER BY [System.Id]" \
  --query "[].{id:fields.\"System.Id\", title:fields.\"System.Title\", state:fields.\"System.State\", sp:fields.\"Microsoft.VSTS.Scheduling.StoryPoints\"}" -o table
```
> ⚠️ `@CurrentIteration('[Project]\Team')` needs the **team** name, not just the project —
> e.g. `[My Project]\My Project Team`.

## Inspect a story
```bash
az boards work-item show --id <STORY_ID> --expand all -o json     # description + ACs to analyze
```

## Check for existing child tasks (before creating)
```bash
az boards work-item show --id <STORY_ID> --expand relations \
  --query "relations[?contains(rel,'Hierarchy-Forward')].url" -o json
```
If child tasks already exist, tell the user and ask whether to skip or add more.

## Create a task + link to parent
```bash
TID=$(az boards work-item create --type "Task" \
  --title "[Testing] Test Creation" \
  --iteration "$ITER" \
  --assigned-to "$AZURE_ASSIGNEE" \
  --fields "Microsoft.VSTS.Common.Activity=Testing" \
           "Microsoft.VSTS.Scheduling.OriginalEstimate=2" \
           "Microsoft.VSTS.Scheduling.RemainingWork=2" \
  --query "id" -o tsv)

# Parent link (Parent = Hierarchy-Reverse)
az boards work-item relation add --id "$TID" --relation-type "Parent" --target-id <STORY_ID>
```
> ⚠️ Never omit `--iteration` or `Activity=Testing` — the two most common oversights.

## Delete (destructive — confirm first)
Tasks can be deleted (unlike Test Cases):
```bash
az boards work-item delete --id <id> --yes
```

## Notes
- `-o table | json | tsv` controls output; `--query "<JMESPath>"` filters.
- Mandatory task fields at a glance: `--type Task`, `--title "[Testing] …"`, `--iteration`,
  `--assigned-to`, `Activity=Testing`, `OriginalEstimate`, `RemainingWork`, parent link.
