---
name: bug-report-azure
description: "File defects found by a completed test or regression run as tracker Bugs — Azure DevOps or Jira Cloud (\"file these as Jira bugs\" works the same). Use for selecting run findings, writing useful reproduction details, classifying severity/priority/category, annotating and checking screenshot evidence, checking duplicates, and filing behind one consolidated approval."
---

# Report Azure Bugs

## Role
You file defects found during a run as Bugs on the configured tracker, under the right
User Story, behind exactly one consolidated approval. You never write to the board
without it.

**On Jira:** this workflow's operation refuses a Jira config (`unsupported-tracker`). Read
`${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/references/jira-filing.md` and follow it
instead; everything below is the Azure DevOps path.

Turn confirmed run findings into useful Bugs under the correct User Stories. The agent
owns defect judgment and the user conversation. The bundled operation owns Azure
configuration, template and field discovery, validation, formatting, attachments,
relationships, test-plan mechanics, and writes.

Use only this agent-facing operation for the filing flow:

```text
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/bug-report.js context --parent <story-id> --emit-intent
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/bug-report.js context --intent <intent.json> [--duplicate-view all]
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/bug-report.js prepare --intent <intent.json> --duplicate-review <review-id> --plan <new-plan.json>
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/bug-report.js execute --plan <prepare.planFile>
```

Do not read project secrets, inspect raw template fields, compose Azure requests, or call
the low-level bug/test-plan scripts during normal filing. The local evidence helpers are
the exception: `annotate-image.js` (step 1) runs before `prepare`, which re-checks every
file structurally itself. The operation prints one JSON
result: exit 0 is ready/success, exit 2 is blocked before a board write, and exit 1 is a
failed or partial execution whose ledger is authoritative.

## When to run

At the end of any run or task that surfaced one or more issues. Offer it proactively: "N
issues were found — want to file any as Bugs?" If the user declines, stop. Nothing touches
the board.

## Non-negotiable policy

- Perform all reads, evidence review, and `prepare` validation before asking for approval.
- Present one consolidated approval screen for all Bugs in this filing. Do not ask for a
  second confirmation after the user approves it, and never run `execute` before approval.
- Use only values returned by runtime context or explicitly supplied by the user/run. Never
  infer a required severity, priority, parent, assignee, category, or test-case decision.
- Duplicate discovery fails closed and still reads every direct Bug child of the selected
  parent across all states, plus the project-wide Bug mirror (step 4). Intent-aware context presents a deterministic review ordering:
  25 candidates by default plus every normalized exact-title match. Ranking, omission, and
  candidate presence are never duplicate verdicts or automatic blocks. Treat that shortlist
  as the default semantic decision surface. Never invoke `--duplicate-view all` merely to be
  safe; use it only for a concrete, recorded ambiguity supported by the review output. Set
  `duplicate.allow: true` only after the user explicitly chooses to file despite a candidate.
- A Bug receives one parent User Story and no agent-requested extra relationship. Never edit
  the parent story.
- The only permitted test-case actions are the user's explicit choice: `fail-existing`,
  `create-new`, or `skip`.
- No screenshots, structurally invalid evidence, or an unsupported screenshot require an
  explicit user-approved waiver/exception. Never silently attach rejected evidence.
  Missing or unreadable evidence cannot be waived because it cannot be uploaded.
- Report a partial execution as a failure. Relay every ledger entry, all created IDs/URLs,
  and the exact returned reason. Never retry, clean up, or make a compensating board write
  unless the user makes a new request.
- Never rewrite project configuration to make a filing pass. A corrected runtime choice is
  for that filing only.
- In CI (`AGENTEX_CI=1`), do not offer or attempt interactive bug filing.

## Workflow

### 1. Collect semantic defect content

When artifacts follow the documented `executions/execu_<timestamp>/` layout, resolve the run
directory once. Combine independent deterministic discovery and reads of the report, Bug
list, and evidence candidates into the smallest practical number of tool calls the host
supports. Reuse the resolved paths; do not repeatedly list an already resolved directory or
run overlapping searches for the same artifacts. Expand discovery only when an expected
artifact is missing or ambiguous.

For each selected finding, derive from the run evidence:

- a concise, observable title and one-line summary;
- minimal reproducible steps;
- expected and actual results;
- the parent story from the run/ask;
- environment, test configuration, and observation time when known;
- candidate screenshots.

View candidate images and decide whether each one actually supports this defect. Record
both the attach list and rejected files with reasons. Structural validity is checked again
by `prepare`; `likely-blank` is a warning for your visual judgment, not an automatic reject.

Annotate each screenshot you will attach (never blocks, never asks). Write
`{"image", "banner", "boxes": [{"x", "y", "width", "height", "label", "ok"?}]}` beside the
intent (e.g. `bug-1-<shot>.json`; box values in % of the image). `banner` is the Bug's
summary; one red box goes on the defect, labelled from expected/actual
(`Expected "X" — actual "Y"`); optionally one `"ok": true` green box on something correct.
Use only the summary/expected/actual and on-screen text — invent nothing. Run
`node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/annotate-image.js --spec <file>.json`,
Read the image it names, and fix a misplaced box at most twice. In the intent's attach list,
put its `annotated` path **followed by** the raw file — the overlay can hide what is under
it, so the raw capture always travels with it, and the approval screen shows both. On a
non-zero exit, or a box still off after two fixes, attach the raw screenshot alone and give
a one-line reason on the approval screen: never install, never ask, never seek a separate OK.

### 2. Retrieve bootstrap context

Run `context --emit-intent`, including the known parent ID. Use its compact output for:

- configured template and validated parent summaries;
- resolved defaults and assignee choices;
- real allowed severity, priority, environment, and category values;
- project-required semantic fields or unsupported process requirements;
- configured test-plan identity.

This bootstrap still performs fail-closed parent candidate discovery, but deliberately does
not return an arbitrary candidate list before the defect intent exists. Its
`duplicateReview.status` is `intent-required`, with the discovered total and zero shown.

The opt-in `intentTemplate` is a structurally complete intent skeleton derived from the
operation's executable contract. Keep it as the starting object for this Bug; do not
reconstruct the field names or nesting from these instructions. Its parent is prefilled
when validated by `context`. Runtime-defaultable values stay null so `prepare` resolves
them again from current runtime data.

Check `requiredInputs.assignedTo`: when `needsUserInput` is true and the request/run has
not already supplied an assignee, ask for a concrete assignee in the bundled input round.
Never offer `Unassigned` for this required field.

Immediately after bootstrap context returns, inventory every unresolved explicit user
decision and determine whether that complete question set is closed. A null
`testCase.action` is unresolved unless the user already chose `fail-existing`, `create-new`,
or `skip`. The set is closed only when the run, evidence work, and bootstrap facts show that
later classification, duplicate, or evidence analysis cannot introduce another required
question. If it is closed and nonempty, issue the single bundled input question at this
point; if it is empty, continue without a question. Where the host permits, continue
independent intent and evidence work while waiting for the answer. If later semantic work
may still add a required question, defer the bundle until that work closes the set. Never
auto-decide `testCase.action` or any other explicit user choice.

When materializing the scaffold as intent JSON, use the host's direct structured
file-write/edit operation on the first attempt and write the complete JSON object. Do not
use a shell heredoc or `sed` patching as the default for escaping-sensitive intent content.
Preserve the scaffold's exact schema and nesting; `prepare` remains the authoritative
validator.

Do not separately inspect configuration or retrieve the raw template. If a configured
template or parent is unavailable/wrong, filing is blocked.

### 3. Recommend classification

Explain the recommendation in one line. Match impact to the closest allowed values returned
by `context`; conventional projects commonly use:

| Observed impact | Severity | Priority |
|---|---|---|
| Flow blocked with no workaround | `1 - Critical` | `1` |
| Wrong issued data or broken core path with a workaround | `2 - High` | `1` or `2` |
| Localized, visible, non-blocking functional error | `3 - Medium` | `2` or `3` |
| Cosmetic or edge-case polish | `4 - Low` | `3` or `4` |

For Bug Category, interpret only the returned choices against the observed failure (for
example functional, UI, or data). If the match is ambiguous, ask; never invent a value.

### 4. Review duplicates and complete any deferred bundled input

Fill the scaffold's evidence-derived title, summary, steps, expected result, and actual
result, then run `context --intent <intent.json>`. The top-level `duplicateCandidates` is the
intent-ranked list for semantic review and retains each candidate's ID, title, state, and
reproduction summary. `duplicateReview` reports the review ID, strategy/view, default size,
total/shown/omitted counts, truncation, exact-title pin count, and shortlist IDs.

Candidates come from two places, ranked together. The selected parent's direct Bug
children are always read in full. The **project-wide Bug mirror** adds Bugs under other
stories: a local copy in `.agentex/cache/tracker-bugs-ado.json`, brought up to date on every
call by one read of the Bugs changed since the last sync. Its scope is the project (under
`azure.areaPath` when set), Bugs changed in the last `azure.bugCacheDays` days (default
365; `0` turns it off). A mirrored candidate carries `source: "project"` and its `parentId`,
and `duplicateReview.projectWideCandidates` counts them. When one matches, name its story
on the approval screen: the defect may already be filed under a different story. A sync
that cannot complete blocks the filing (`dup-check-failed`), like any duplicate-check
failure. An edit to a project Bug that is not shortlisted does not make the review stale.

`watchlistMatches` (present only when there are any) lists open **QA watchlist** entries
(`qa-watchlist/`, read through `scripts/qa-records.js`) that share terms with this defect or
are recorded against the same story (`sameStory: true`). They are not Bugs, and they are
not part of the review receipt, but each one changes what the user should decide:

| `kind` | What the match means for this filing |
|---|---|
| `pendingRechecks` | A fix was already expected here. The defect may be a failed retest of known work, not a new Bug. |
| `pendingQuestions` | The behaviour is waiting on a requirement answer. It may not be a defect yet. |
| `envIssues` | A known environment problem may be the cause. |
| `deferredConditions` | The condition was deferred on purpose, with a recorded reason. |

Show every match on the approval screen with its kind, file, and text, and let the user
decide. A watchlist file that exists but cannot be read blocks the filing
(`watchlist-unreadable`). No watchlist files means no matches.

The Top-25 view is the default semantic decision surface unless additional normalized
exact-title candidates are pinned. Closed and Resolved Bugs remain eligible, and state is
not a ranking signal. A truncated list or nonzero omitted count alone is not a reason to
request every candidate, and never invoke `--duplicate-view all` merely "to be safe." Use
the full view only when a concrete trigger exists:

- `duplicateReview.lowSignal` is `true`;
- there is an exact-title collision that needs broader duplicate context;
- a candidate at the shortlist boundary has a failure mode that cannot be ruled out from
  the shown evidence; or
- another specific ambiguity is supported by the shortlist evidence.

Before invoking the fallback, state in the operational record which trigger fired. If none
fired, retain the shortlist's `reviewId` and continue. The full view remains available and
returns the complete candidate set in the same deterministic ordering. This display choice
does not weaken fail-closed discovery: the runtime still reads every direct Bug child, and
the review receipt remains bound to the complete candidate snapshot. The ID is a freshness
receipt, not a duplicate verdict or approval.

If the bundled input question was not issued after bootstrap, ask it here once the complete
set closes, containing every unresolved item: which findings to file, ambiguous
classification, assignee, parent, duplicate exception, test-case action/details, and
evidence exception. Ask at most one bundled question round before approval; never open a
second round after an early bundle. Skip the round when the ask, run, and runtime context
already settle everything.

If that input changes a ranking-relevant field (`title`, `summary`, `steps`, `expected`, or
`actual`), rerun the intent-aware context before preparing. Other semantic decisions remain
agent-authored and do not turn the review receipt into a code-side verdict.

### 5. Prepare the exact approval plan

Use the intent JSON materialized from the returned `intentTemplate`; do not create a second
schema or reconstruct its fields before `prepare`. Replace its null/empty semantic values
with the decisions and evidence already collected.
Required defect content, classification, evidence choices, duplicate exceptions, and the
test-case action remain agent-authored. In particular, `testCase.action` is deliberately
null: set it to the user's explicit `fail-existing`, `create-new`, or `skip` decision and
complete the corresponding fields already present in the skeleton.

Leave `assignedTo`, `environment`, `bugCategory`, `valueArea`, and `testCase.planId` null
when not overriding runtime configuration. `prepare` resolves those values from fresh
runtime data; the context-time values are not frozen into the intent. The exception is a
picklist that `processRequirements.agentSupplied` lists while `defaults` has no value for
it: `prepare` blocks it empty, so choose it from the returned `choices` (Bug Category per
step 3, Environment from the run) or put it in the one bundled question. A missing suite
returns real suite choices. Set duplicate permission, screenshot/evidence waivers, or new
Test Case duplicate permission to true only after the required explicit user decision.

Run `prepare` with the reviewed intent, its `--duplicate-review <review-id>`, and a new plan
path. It retrieves dynamic data again and verifies that the parent/project, ranking version,
ranking-relevant intent, complete compact candidate content, and shortlist IDs still match. A missing
or stale review stops before plan creation and every board write, returning a refreshed
shortlist and new review ID. Review that list and rerun `prepare` with the new ID; a separate
context call is needed only when the full view is wanted.

After the freshness check, `prepare` validates everything without a board write and saves the
exact local plan artifact. If blocked, surface all returned corrections together, update the
semantic intent only after the user's decision, and prepare a new plan file. For
`cacheStale: true`, show the returned current options and offer one re-prepare with
`--refresh-fields`; field-cache refresh does not repair a stale duplicate review, and project
configuration must not be edited.

### 6. Show one screen, then execute once

Render each successful result's `approval` object, including:

- template and parent identity;
- classification plus its rationale, assignee, and resolved placement;
- reproduction content;
- ATTACH/REJECT evidence with reasons/warnings;
- the compact duplicate-review receipt and decision, plus any project-wide exact-title
  exception candidates (never the full parent candidate list), and any project-wide
  candidate the user should weigh, named with its parent story;
- the approval's `watchlistMatches`, each with its kind and text;
- test-case decision;
- every logical effect in `writePlan`, in order;
- an explicit statement that nothing has been written to Azure yet.

Immediately after rendering that complete approval screen, invoke `AskUserQuestion` once
with one single-select question:

- Header: `Approval`
- Question: `Execute the prepared plan exactly as shown?`
- Choices, in this exact order:
  1. `Execute this plan`
  2. `Cancel — no board writes`

Do not replace the full approval screen with the question, abbreviate the screen inside the
question, or add a separate prose confirmation. Only a returned selection of `Execute this
plan` is approval. Treat `prepare.planFile` as an opaque, authoritative value. Carry that
returned value forward directly; never reconstruct, normalize, retype, relocate, or infer
the plan path from the requested `--plan` path, working directory, `approvalId`, or any other
value. For an approved selection, invoke `execute` exactly once per displayed plan, in the
displayed order, passing that exact `prepare.planFile` value verbatim as the `--plan`
argument; its `approvalId` binding remains authoritative. If the exact returned value is
unavailable, stop rather than guessing another path. If the user selects `Cancel — no board
writes`, dismisses the question, supplies free text, or gives any other response, stop
without invoking `execute` and perform zero board writes. Stop the execution sequence on the
first failure.

Report the returned ledger verbatim in substance. `done` means the ID/URL now exists;
`failed` is the stopping error; `not-attempted` did not happen. A plan is single-use: any
retry or changed evidence requires a fresh prepare-and-approval cycle.

## Maintenance only

The legacy low-level CLIs remain for compatibility and diagnostics, not normal agent use.
Their implementation ownership is documented in
`${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/references/azure-devops.md`; do not load that
reference during an ordinary filing.
