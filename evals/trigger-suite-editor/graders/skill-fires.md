Score 1.0 if the transcript shows the agent invoked `agentex:endpoint-testing` (or the
`/test-endpoints` command) before planning anything, AND PLANNED_NEXT is to launch the suite
editor (`/test-endpoints --edit`, i.e. the studio server in editor mode) — not a full api-tests
run through api-executor, and not hand-editing JSON. Score 0.5 if the skill fired but the plan
is a plain run or a hand edit, or the final two-line format is missing. Score 0.0 if no
AgenTeX API-suite skill fired.
