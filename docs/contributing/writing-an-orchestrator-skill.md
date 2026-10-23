# Writing an Orchestrator Skill

An **orchestrator** is a skill or agent that makes the decisions, hands the work to **workers**
(subagents: separate Claude instances, each with its own context), and then **merges** their
results, that is, combines what each worker returned into one outcome. This page explains how
to design one well in general, not only for AgenTeX, with examples from the project.

The rules come from the official Claude Code documentation
([Skills](https://code.claude.com/docs/en/skills) and
[Subagents](https://code.claude.com/docs/en/sub-agents)). The rules for writing any skill are in
[Writing a Good Skill](./writing-a-good-skill.md); this page adds what is specific to
orchestration.

---

## 1. Facts about subagents you need to know

The whole design rests on these facts. "Subagent" here means a **named subagent**: an agent
defined in `agents/` or `.claude/agents/`. Two other cases are covered in the last two rows: a
**fork subagent** (a subagent that is a copy of the main conversation) and a **forked skill** (a
skill with `context: fork`).

| Fact | What it means for the design |
|---|---|
| A subagent **cannot ask the user anything**: `AskUserQuestion` is removed from it even if it is listed in `tools` | Every question has to go back to the orchestrator |
| A subagent **starts with an empty context**: it does not see the conversation, the skills that ran, or the files that were read | Everything it needs has to be sent to it explicitly |
| Permission prompts **still reach the user**, even from a subagent running in the background | Approving a tool is not the same as approving the decision |
| A subagent can start other subagents, **up to 3 levels** below the main conversation | If you do not want that, remove `Agent` from its `tools` |
| Once **20 subagents are running** in the session (nested ones included), any further start **fails** with `Concurrent subagent limit reached`; there is no queue | That worker never runs, so the orchestrator has to send work **in batches** itself (the limit is set by `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) |
| `skills:` in an agent definition **puts the skill's whole content** into the agent when it starts (a **preload**) | Every worker pays for those tokens |
| A skill with `disable-model-invocation: true` **cannot be preloaded** into an agent. We have not found documented what happens to a preload that cannot be loaded; in our experience it is skipped without a visible error | Shared skills must not use that setting; a wrong preload can fail without anyone noticing, and the worker then runs without that knowledge |
| A **fork subagent** inherits the main conversation and gets exactly the same tool pool as the main conversation | The contract and deferred-question rules below are for named workers |
| A **forked skill** (`context: fork`) does **not** see the conversation history, runs in the background by default, and gets a narrower tool set | Like a named worker, it needs everything sent to it; it suits a self-contained task, not one that needs the user along the way |

---

## 2. First decision: where does the orchestrator live?

| If the orchestration… | Best fit |
|---|---|
| needs **the user along the way** (approvals, questions, checkpoints) | **A skill in the main conversation**, or an agent running as the **main session** (`agent` in the plugin's settings) |
| is **self-contained** and does not need the user | A forked skill (`context: fork`), or an agent sent as a subagent |
| needs a control flow that is **100% fixed** (loops, fan-out to many workers, a set number of retries) | **Scripts**, with the model only deciding |
| has rules that **must never be broken** | **Hooks** (a command Claude Code runs on its own at a set point, defined just below) that enforce them, not text alone |

A **hook** is a command Claude Code runs on its own at a set point, for example before each tool
call, whatever the model decides.

**Most real cases are hybrid:** a skill in the main conversation makes the decisions and talks
to the user, subagents do the work, scripts hold the fixed parts, and hooks guard the dangerous
rules.

**Examples from the project:**
- The `test-execution` skill lives in the main conversation, because its sequential mode is a
  series of checkpoints with the user (it stops for the user to confirm the scope and approve
  the plan). It routes each step to the driver that owns it (`browser-driver`,
  `api-integration`, `db-integration`). In parallel mode it sends `qa-executor` subagents as
  workers.
- An orchestrator can also run **inside a subagent** when it never asks a question and returns
  a single report at the end.

---

## 3. Principles

### 3.1 The orchestrator decides, the workers do the work
The orchestrator does not do the heavy work itself. Each worker takes an independent part and
returns a **summary**, so the main context stays clear for the merge decisions.

### 3.2 A clear contract for each worker
The **contract** is what the orchestrator and a worker agree on: what goes in and what comes out.
- **Inputs:** parameters with fixed names. The orchestrator puts them in the prompt, and the
  worker declares them at its top (for example `{{SESSION}}` and `{{TARGET_URL}}` in
  `agents/qa-executor.md`).
- **Output:** a fixed shape (JSON or a template), so the merge is mechanical and not a guess
  from free text.
- The output covers **every case**: success, failure, BLOCKED (the case could not be tested,
  for example because data was missing), and deferred questions.
- **Every status the worker can give** has to appear in the output and in the **tally** (the
  count of results per status). If the worker can return BLOCKED and the tally has only pass
  and fail, the merge has to dig for it in the text.

### 3.3 The worker does not ask, it defers
A **deferred question** is a question the worker returns as an item in its output instead of
asking it. The orchestrator collects all of them and asks them **at merge time**, before the
final report. An example from the project: **NEEDS-USER** in the `ui-check` skill.

### 3.4 Fixed state lives in scripts
Creating folders, IDs, session names, merging the results, and working out the final verdict.
The model decides; the script does it the same way every time. Examples: `init_run.js`,
`merge_run.js` and `write_verdict.js` in `skills/test-execution/scripts/`.

### 3.5 Explicit gates
A **gate** is a stop where the user approves before the run goes on. It is for writes that
**cannot be undone or that land outside the run** (a tracker, an external API, a delete). The
review checkpoints with the user are not gates. A run that writes only into its own folder has
no gate.

1. All reads and all validation happen first, **with no write at all**.
2. Then **one consolidated approval** of the whole write plan.
3. Then the writes, with a **ledger**: a record of every write that actually happened.

The consequence for the user: if validation fails, nothing has been written; and after the
approval, the ledger shows exactly what was written. Example: the one-gate pattern in the
`bug-report-azure`, `test-design` and `task-estimation` skills.

### 3.6 A written failure policy
- Define every status: FAIL, BLOCKED, FLAKY (failed, then passed on a retry)…
- Say when a retry happens, how many times, and for which kind of failure.
- Say what the orchestrator does when a worker **dies** or returns nothing.
- **Never resend a worker to get a cleaner result**: that is a hidden retry, and it hides an
  unstable result.

### 3.7 Dispatch
To **dispatch** is to start the workers.
- Independent workers are sent **in one batch**, so they run at the same time.
- A batch stays under the limit. Any start beyond 20 running subagents **fails and does not
  wait**, so with more workers than that, send them in batches, and treat a refused start as a
  dispatch failure with written handling.
- Work that shares state stays **in the same worker**, in order.
- Write the limits down: how many workers at a time, and when the next batch goes.

### 3.8 Shared knowledge: one source
- Rules that the orchestrator and the workers both need are **not copied** into each agent,
  because the copies drift apart over time.
- Preload them with `skills:` in the worker's definition, for example in a hypothetical worker:
  ```yaml
  ---
  name: browser-executor
  description: Runs one test file in its own browser session.
  tools: Bash, Read, Write, Glob, Grep
  skills:
    - agentex:test-execution
    - agentex:browser-driver
  ---
  ```
- Keep preloaded skills **small**, because they are copied in full into **every** worker.
- Knowledge needed only in some cases (such as `api:` or `db:` steps) is read **when the case
  comes up**, not preloaded.

### 3.9 Phases: each phase's detail when it starts
`SKILL.md` holds **only the names of the phases and the gates**. Each phase's detail is in
`references/procedures/<phase>.md`, read when that phase starts. A sequential run then pays no
tokens for the parallel details (see `skills/test-execution/references/procedures/`).

### 3.10 Dangerous rules are enforced by hooks
A written rule can be ignored. A rule whose breaking does harm (a destructive command, printing
a secret, a write outside the gate) is enforced by a **PreToolUse hook**: a hook that runs
before each tool call and can refuse it.
- A plugin ships hooks from `hooks/hooks.json`, or from the `hooks` field in `plugin.json`.
- Claude Code **ignores** `hooks` in the frontmatter of any agent that comes from a plugin, so
  such a hook never runs. Rules for workers need plugin-level hooks.
- In our experience a repo's `.claude/settings.json` **does not reach** the plugin's users (we
  have not found this documented). AgenTeX does not commit `.claude/` at all.

### 3.11 A record of each run
Each run saves what was sent, to whom, with which inputs, and what came back. Without that
record, a problem in the merge cannot be traced. Example: `run-summary.json`.

---

## 4. Layout

```text
orchestrator-skill/
├── SKILL.md
│   ├── Role
│   ├── Principles         ← the fixed rules (+ hooks for the ones that must never break)
│   ├── Concepts           ← statuses and terms
│   ├── Decisions          ← routing: which worker for which case, which mode
│   ├── Phases             ← phase names and gates only
│   ├── Worker contract    ← the inputs and the output shape
│   └── Resources          ← what to read when
├── references/procedures/<phase>.md   ← read only when that phase starts
└── scripts/               ← init / merge / verdict

agents/<worker>.md         ← Inputs + Output + skills: [shared-principles, driver]
hooks/hooks.json           ← blocks every forbidden action, reliably
```

---

## 5. Common mistakes

| Mistake | Why it is a problem | Fix |
|---|---|---|
| The orchestrator is itself a subagent and waits for an approval | It cannot ask | Make it a skill in the main conversation, or run the agent as the main session |
| All the detail of every phase in one `SKILL.md` | Tokens for phases that will not run | `references/procedures/` |
| The worker returns free text | The merge becomes a guess | A fixed output shape |
| A worker that says "ask the user" | It never happens | A deferred question |
| `{{PARAM}}` in the worker that the orchestrator never sends | The worker runs without that input | Check the contract from both sides |
| The same rules copied into the orchestrator and the worker | The copies drift apart | `skills:` preload |
| Preloading a skill that has `disable-model-invocation: true` | It cannot be loaded, and the worker runs without it | Remove the setting, or do not preload it |
| Preloading a skill that exists only in `.claude/skills` for a worker inside the plugin | Users do not have that skill | Put it in the plugin's `skills/` |
| `hooks` in the frontmatter of an agent inside the plugin | Claude Code ignores them | `hooks/hooks.json` |
| A batch bigger than the subagent limit | The extra starts fail; they do not wait | Batches |
| Safety rules as text only | They can be broken | A hook |
| Re-dispatching when you do not like the result | It hides the instability | Record it as FLAKY |

---

## 6. Review

Before merging an orchestrator, find its workers and check:
- **Where the orchestrator runs:** it must not be a forked skill (`context: fork`) that waits for
  the user (an error).
  An agent that waits for the user and is not clearly run as the main session is a warning. An
  orchestrator agent needs the `Agent` tool.
- **The contract:** every `{{INPUT}}` a worker expects is one the orchestrator names; inputs and
  output are declared; every status the worker gives (such as `**BLOCKED**`) appears in its
  output.
- **The preloads:** each exists (and for workers inside the plugin, exists in the plugin
  itself), is not `disable-model-invocation`, and is not bigger than it needs to be.
- **Copies:** no rule is copied between the orchestrator and a worker.
- **The hooks:** a rule that forbids a command has a PreToolUse hook enforcing it, and no plugin
  agent has `hooks` in its frontmatter (they are ignored).
- Everything a review needs to read: what starts the orchestrator, its reference files and
  where its hooks come from.
- Every check from [Writing a Good Skill](./writing-a-good-skill.md#9-test-it) on its `SKILL.md`.

**After any change:** try a real dispatch in a **fresh session**, and confirm the merge received
every worker's result and every deferred question.

---

## Quick checklist

- [ ] The orchestrator is in the main conversation (or runs as the main session) if it talks to the user.
- [ ] Every worker has declared Inputs and a fixed-shape Output.
- [ ] No worker asks the user; questions come back deferred.
- [ ] IDs, folders, the merge and the verdict are in scripts.
- [ ] One consolidated approval before any write that cannot be undone or lands outside the run.
- [ ] The failure and retry policy is written, including what happens when a worker dies.
- [ ] Shared knowledge is preloaded with `skills:`, not copied, and kept small.
- [ ] Each phase's detail is in `references/`.
- [ ] Dispatch goes in batches smaller than the subagent limit.
- [ ] Dangerous rules have a hook in `hooks/hooks.json` or `plugin.json`.
- [ ] Every run leaves a record.
- [ ] Every check in section 6 passes, or each warning has a written answer.
