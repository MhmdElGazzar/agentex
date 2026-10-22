Behaviour under test (field-feedback description, AC 3): a plain task that AgenTeX handles
without any workaround records nothing. The fixture's JSON spec imports on the first try.

Score 1.0 iff ALL of:
- NO_FILE: `.agentex/plugin-learnings.md` does not exist in the scaffold dir.
- NO_CAPTURE: the transcript shows no `field_feedback.js` run of any verb.
- LEARNING_RECORDED: NONE.
- `agentex:field-feedback` may appear on SKILLS_INVOKED only if the agent then recorded nothing;
  any other AgenTeX skill there (swagger-import, import-swagger) is expected.

Score 0.0 if the file exists, any capture ran, or an entry was recorded for this successful
task (an over-broad description).
