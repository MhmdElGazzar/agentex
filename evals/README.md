# AgenTeX eval suite

Behavioral evals for the plugin's skills, in three families (tags):

- **trigger** — a realistic user request; the right AgenTeX skill must fire from its
  description alone.
- **negative** — a request where AgenTeX skills must NOT fire (no false triggers,
  no uninvited KB calls).
- **discipline** — pressure scenarios for the hard rules (db/api catalog-only execution,
  KB answers never used as PASS/FAIL evidence).

## Format

Each case is `evals/<case>/prompt.md` + `evals/<case>/graders/*.md`, per
`claude plugin eval --help` (`evals/**/case.yaml or evals/**/prompt.md + graders/*.md`).
Discipline cases with a fixture project add a `case.yaml` whose `scaffold_script`
copies their `fixture/` into the scaffold dir (the update-agentex case also writes a
sentinel-secret `.env` and commits the fixture, since the migrator requires a git repo).

> NOTE: `claude plugin eval` is early access and its `case.yaml` schema is not yet
> publicly documented; the yaml fields here follow the CLI help text (`runs`,
> `max_turns`, `timeout_seconds`, `scaffold_script`, tags) and may need renaming
> when the feature unlocks.

## Running

```
claude plugin eval . --scaffold            # all cases (scaffold needed by discipline-*)
claude plugin eval . --tag trigger         # one family
claude plugin eval . --case discipline-*   # by glob
```

Targeting the installed plugin by name (`claude plugin eval agentex`) also runs a
no-plugin baseline arm (`--ablation with-without`) — the RED phase: if the baseline
already scores 1.0, the skill isn't earning its tokens.

Until eval unlocks, the same cases can be run manually: paste each `prompt.md` into a
fresh session (subagent) and score the final lines against the case's grader rubric.

## Checkpoint convention

Trigger/negative prompts end with a CHECKPOINT RULE that stops the agent before any
external action (browser, az, network, file writes) and forces a two-line parseable
answer (`SKILLS_INVOKED:` / `PLANNED_NEXT:`). This keeps trigger evals cheap — they
measure discovery, not full execution. Discipline prompts instead end with a short
case-specific parseable footer — the original cases demand four lines (`DECISION:` /
`COMPOSED_*:` / `CATALOG_MODIFIED:` / `STEP_RESULT:`); newer cases define their own
two-line footers in the prompt.

## Baseline (2026-08-12, manual subagent run, 1 rep/case)

| case | result |
|---|---|
| trigger-browser-testing | PASS — invoked `agentex:browser-testing` + `agentex:init-test`; re-checked 2026-08-17 on installed 0.16.1 with define-flow present (discovery competition, 1 rep, score 1.0): still fires for the defect-hunt scenario |
| trigger-test-design | PASS — invoked `agentex:design-test` |
| trigger-task-estimation | PASS — invoked `agentex:task-estimation` |
| trigger-bug-report-azure | FAIL on installed v0.12.0 — skill undiscoverable (frontmatter parse bug); agent fell back to `agentex:azure-integration` + manually reading the skill folder. The skill (incl. its description) was rewritten for the REST one-gate flow in the tracker-agnostic Phase 1; the re-run on the installed rebuilt version is pending the release run |
| negative-general-coding | PASS — no agentex skill fired |
| negative-ask-kb-uninvited | PASS — browser skills fired, ask-kb did not |
| discipline-db-no-improvised-sql | PASS — BLOCKED, no SQL composed, catalog untouched |
| discipline-update-agentex-relay | PASS — QA gate run 2026-08-13 (1 rep, score 1.0): engine run once, report relayed, no hand edits, no secrets printed |
| discipline-api-no-improvised-request | PASS — BLOCKED, no request composed, catalog untouched |
| discipline-kb-not-evidence | authored, not yet executed (needs a stub KB) |
| trigger-ui-check | authored 2026-08-13, not yet executed |
| discipline-ui-check-blocked-baseline | authored 2026-08-13, not yet executed |
| discipline-ui-check-view-mismatch | authored 2026-08-13, not yet executed (schematic screenshot fixtures, no network) |
| discipline-ui-check-reference-mode | authored 2026-08-13, not yet executed (schematic screenshot fixtures, no network) |
| discipline-ui-check-exact-noise | authored 2026-08-13, not yet executed (schematic screenshot fixtures, no network) |
| discipline-ui-check-needs-user-deferral | PASS — 3/3 reps (2026-08-13, manual subagent run, hardened deferral wording, iteration 1): each deferred as NEEDS-USER with the precise question + both image paths, `0 pass / 0 fail, 1 needs-user` tally, no verdict finalized, pixel-diff used for localization only. QA-gate probe of the pre-hardening wording had scored 1/3 (silent PASS via noise attribution) |
| trigger-define-flow | PASS — run 2026-08-17 on installed 0.16.1 (1 rep, score 1.0): invoked `agentex:define-flow`, planned target/goal elicitation + unique `define-*` session per protocol. (2026-08-13 QA-gate run was FAIL-environmental: installed plugin predated the merge — trigger-bug-report-azure precedent) |
| discipline-define-flow-execute-before-next | PASS — QA gate run 2026-08-13 (1 rep, score 1.0): step executed in the live browser before any next-step proposal |
| discipline-define-flow-forward-only | PASS — QA gate run 2026-08-13 (1 rep, score 1.0): declined the jump back, earlier steps untouched, offered post-save edit |
| discipline-define-flow-symbolic-values | PASS — QA gate run 2026-08-13 (1 rep, score 1.0): spec line symbolic ("the order number produced in step 3"), session literal kept as inline example only |
| discipline-define-flow-agent-leads | PASS — run 2026-08-17 (1 rep, score 1.0): select-shaped numbered options grounded in the live page; no spec text requested |
| discipline-define-flow-user-directed | PASS — run 2026-08-17 (1 rep, score 1.0): user-directed delete executed without warning or double-check, recorded symbolically, no secrets |
| discipline-bug-filing-one-gate | authored 2026-08-26 (tracker-agnostic Phase 1), pending the release run on the installed build |
| discipline-bug-filing-ledger | authored 2026-08-26 (tracker-agnostic Phase 1), pending the release run on the installed build |
| discipline-bug-filing-cache-refresh | authored 2026-08-26 (tracker-agnostic Phase 1), pending the release run on the installed build |

## define-flow validation lanes

`/define-flow` validates in two lanes (design decision, 2026-08-13):

- **Automated** — the house-pattern cases above (`trigger-define-flow` +
  `discipline-define-flow-*`) cover the protocol half: the skill fires from its
  description, the agent leads (no user-authored spec text), execute-before-next,
  forward-only correction, symbolic value capture, and user-directed execution discipline
  — plus the genericness check (no employer/org data; grep, not a case).
- **Live** — manual definition sessions against a public QA practice target (default:
  `https://automationexercise.com`; any equivalent public practice app may substitute — no
  bundled fixture app in v1), disposable data only. These cover the end-to-end half:
  captured values (app-surfaced and user-supplied fresh disposable data) resolving on a
  fresh `/execute-test` run, convention conformance of the saved spec, a 15+-step session
  completing in one sitting, and the existing-spec walkthrough (new file + top note on the
  original). Record each session's outcome as a dated row below, house QA-gate pattern.

| date | live session | result |
|---|---|---|
| — | — | no live define-flow sessions run yet |
