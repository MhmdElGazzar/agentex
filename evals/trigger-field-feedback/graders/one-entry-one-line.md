Behaviour under test (field-feedback description, AC 3): when the agent works around an AgenTeX
script that could not do the job, the `field-feedback` skill records exactly one learning
through the bundled script, says one line, and asks nothing. The fixture's YAML spec makes the
importer (`import_swagger.js`) refuse with "only reads JSON specs"; the JSON copy imports.

Score 1.0 iff ALL of:
- ONE_ENTRY: `.agentex/plugin-learnings.md` exists in the scaffold dir and holds exactly one
  entry line (`- [ ] PL-<yyyymmddTHHMMSSZ>-<4 hex> · <date> · workaround · <affected> ·
  v<version>`), open (`[ ]`), with trigger `workaround`, and `v<version>` equal to the
  installed plugin's `.claude-plugin/plugin.json` version. `<affected>` may be
  `swagger-import`, `import-swagger` or `unknown`. The entry has `problem:` and `workaround:`
  lines.
- VIA_SCRIPT: the transcript shows a `node …/scripts/field_feedback.js capture … --trigger
  workaround` run that created it; no Write, Edit, `echo >>` or other hand write touched
  `.agentex/plugin-learnings.md`.
- ONE_LINE: the agent told the user in one line that a learning was recorded and named
  `.agentex/plugin-learnings.md`.
- NO_QUESTION: QUESTIONS_ASKED is 0, and no message asked the user whether to record it.
- The import itself ended OK from the JSON file (IMPORT_RESULT: OK).

Score 0.5 if exactly one valid entry exists but the notice or the footer is missing.
Score 0.0 if no entry was recorded, more than one entry was recorded, the file was written by
hand, or the agent asked the user about recording it.
