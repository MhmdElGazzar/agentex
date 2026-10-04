---
name: agentex-test
description: Run AgenTeX browser QA under OpenAI Codex, including bounded parallel regression of saved specs. Use for saved specs, login smoke tests, named web features/scenarios, natural-language browser tests, or explicit parallel suites.
---

# Execute AgenTeX browser tests under Codex

1. Resolve the plugin root from this skill's absolute `SKILL.md` path (`../..`),
   then verify with `node <plugin-root>/scripts/resolve_plugin_root.js`.
   Run commands from the **consumer project root**.
2. Read the shared `skills/test-execution/SKILL.md`,
   `skills/browser-driver/references/tools/playwright-cli.md` when browser steps are needed, and
   `skills/test-execution/references/procedures/executor-contract.md`. Those files own QA policy, session and
   evidence rules, and the assignment/result shape. Read other integration
   skills only when a scenario needs them.
3. Resolve the user's scope: an explicit spec path, a named spec under `test/`,
   or a bounded natural-language scenario. Never silently run the entire suite.
   Resolve target/environment and login mode according to test-execution. A
   missing target or missing named environment is BLOCKED; ask for the missing
   value without guessing. Treat a supplied executable spec as the plan. For a
   natural-language mission, show the proposed scenarios and obtain any needed
   scope/plan approval under the shared sequential rules.
4. For an explicit parallel/regression request, use ONLY saved specs with a
   `# Spec:` title and a `## Scenario` or `## Scenarios` section. Run
   `node <plugin-root>/skills/agentex-test/scripts/parallel.js --spec-dir <dir>
   --target-url <URL> [--concurrency 1..4]`, or repeat `--spec <file>` for
   explicitly scoped files. Directory discovery is sorted; explicit file order
   is preserved. The default concurrency is 2, maximum 4. The coordinator
   preflights, creates one run, allocates independent sessions, launches
   bounded `codex exec` workers, and finalizes once. Do not run the sequential
   projector against any parallel session. A product FAIL does not stop the
   suite. If Windows preflight returns `APPROVAL_REQUIRED`, use only the normal
   narrowly scoped approval route; never disable sandboxing. Parallel
   `login.mode=session` uses one temporary private storageState copy per
   worker; give `--auth-state <test/.auth/file.json>` when multiple saved states
   match. Never refresh the shared source file. Worker-owned copies are removed
   before finalization, and auth paths/contents stay out of run artifacts.
   An unattended caller that needs an exact-run handoff may add
   `--run-handoff <path>` (relative to the consumer root or absolute, with an
   existing parent directory). For a later gate check, generate a unique,
   non-secret ID before execution and pass `--invocation-id <id>` to both the
   coordinator and `scripts/evaluate_handoff_run.js`; the consumer requires
   this independently supplied ID to reject stale or swapped handoffs. When
   omitted, the coordinator generates an ID, but a CI caller cannot prove its
   own identity to the consumer after a crash. After allocating the run and writing its
   `coordinator-owner.json`, but before preparing auth copies or starting any
   worker, the coordinator exclusively publishes JSON containing only
   `schemaVersion`, `runId`, `runDir`, and `invocationId`. The file identifies this invocation's
   run even if execution later fails; it does **not** mean finalization succeeded.
   Use that exact `runDir` for later CI evaluation, never a latest-run scan.
   Without this option, existing execution and stdout behavior is unchanged.
   Stop here for the parallel branch; steps below are the one-spec path.
5. Run `node <plugin-root>/skills/test-execution/scripts/preflight.js` and
   inspect `playwright-cli.status`. `READY` includes a direct Node/CLI command;
   `MISSING_DEPENDENCY` is not a permission failure. For `BLOCKED_BY_SANDBOX`
   or `APPROVAL_REQUIRED`, use the normal scoped approval route or report
   BLOCKED; never disable the sandbox or install dependencies without consent.
6. Run `node <plugin-root>/skills/test-execution/scripts/init_run.js` once.
   Pass its exact unique session name and paths, plus the resolved assignment
   fields, to the `agentex-executor` skill. Execute **one** assignment locally.
   Do not route this one-spec path through the parallel coordinator. On Windows,
   retain one approved command-owner process for all named Playwright CLI actions
   from `open` through evidence capture and `-s=<session> close`; send commands
   through that same process handle. Separate top-level Codex command calls can
   reap the detached Playwright daemon when their parent ends. Track the owner
   handle/PID and assigned session, and end the owner only after session-scoped
   cleanup. If the owner fails, check and close only the assigned session if
   reachable, and report cleanup failure when it cannot be verified. A lost owner/browser is an infrastructure event under the existing
   flake doctrine, never an implicit fresh PASS. Do not use global browser or
   process cleanup, a short timeout across user checkpoints, or broad shell
   permissions to make the owner persistent.
7. Validate `browser-sessions/<session>/executor-result.json` with
   `node <plugin-root>/skills/test-execution/scripts/validate_executor_result.js
   <result-path>`. A missing/invalid result is BLOCKED, never a pass.
8. From the consumer root, run
   `node <plugin-root>/skills/test-execution/scripts/project_executor_result.js
   --result <result-path> --target-url <resolved-url> --environment <resolved-name>
   --login-mode <resolved-mode>`. Omit optional flags when not applicable. The
   projector owns the v2 `run-summary.json`, `report.md`, `bugs/bug-list.md`,
   and bug evidence copies. Check its JSON `{ok:true}` response; a nonzero exit
   is BLOCKED. **Never manually translate the executor JSON into reports.**
9. Generate `extent-report.html` from the projected `run-summary.json` with
   the existing `skills/extent-report/scripts/make_html_report.js`. Check the
   output exists. Surface any failed session cleanup.

Never use Playwright MCP for this workflow. Every browser action uses
the preflight-provided direct CLI command (or `npx playwright-cli` where it
works), always with `-s=<assigned-session>`. Never modify application source,
print credentials, or issue uncataloged API/DB calls.

For a later CI/release decision over an already finalized run, read
`../test-execution/references/procedures/release-gate.md` and invoke the standalone
`../test-execution/scripts/evaluate_release_gate.js` on that run's v2
`run-summary.json`. This does not rerun the browser or change this skill's
sequential/parallel execution paths.
When using the optional parallel handoff, instead invoke
`node <plugin-root>/skills/agentex-test/scripts/evaluate_handoff_run.js
--handoff <exact-file> --invocation-id <same-caller-generated-id>
[--flaky-policy review|fail|allow]` from the consumer root after the coordinator
has finished. It verifies ownership and finalization, then calls the same
offline evaluator. It never scans for a latest run or finalizes one itself.
