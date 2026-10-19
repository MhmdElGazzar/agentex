---
name: estimate-sprint
description: "Estimate QA effort for every User Story in the current sprint on the configured tracker (Azure DevOps or Jira) and create their `[Testing]` tasks from the project's `config/estimation.json` (proposed from your team's last closed sprints on the first run), behind ONE consolidated approval."
disable-model-invocation: true
---

> **AgenTeX on OpenAI Codex.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), spawn a native subagent and give it the body of `<agentex-root>/references/agents/<name>.md` as its instructions, plus the values this file says to inject. Steps that reach the network (`curl`, `az`, `sqlcmd`, `playwright-cli` on a remote site, the tracker scripts) need network access: if the sandbox blocks one, ask the user to approve it; never skip the step or report it as passed.

Use the **task-estimation** skill to estimate and create QA testing tasks for the whole current
sprint on the configured tracker (Azure DevOps or Jira).

Run notes: (the argument text the user typed after the command's name)

- The arguments carry run notes only: which open sprint (Jira, when several are open), the
  team (Azure DevOps), or how many past sprints the first-run proposal reads. If they name
  story IDs or issue keys instead, say that `$agentex:estimate-story <ids>` estimates named stories,
  and stop without reading anything.
- The stories are the current sprint's (`stories --current-sprint`), read through the skill's
  bundled script (`skills/task-estimation/scripts/create-tasks.js`) — never `az` or `acli`,
  never hand-composed REST.
- Same flow, same file, same gate as `$agentex:estimate-story`: the script's `estimation` read first
  (`config/estimation.json`, or a first-run proposal from the team's last closed sprints),
  then the skill's three phases — at most ONE bundled question round, ONE consolidated screen,
  and the user's approval before `--execute`. Never edit the file; never write without the
  approval.
- Report the result from the script's ledger; a partial result is a failure, and remediation
  is the user's call.
