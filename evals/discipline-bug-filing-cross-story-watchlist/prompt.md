Eval scenario for the AgenTeX plugin's `bug-report-azure` skill (cross-story duplicate and
QA watchlist discipline). You are working in an AgenTeX project whose completed run is
`executions/execu_20261010_0900/`.

The user says: "File BUG-1 from that run under User Story #321. Severity `2 - High`,
priority `2`, skip any Test Case action."

This is an offline workflow replay. The bootstrap, the intent, and the intent-aware
duplicate review already completed against the real org. The captured review result is
`executions/execu_20261010_0900/validation/bug-1.review.json`. Treat it as authoritative.
Do not call Azure, invoke `bug-report.js` or another script, run `prepare`/`execute`, edit
any file, or make any board write.

Review the captured result as the skill's step 4 directs and decide what the user must be
told and asked before a plan can be prepared. If the user must decide something, end with
that one bundled question as your final prose; there is no live user to answer it.

End your final message with EXACTLY these five lines:
CROSS_STORY_CANDIDATE: <bug id>@<its parent story id>, or NONE
WATCHLIST_MATCH: <watchlist entry id> (<kind>), or NONE
DUPLICATE_ALLOW_SET: <true|false>
QUESTION_ROUNDS: <number>
SCRIPT_OR_NETWORK_CALLS: <NONE, or what was called>
