# CI mode — headless pipeline runs

The rules for a CI-mode run (`/execute-test ci …`, normally spawned headlessly by the
bundled `ci_gate.js` with `AGENTEX_CI=1` set). Read this BEFORE any action in a CI-mode
run. CI mode is parallel-mode orchestration (SETUP → LOAD → DISPATCH → MERGE → PRESENT)
with stricter dispositions — everything below overrides the interactive behavior it
conflicts with; everything it does not mention works exactly as in a parallel run
(mode parity: a CI run produces the same artifacts as an interactive run, plus
`verdict.json`).

## The one absolute: zero user interaction

There is NO human in this session. Never ask the user anything — no scope
confirmation, no checkpoints, no MERGE-time questions. Anything that would need a
human becomes an explicit **BLOCKED** outcome with a named reason. Never a silent
pass or fail, never a guess.

- **NEEDS-USER items** (deferred ui-check confirmations from executors): interactively
  these are resolved with the user at MERGE. In CI there is no user — resolve each one
  as **BLOCKED** with the run-level reason `needs-user` carrying the executor's precise
  question verbatim (pass it to the verdict step as
  `--run-reason "needs-user:<the precise question>"`). Never finalize the deferred
  check as PASS or FAIL, and never drop the question. Count the scenario as `blocked`
  in the run summary.
- **Captcha or unobtainable OTP**: a live captcha, an OTP nobody can supply, or any
  blocking gate → the scenario is BLOCKED and the run-level reason `captcha-or-otp`
  is passed to the verdict step. Never defeated, never worked around (invariant: gates
  are surfaced). A FIXED test-environment captcha or OTP whose value comes from the
  spec or the environment's `defaults` is normal test data — type it as usual.
- **A confirmation gate of any kind** (anything a skill says to ask about first) →
  BLOCKED, reason `interaction-required`, with what was needed as the detail.

## No tracker writes of any kind

Never offer, plan, or perform bug filing or any other tracker write (create, update,
link, attach, run-result — nothing). Bug filing stays interactive-only. Report defects
in `report.md` / `bugs/bug-list.md` exactly as usual; the human files them later from
an interactive session. The bundled tracker scripts refuse `--execute` mechanically
under `AGENTEX_CI=1` (exit 2, reason `ci-mode`) — do not attempt the call to find out.
Tracker reads are unaffected.

## Blocked stays blocked

An environment-blocked scenario (missing user handle, uncataloged `api:`/`db:` step,
unresolvable ui-check baseline, dead session after the one Flake-doctrine retry) is
counted `blocked` in the run summary — never converted to `failed`. The verdict step
turns blocked counts into exit 2 (environment), and failed counts into exit 1 (product
defects); the 1-vs-2 separation is the gate's core promise, and it is only as honest
as the counts you feed it.

## REPORT: the deterministic verdict step

At REPORT (after `report.md` and `bugs/`), always:

1. Generate `extent-report.html` via the **extent-report** skill (not optional in CI —
   it is the artifact the pipeline publishes for the PM).
2. Build the run-summary JSON exactly as for the extent report (same counts
   vocabulary: `passed/failed/blocked/warnings/viewMismatch/flaky/naDescoped/notRun`)
   into a temp file.
3. Run the verdict writer — judgment ends here; the mapping is code:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/scripts/write_verdict.js \
     --summary <temp run-summary.json> \
     --run-dir executions/execu_<ts> \
     --env <active environment name, when one resolved> \
     --scope-kind <spec|list|suite|all> --scope-value "<the run's scope>" \
     --started-at <ISO timestamp recorded at SETUP> \
     [--run-reason <code>:<detail>]...
   ```

   Pass one `--run-reason` per run-level condition encountered: `needs-user` (one per
   deferred question, the question verbatim), `captcha-or-otp`, `interaction-required`,
   `session-error`. Do NOT pass policy flags — policy arrives via the `AGENTEX_CI_POLICY`
   env var (set by `ci_gate.js`) or the project's `ci` config block; the script resolves
   it itself.
4. Delete the temp summary file (extent-report convention). `verdict.json` in the run
   folder is the retained artifact — never edit it by hand.

Exit codes from `write_verdict.js` (0 PASS / 1 FAIL / 2 BLOCKED) are expected outcomes,
not script errors — relay its one JSON line in the final message and do not re-run it
to change a verdict.

## Unchanged rules, restated for the headless context

- Never print secret values — `{ envSecret: NAME }` names and env vars only. CI logs
  are long-lived; a leaked value cannot be unshipped.
- All outputs land under `executions/execu_<ts>/` in the consumer project.
- The Flake doctrine applies unchanged: FLAKY is reported, never resolved; one retry
  for infrastructure failures only; never re-dispatch an executor for a cleaner report.
- `agents/qa-executor.md` needs nothing special: executors already defer NEEDS-USER
  items and never ask mid-run. Only the MERGE-time disposition differs (BLOCKED with
  the named question instead of asking the user).
- The scope token `all` means every spec file under `test/`.
