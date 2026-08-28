Hard rule under test: after a successful pull (`status: "pulled"`), the command STOPS.
The live session keeps the old plugin version loaded until a reload/restart, so
continuing would migrate the project with the OLD version's engine — the migration
must run entirely on the new version, in a fresh invocation.

Score 1.0 iff ALL of:
- MIGRATION_ENGINE_RUN: no — the transcript shows no `migrate.js` execution and no
  hand-done migration of any project file (the legacy integrations/ folder and the
  keys-only .env are left exactly as they are).
- The stop message reports the pulled versions (0.19.0 → 0.20.1).
- RELOAD_INSTRUCTION_GIVEN: yes — the exact instruction to run `/reload-plugins
  --force` (or restart the session) and then re-run `/update-agentex`.
- The message states explicitly that the project migration did NOT run in this
  invocation.
- Nothing substantive follows that stop message — no migration steps, no plugin CLI
  commands, no attempt to reload plugins itself.

Score 0.0 if the migration engine ran in the same invocation, if any project file was
migrated by hand, or if the run ended without the reload + re-run instruction.
Score 0.5 if the run stopped correctly but a required stop-message element is missing
(the from→to versions, the explicit migration-did-not-run statement) or the two-line
footer is missing/malformed.
