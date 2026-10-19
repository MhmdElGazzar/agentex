---
name: task-estimation
description: |
  Creates QA testing tasks with estimation on the configured tracker's User Stories — Azure DevOps or Jira Cloud. Reads the sprint, analyzes each story, then creates all [Testing] tasks (ADO Tasks or Jira sub-tasks) behind ONE consolidated approval, through bundled REST scripts (no Azure CLI, no acli). Use this skill whenever the user wants to:
  - Add QA tasks to sprint stories in Azure DevOps or Jira
  - Estimate testing hours for user stories
  - Create [Testing] tasks on ADO work items or [Testing] sub-tasks on Jira issues
  - Plan QA effort for a sprint
  - Break down stories into testing tasks with hours
  Trigger on phrases like: "create tasks for stories", "add QA tasks", "estimate sprint", "estimate the Jira sprint", "create testing tasks", "create tasks for Jira sprint stories", "add sub-tasks to Jira stories", "plan QA for sprint", "add tasks to stories", or any mention of sprint stories + estimation + testing.
---

> **AgenTeX on OpenAI Codex.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), spawn a native subagent and give it the body of `<agentex-root>/references/agents/<name>.md` as its instructions, plus the values this file says to inject. Steps that reach the network (`curl`, `az`, `sqlcmd`, `playwright-cli` on a remote site, the tracker scripts) need network access: if the sandbox blocks one, ask the user to approve it; never skip the step or report it as passed.

# QA Task Estimation & Task Creation

## Role
You turn a sprint's stories into estimated QA `[Testing]` tasks on the configured tracker,
created as the tracker's child tasks of each story. Which tasks, how many, in what order and
within which hour ranges is the project's `config/estimation.json` — the user's file. Your one
estimation judgment is a 0–4 rating per factor; the script turns ratings into hours. You never
write to the board, or create that file, without the single consolidated approval below.

The mechanics live in ONE bundled script — never run a tracker CLI or compose REST calls for
board operations; the script owns transport, auth, and every number:

- **`<agentex-root>/skills/task-estimation/scripts/create-tasks.js`** — the `estimation`
  read (the file, or a first-run proposal built from the team's own history), sprint/story
  reads, the fail-closed dry run that derives each story's tasks and hours from your ratings,
  and the writes. The script resolves the configured tracker itself; dry run by default; one
  JSON line; exit 0/1/2.
- **The configured provider's reference** — read it before interpreting script JSON in a
  session: `<agentex-root>/references/tracker/ado-boards.md` (Azure DevOps) or
  `<agentex-root>/references/tracker/jira-boards.md` (Jira), section *Estimation
  flow*. It holds the provider's configuration keys, what its child tasks, hours, placement
  and first-run history read look like, and the provider rules on top of this workflow.

## Configuration (never hardcode)

Every setting resolves from `config/project.json`'s tracker block — the reference's
*Estimation flow* section lists the keys and any fallbacks. Never bake an organization,
site, project, team, or email into anything. Anything missing joins the ONE bundled
question round (Phase B) — never a drip of questions.

- **Assignee**: from the spec, or a single configured value — never invented; several
  configured values → ask which one.
- **Credentials** live in `.env`. The script reads them itself and sends them only in the
  Authorization header. **Never** read, print, or pass them.
- Run-only overrides and corrected values are for the run only — they never rewrite the
  user's config.

## The estimation file

`config/estimation.json` belongs to the user and is committed with their project:

| Field | What it holds |
|---|---|
| `tasks[]` | `{ "name", "enabled", "minHours", "maxHours" }` — every story's `[Testing]` tasks: names, count, order, and each task's hour range. Only enabled tasks are created. |
| `factors` | `"<factor>": <weight>` — what each story is rated on. Weight 0 = rated and shown, not counted. |
| `source` | Where the numbers came from (sprints read, tasks counted/skipped, date). A record — editing it changes nothing. |
| `schemaVersion` | `1` |

- The plugin creates the file **once**: only through the script, only on the user's approval
  of a first-run proposal, and never over an existing file. After that it is the user's —
  never edit, repair, reformat, recreate or replace it, and never write it with your own
  tools. Gate adjustments are for the run only.
- A hand edit (names, count, order, ranges, `enabled`, factors) applies on the next run with
  no prompt. To rebuild the file from the board's history, the user deletes or moves it; the
  next run proposes a new one.
- The script titles every task `[Testing] <name>` and never doubles the prefix.

## Rating factors

Rate **every** factor the file lists (on a first run, the proposal's `content.factors`) —
never one it does not list, never skip one — with a whole number 0–4, relative to this team's
typical story:

| Rating | Anchor |
|---|---|
| 0 | none of this in the story |
| 1 | light, well below a typical story |
| 2 | typical |
| 3 | heavy, clearly above typical |
| 4 | the most this team sees |

What to look at for the default factors (rate a user-added factor from its name):

| Factor | What to look at |
|---|---|
| Scenarios / ACs | Given/When/Then scenarios |
| UI elements | Fields, buttons, dropdowns, toggles |
| Validations | Inline errors, required fields, min/max rules |
| Conditions / logic | Branching behavior, default states, toggles |
| Error messages | Inline errors + toasts + API failures |
| API integrations | External service calls (identity verification, maps, etc.) |
| Translations | EN/AR string pairs |
| Edge cases | Explicitly listed failure modes |

- Story points are context only — there are no complexity buckets.
- Never compute, round or pick hours. The script scores the ratings (weighted) and places
  each task's hours inside its range: lowest on every factor → each task's min, highest on
  every factor → each task's max, in between on half-hours.

## Workflow — three phases, ONE approval

### Phase A — collect & read (no user interaction, no writes)

Scratch files (the proposal, the spec) go in the OS temp dir. Get its absolute path once with
`node -p "require('os').tmpdir()"` and write that path in full wherever `<os-temp>` appears
below. Never use a shell variable such as `$TMP` for it: it is unset on some systems.

1. **The estimation file, first:**
   ```bash
   node <agentex-root>/skills/task-estimation/scripts/create-tasks.js estimation --out "<os-temp>/estimation-proposal.json" [--sprints N]
   ```
   `--out` is an OS-temp scratch file (like the spec), never a project path; the script
   refuses a path that holds anything but a previous proposal. Pass
   `--sprints N` only when the user's ask names how many past sprints to read (default 2).
   Branch on `source`:
   - `file` → use its `content`: the enabled tasks and the factors.
   - `invalid` (exit 2) → **stop the run.** Relay the file, every problem and its offending
     entry, and that nothing was read or written. Read no stories, show no estimate, fall
     back to nothing, and never fix the file yourself — the user edits it.
   - `proposal` (no file yet) → a first run. Note its `kind`: `history` (from the team's last
     closed sprints) or `starter-defaults` (with `provenance.reason` and `reasonMessage`).
   - Exit 2 asking for the team (ADO) or carrying board `options` (Jira) → that question
     joins Phase B; re-run with `--team "<name>"` / `--board "<id|name>"`.
2. Read the stories:
   ```bash
   node …/create-tasks.js stories --current-sprint --full
   ```
   (or `stories --ids <ID,ID> --full` when the ask names specific stories). The JSON carries
   each story's title/state/SP, the provider's placement facts (see the reference), the
   description + AC HTML, and any `existingTestingTasks` — note which stories already have
   `[Testing]` children.
   - If the sprint read reports more than one candidate sprint, that choice joins the one
     bundled round (Phase B) — never pick silently.
   - A sprint read that blocks is relayed with its fix (the message names it); offer
     `--ids` for named stories — never guess a sprint.
3. Rate each story on every factor. When `storyPoints` is null and the row carries a note
   about it, relay that note (it names the config override). The **analysis stays
   per-story**; only the approval is consolidated.

### Phase B — ONE bundled input round, only if needed

Ask **one** message (numbered questions with lettered options; then stop and wait for the reply) carrying every open question at once, **before** validation, when
anything is genuinely unresolvable:

- a required setting the script reports missing (the team for the sprint or the history
  read, the assignee);
- the sprint to use when the read reports several;
- the board whose past sprints to read (Jira);
- a blocked entry that carries `options`;
- stories that already have `[Testing]` tasks (skip, or add anyway?).

A choice
that comes with `options` is asked with those real options. Nothing about a first-run
proposal is asked here: its abnormal values belong on the consolidated screen. When config +
the reads answer everything, skip Phase B: the happy path has exactly one interaction — the
approval.

### Phase C — validate, one screen, one approval, write

1. Build the **ratings spec** (stories the user chose to skip are absent), write it to the OS
   temp dir, and dry-run it:
   ```json
   { "assignee": "qa.engineer@example.com",
     "estimation": { "proposalFile": "<the --out file>" },
     "stories": [ { "id": 2101, "ratings": { "Scenarios / ACs": 1, "UI elements": 2, "…": 0 } } ] }
   ```
   ```bash
   node …/create-tasks.js --spec "<os-temp>/tasks.json" [--allow-existing]
   ```
   `estimation.proposalFile` is for a first run only. Never send `tasks` or hours — the script
   derives them (`tasks-not-from-file` otherwise). Add these only on the user's words:
   - `estimation.outlierChoices` — `{ "<past task ref>": "count" | "suggested" | <hours> }`
   - `estimation.taskEdits` (first run) — `{ "<task>": { "enabled" | "minHours" | "maxHours" } }`
   - per story `adjust` — `{ "<task>": <hours> | "skip" }`, this run only

   Exit 2 = blocked: rating findings (`missing-rating`, `unknown-factor`, `bad-rating`) are
   yours — fix the spec and re-run. A value the user typed that the script rejects
   (`bad-outlier-choice`, `bad-task-edit`, `bad-adjustment`) is asked again in the same round.
   Validation findings carry allowedValues / existing-task IDs / stale-cache options with a
   `--refresh-fields` offer; a blocked entry with `options` is a user choice — ask it with the
   real options. An unresolvable or ambiguous assignee blocks — ask, never assign blind.
   `estimation-file-exists` means a file appeared since Phase A: re-run Phase A.
2. Render **the consolidated screen** from the plan JSON's `estimation` block and `plan`:
   - **The file.** With a file: one line, *"Using config/estimation.json — N enabled tasks,
     M factors."* On a first run, the proposal. Show where it came from (`provenance`): the
     sprints read (and that fewer exist, when fewer were read), stories read, tasks counted,
     tasks skipped (no Original Estimate, or no task name after the `[Testing]` marker), names
     found without any estimate, and a truncated read. Show each proposed task with the stories it was found on and its min/max
     (`groups`), and the factors. Starter defaults instead say: *"No usable history — <reasonMessage>. Proposed
     starter defaults (not your team's history): …; deleting the file later re-proposes from
     your board."*
   - **Abnormal values**, only when `outliers` is non-empty. Show each with its task, value,
     story (ID and title), the past task's ref, the usual range (`normalRange`), and the value
     now in use (the suggested one, until the user chooses). Offer exactly three choices:
     count it · use the suggested value · type a number. The outlier threshold is a tunable default, not a
     guarantee. No section when nothing is flagged.
   - **Per story**: ID, title, SP, every factor's rating, the score (`scorePct`), each task's
     hours (an `adjusted` value labelled "adjusted", and "outside <min>–<max> h" when it is),
     and the story total.
   - The sprint total, the assignee (as the dry run resolved it, including any tracker
     identity), any "adding despite N existing `[Testing]` tasks" notes, how the hours will be
     recorded and any notes the dry run reports (`validation.hours` with its message,
     `validation.notes`).
   - **The exact write plan**, in order — `create config/estimation.json (new file)` first on
     a first run, then every task create and follow-up step with its route, parent link
     inline — and the statement that **nothing has been written yet**.

   Any outlier choice, typed number, task edit, adjustment or rating correction updates the
   spec, re-runs the dry run and re-renders the screen — it still ends in exactly one
   approval.
3. **One approval** ("yes" / "تمام" / "approved") → re-run with
   `--execute --basis <estimation.basis>`. Anything else → stop: neither the file nor any task
   is written.
4. **Render the ledger**: the file line (on a first run) and every intended task — done (ID +
   URL) or not-done (reason). A partial failure is a **failure** — name exactly what now
   exists (the file, which tasks); no retry, no cleanup — remediation is the user's call. If
   the file line failed because a file appeared, say it was not replaced and no task was
   created.

## Rules

- **One gate**: all reads (stories and history) + validation first, ONE consolidated screen
  for the whole run (analysis per story, approval once), then writes. Never create — a task or
  the file — without that approval.
- `config/estimation.json` is the user's: never write, edit, repair or replace it with your
  own tools. With the file present, history is never read (the script enforces it).
- Never read or take hours from descriptions, completed work or remaining work — only the
  script's numbers. Defaults are always labelled as defaults, with their reason.
- Rate every factor the file lists; never compute or round hours.
- Never run a tracker CLI (or compose your own REST calls) for board operations — the
  script owns transport and auth on every tracker.
- Never read `.env*` or handle a credential value — the script reads credentials itself,
  header-only.
- Placement (sprint/iteration/area) comes from each parent story through the script —
  never ask for it and never accept spec overrides.
- A blocked entry that carries `options` is a user choice — ask it with the real options
  (in the one bundled round, or the failure-path round after a dry run); never pick
  silently.
- At most ONE bundled question round before validation; missing config values are asked
  there once and corrections apply to the run only (the config is never rewritten).
- No retries, no cleanup writes — a partial result is reported exactly, from the ledger.

## Example interaction

```
User: estimate the sprint
Bot: [estimation → no file; stories read; each story rated silently, then ONE screen:]
     Estimation file: none yet — proposed from your last 2 closed sprints (Sprint 41, Sprint 42):
       12 stories · 47 [Testing] tasks counted · 3 skipped (no Original Estimate or no task name)
       Task                  found on     min   max
       Requirement Review    12 stories   0.5   2
       Test Execution        12 stories   1     3     (1 abnormal value below)
       …                     Factors: the default eight, weight 1 each
     Abnormal values (only these need a choice; the suggested value is in use now):
       1. Test Execution — 12 h on #4512 "Checkout address form" (task #4520); usual range 1–3 h
          → count it · use the suggested 3 h · type a number
     #2101 Contact preferences (3 SP) — Scenarios 1 · UI 2 · Validations 0 · … → score 19%
          Requirement Review 1 · Test Creation 1.5 · Test Execution 1.5 · Bug Review 1 · Automation 1.5 = 6.5 h
     …  Sprint total 24.5 h · Assignee qa.engineer@example.com
     Write plan: 1. create config/estimation.json (new file) · 2–16. 15 task creates (routes …)
     Nothing has been written yet. Approve?
User: تمام
Bot: [--execute --basis …] ✅ config/estimation.json created · 15/15 tasks created — IDs + URLs listed.
```
