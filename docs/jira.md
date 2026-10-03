# Jira QA

If your team tracks work in Jira Cloud, AgenTeX runs the same QA flows it runs on Azure
DevOps — estimate QA effort, design test artifacts from a story's acceptance criteria, and
file bugs found during a run — always with **one consolidated approval** before anything is
written. Every Jira flow talks to the Jira Cloud REST API (v3) directly through bundled
scripts over Node's built-in fetch; no Atlassian CLI (`acli`) and no npm installs are
needed. A project uses **one** tracker: the setup wizard asks which (Azure DevOps, Jira, or
none) once, and only that provider's block is written — never a silent default. Using Azure
DevOps instead? See [azure-devops.md](./azure-devops.md).

## One-time setup

The `/init-test` wizard is the easy path — pick **Jira Cloud** at the tracker question and
fill the fields; it writes the `jira` block and routes the credentials to `.env`. Manually,
the same shape is:

1. Fill the `jira` block in `config/project.json`:

   ```json
   {
     "jira": {
       "site": "yourteam",
       "project": "PROJ"
     }
   }
   ```

   - `site` — your Jira Cloud site: a bare name becomes `https://<name>.atlassian.net`, a
     full URL is used as-is. `project` — the project **key** (e.g. `PROJ`).
   - Optional: `board` (steers sprint discovery when more than one sprint is open),
     `assignee` (default assignee email(s), comma-separated), and the documented overrides
     `storyType` (default `Story`), `subtaskType`, `bugLinkType`, `storyPointsField`,
     `acceptanceCriteriaField`.
   - There is **no `.env` fallback for these non-secrets** — they live in the config block
     only.

2. Put your credentials in `.env`:

   ```
   JIRA_EMAIL=you@example.com
   JIRA_API_TOKEN=
   ```

   The token is an **Atlassian API token**: create one at
   **id.atlassian.com → Security → API tokens** ("Create API token"). The bundled scripts
   read both values from `.env` themselves and send them only in the Authorization header
   (`Basic base64(email:token)`); neither is ever printed, logged, or placed on a command
   line — the email is treated as credential material too.

That's the whole setup — the same permission rule (`Bash(node:*)`) that covers the ADO
flows covers every Jira flow; nothing new to allow.

## What your Jira project needs

A brand-new Jira project usually misses one of these. You don't have to check up front:
each flow detects a missing piece at run time, before writing anything, and tells you
the fix.

- **Sprints** (for `/estimate-story` on the current sprint): a Kanban board has no
  sprints. In a team-managed project turn on **Project settings → Features → Sprints**;
  in a company-managed project use a **Scrum** board. Then **start** a sprint that holds
  the stories. You can also skip sprints and estimate specific stories by key.
- **Time tracking** (estimated hours on the `[Testing]` sub-tasks): time tracking must be
  on for the site (**Settings → Work items → Time tracking**), and the sub-task type must
  carry the **Time tracking** field (team-managed: **Project settings → Work types →
  Subtask**).
- **A Bug type** (bug filing): add **Bug** to the project's work types if it isn't there.

Menu names differ slightly between Jira versions ("Issues" vs "Work items").

## What each flow does on Jira

### `/estimate-story` — QA effort as sub-tasks

The same estimation methodology and the same five `[Testing]` tasks per story — created as
**sub-tasks** of each story, with the hours mapped to Jira **time tracking**
(`originalEstimate`/`remainingEstimate`) and the label `testing`. The current sprint
resolves via JQL (`sprint in openSprints()`); when several sprints are open, the run blocks
with the real sprint names and asks which one (set `jira.board` to steer it permanently).
The project's sub-task type is discovered from create metadata — exactly one → used;
several → asked once and pinned via `jira.subtaskType`. Assignee emails resolve to Jira
accountIds at validation time, shown on the consolidated screen. Sub-tasks ride their
parent story's sprint — there is no iteration/area to set.

### `/design-test` — test artifacts, your choice of type

Jira has **no native Test Case work-item type**. Before building anything, AgenTeX tells
you exactly that and asks **what to create** — the options are your project's real issue
types (sub-task types marked), plus "document only / skip creation". Steps render as an
ordered action → expected list in the artifact's description (Atlassian Document Format,
composed by the scripts). Non-sub-task artifacts link back to the story via an issue link
type you choose (`Relates` recommended, pinned via `jira.bugLinkType`); a sub-task artifact
is parented directly. The choice can be pinned in your project's
`.agentex/test-template.md` under a `## Jira` section so later runs skip the ask.

### Bug filing after a run

Same gate, same ledger — with the write order inverted around attachments, because Jira
attaches files to an existing issue: **create Bug → attach screenshots → link story**, all
shown in the plan you approve. The bug's repro (summary, steps, expected/actual,
environment) is composed as rich ADF; `priority` is validated against your project's real
priority **names**; a severity-like **custom** field is used only when your Bug screen has
one — otherwise severity is omitted and the plan says so. The bug links to its story via
the configured/chosen issue link type. A partial failure names the created key, which
attachments landed, and the link state — nothing is retried or cleaned up silently.

### Field validation & the cache

Field metadata comes from Jira's per-issue-type create metadata and is cached per project
in `.agentex/cache/tracker-fields-jira.json` (gitignored, like the ADO cache). Every
supplied value is validated against your project's **real** allowed values before the
approval screen; a stale cache surfaces the real current options and offers
`--refresh-fields` — never a silent substitution. Site-specific custom fields (Story
Points, severity) are discovered by display name and confirmed once per project
(`jira.storyPointsField` pins the choice) — never guessed.

## Known limitations on Jira

Honest capability gaps, declared by the adapter's capability flags — each one is
**informed and asked (never silently substituted)**:

| Capability flag | Jira | What AgenTeX does about it |
|---|---|---|
| `testPlans` / `testRuns` = `false` | Jira Cloud has no test-plan/suite/run APIs | Test-plan operations refuse upfront with a one-line "not supported on this tracker" answer. During bug filing you are told about the gap upfront and offered only what exists: skip (the default), or link the bug to an existing `/design-test` artifact — your explicit choice, on the approval screen. |
| `relations.testedBy` = `false` | No Tested-By link type exists | Test artifacts link back to their story via an issue link type you choose (`Relates` recommended) — shown on the screen, never a silent substitute. |
| `validateOnly` = `false` | No server-side create dry-run | The create-metadata cache + required-field checks carry pre-gate validation; the plan states `validateOnly: 'unsupported-on-jira'` so the approval screen is honest about what was proven. |
| `deleteWorkItem` = `false` | Jira Cloud's only issue delete is **permanent** (no Recycle Bin) | Never offered — a delete ask gets an upfront "not supported on this tracker" answer; cleanup in the portal is your call. |
| No native Test Case type | — | `/design-test` informs you and asks what to create before writing anything (see above). |

Everything else — one consolidated approval per write batch, fail-closed validation, exact
per-write ledgers, secrets never printed — is identical to the ADO flows.

## Troubleshooting

- **"Jira is not fully configured — missing: jira.site / jira.project"** — fill the `jira`
  block in `config/project.json` (or re-run the `/init-test` wizard).
- **"Jira credentials are incomplete"** — add `JIRA_EMAIL` and `JIRA_API_TOKEN` to `.env`
  (both are required; the token comes from id.atlassian.com API tokens).
- **401/403 with a credential hint** — the hint names the env vars only (never values):
  regenerate the token, check the email matches the token's account.
- **`no "Story" sits in an open sprint`** — the board is Kanban, or no sprint is started,
  or the sprint is empty. See [What your Jira project needs](#what-your-jira-project-needs),
  or estimate specific stories by key instead.
- **"field timetracking does not exist on this project's … create screen"** — turn time
  tracking on and add the Time tracking field to the sub-task type (same section).
- **"More than one tracker provider is configured"** — a config carrying both an `azure`
  and a `jira` block fails closed; keep exactly one provider block (the wizard enforces
  this on save).
