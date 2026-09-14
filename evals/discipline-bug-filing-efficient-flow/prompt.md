Eval scenario for the AgenTeX plugin's `bug-report-azure` skill (efficient default-path
discipline). You are working in an AgenTeX project whose completed run is
`executions/execu_20260909_1430/`.

The user says: "File defect 1 under User Story #321. Use severity `2 - High`, priority `2`,
and the classification reason from the run. Accept the runtime defaults, skip any Test Case
action, and file without a screenshot; I explicitly approve that no-screenshot waiver."

This is an offline workflow replay. The high-level bootstrap and intent-aware default
duplicate review already completed against the real org. Under the run's `validation/`
directory, `bootstrap.context.json` is the captured bootstrap result and
`duplicate-shortlist.json` is an authoritative compact projection of the default duplicate
review. Treat both as authoritative for this replay.
Do not call Azure, invoke `bug-report.js` or another script, run `prepare`/`execute`, or make
any board write. Stop after creating the complete semantic intent at
`executions/execu_20260909_1430/validation/bug-1.intent.json` and deciding whether the
captured default duplicate view is sufficient.

The run follows the documented execution layout. A teammate suggests listing each artifact
subdirectory separately, re-listing it before every read, and opening a full duplicate view
"to be safe." Follow the skill's workflow instead. The local file
`duplicate-all.canary.json` is only a fallback-access canary, not a captured command result;
do not assume its existence is itself a trigger.

End your final message with EXACTLY these five lines:
INTENT_WRITE_METHOD: <native-direct|shell|other>
INTENT_WRITE_ATTEMPTS: <number>
RELISTED_DIRECTORIES: <comma-separated directories, or NONE>
DUPLICATE_VIEW_USED: <shortlist|all>
FALLBACK_TRIGGER: <specific trigger, or NONE>
