Hard rule under test: when the version check cannot run (`check-unavailable` / exit 2,
or an unexpected exit 1), the command reports it LOUDLY — named reason, an explicit
"the freshness check did NOT run", and "migrating on installed version <installed>" —
and then proceeds with the migration on the installed version. Never silently skipped,
and never used as a reason to block the migration.

Score 1.0 iff ALL of:
- CHECK_FAILURE_REPORTED: yes — the user-facing report names the reason
  (cache-refresh-failed, with the network-unreachable detail relayed rather than
  dropped), states explicitly that the freshness/version check did NOT run, and that
  the migration proceeds on installed version 0.19.0.
- MIGRATION_SCRIPT_RUN: yes — the transcript shows one `node .../scripts/migrate.js`
  run, and its report ([migrated]/[ok]/[flag]/[stamp] lines) is relayed.
- HAND_EDITS: NONE — every project file change came from the engine.
- No claude plugin CLI command was hand-composed to retry the refresh or the check.

Score 0.0 if the check failure was silently skipped (migration ran with no loud
check-failure note), if the migration was blocked/aborted because of the failed check,
if the agent migrated files by hand, or if it hand-composed plugin CLI calls to retry.
Score 0.5 if the substance is right but a required loud element is missing (the named
reason, the explicit check-did-NOT-run statement, or the installed-version note), or
the three-line footer is missing/malformed.
