---
name: agentex-executor
description: Execute one bounded AgenTeX browser QA assignment under Codex in one isolated Playwright CLI session, record evidence, and write the executor result. Invoked by agentex-test, not for general web browsing.
---

# Single Codex executor

Accept one assignment with the fields in
`../test-execution/references/procedures/executor-contract.md`. Confirm `session` and
`sessionDir` came from `init_run.js`, and `session` is not `default`. Do not start
until the shared test-execution skill and `skills/browser-driver/references/tools/playwright-cli.md` have
been read. The assignment belongs to one spec or bounded mission; do not add
unrequested scenarios.

For a parallel Codex assignment, `workerId`, `runId`, and
`browserWorkingDir=sessionDir` are supplied. The Codex process starts with
`sessionDir` as its project-writable root. Read the spec/configuration from
`workingDir`, but run browser commands from `browserWorkingDir`. Save every
worker-created file, including CLI scratch, inside `sessionDir`. Do not write
run-level files, a sibling session, or shared auth/storage state. For parallel
`loginMode=session`, resume only the private `authStatePath` supplied by the
coordinator; it may be refreshed, but the original saved state is read-only. The
coordinator validates and finalizes after all workers are terminal.

Run all browser commands from `browserWorkingDir` when supplied, otherwise
`workingDir`, using the preflight-provided direct
CLI command, or `npx playwright-cli` where it works, always with
`-s=<session> ...`. Never omit `-s=`, touch another session, or call `close-all`
or `kill-all`. Start headless unless the user specifically requests a visible
browser. Use `snapshot` before element interaction and refresh refs after
navigation. Check visible success states by computed visibility. Capture a
screenshot for every scenario, including failures, with `screenshot
--filename=<sessionDir>/screenshots/<scenario>.png`. Save console and network
observations under `sessionDir/logs/`; use the installed CLI's `requests`
command when available, otherwise the shared Playwright reference's
`run-code` listener approach for network data. Console errors and failed
requests are defects even when the page looks correct.

Follow the shared test-execution flake doctrine exactly: one attempt by
default, one retry only when the app never answered, and never retry a wrong
application response to clear a defect. Cataloged `api:`/`db:` steps use their
shared skills and runners. KB answers remain advisory. UI checks follow the
shared `ui-check` skill. Do not create accounts, complete payments, use real
personal data, change application code, or disclose secret values or
`envSecret` target names in artifacts.

Record run and scenario timestamps. Put scenario rows in the existing
`run-summary.json` v2 `testCases[]` shape, with screenshot and log evidence
paths relative to `runDir`. Put defects in the existing v2 `defects[]` shape.
Write `sessionDir/executor-result.json` using the executor contract, including
explicit `failures[]` for product, infrastructure, or automation errors. The
result must describe observed behavior, including partial execution; never
invent a PASS because a tool failed.

Always attempt a session-scoped `<CLI> -s=<session> close`, even when execution
fails. Record `cleanup.attempted`, `cleanup.closed`, and any error truthfully.
Validate the result with `validate_executor_result.js` from the consumer
project root and repair any schema/path error before handing it to
`agentex-test`. If close failed, report that failure visibly. This executor
runs in the current Codex agent; it does not dispatch workers. It does not
write run-level reports—the sequential projector or parallel finalizer does
that after validation.
