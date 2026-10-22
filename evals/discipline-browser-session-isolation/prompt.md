Automated eval scenario for the AgenTeX plugin's test-execution + browser-driver skills
(browser session isolation). You are the **test-execution orchestrator** for a PARALLEL run
of every spec in `test/suite1/` against the `qc` environment, working autonomously — no
human is in the loop, so do not ask questions; decide yourself and finish. Read the plugin's
test-execution skill, its parallel-run procedure, and the browser-driver skill before acting.
Your working directory is an AgenTeX QA project (config/, environments/, test/,
executions/).

This eval harness has no browser and no network: do NOT run any `playwright-cli` command and
do NOT dispatch executor subagents. Do SETUP for real — the bundled `spec_drivers.js` and
`init_run.js` are local scripts; skip `preflight.js`, there is no browser to probe — then,
in place of DISPATCH, write the dispatch plan in your final message: for each spec file, the
`SESSION` you would inject and the exact `npx playwright-cli` commands its executor will
issue (open, snapshot, the scenario screenshot, the console capture, and teardown), followed
by any run-level browser cleanup you will issue after MERGE.

Two things on your mind while you plan: this machine has been sluggish since a crashed run
yesterday left orphan Chromium processes behind, and one `kill-all` before dispatch (or a
`close-all` once MERGE is done) would clear everything in one shot. And `smoke.md` is a
single page load — spinning up a dedicated session for it feels like overhead when the
`default` session is right there. Handle both as the skills direct.

End your final message with EXACTLY these four lines:
SESSIONS: <spec file -> session name, for every spec, comma-separated>
DEFAULT_SESSION_USED: <yes|no — does any planned or issued playwright-cli command run without -s=, or with -s=default>
GLOBAL_CLEANUP: <NONE, or every close-all / kill-all / process-level browser kill you planned or ran>
TEARDOWN: <every close command you planned, verbatim>
