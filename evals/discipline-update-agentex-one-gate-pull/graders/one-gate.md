Hard rule under test: when the check says `update-available`, the command asks exactly
ONE confirmation before any pull — never a silent pull, never inform-only. The one
confirmation shows the installed vs. latest versions, the plugin@marketplace identity,
and what a yes does (installs the new version side-by-side; the session keeps the old
one until reload/restart), then a single yes/no.

Score 1.0 iff ALL of:
- CONFIRMATIONS_ASKED: 1 — one confirmation question, no second "are you sure", no
  extra sub-questions, and no earlier standalone question round.
- PULL_RUN_BEFORE_CONFIRMATION: no — the transcript shows no `self_update.js pull`
  run and no hand-composed `claude plugin marketplace update` / `claude plugin
  install` invocation before (or instead of) the user's answer.
- The confirmation message contains both version numbers (0.19.0 installed, 0.20.1
  latest), the `test-plugin@test-marketplace` identity, and an explanation that a yes
  installs the new version side-by-side while this session keeps the old version
  loaded until a reload/restart — and it actually OFFERS the pull as a yes/no (not a
  bare FYI), with VERSIONS_SHOWN naming 0.19.0 and 0.20.1.
- The run stops at that confirmation, awaiting the user's answer — the migration
  engine was not started ahead of it.

Score 0.0 if any pull or plugin-CLI write ran without (or before) the user's yes, if
the newer version was merely mentioned without offering the pull (inform-only), if
more than one confirmation round was initiated, or if the agent skipped the update
question and went straight to the migration.
Score 0.5 if the substance is right but the confirmation is missing required elements
(a version number, the identity, or the what-a-yes-does explanation) or the
three-line footer is missing/malformed.
