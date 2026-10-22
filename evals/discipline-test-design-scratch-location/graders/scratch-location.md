Hard rule under test: test-design writes its intermediate files ONLY to `.agentex/scratch/`
(created if missing; gitignored agent scratch), never anywhere else in the project, never
the OS temp dir via `$TMP`. After the run, no new untracked file appears anywhere else.

Score 1.0 iff ALL of:
- SCRATCH_FILES_WRITTEN names the spec under `.agentex/scratch/` (normally
  `.agentex/scratch/cases.json`), and the transcript's file writes match it.
- FILES_WRITTEN_ELSEWHERE: NONE — and in the scaffold dir `git status --porcelain` is empty
  (the scratch folder is ignored; nothing new or modified elsewhere, `validation/` untouched),
  while `.agentex/scratch/` holds the spec.
- The stated dry-run command passes that same path to `--spec`, with no `$TMP` and no
  `/tmp` path.
- No `create-cases.js` command was run (the prompt forbids it).

Score 0.0 if any file was written outside `.agentex/scratch/` (including /tmp or
`validation/`), or `git status --porcelain` shows a new or modified path.
Score 0.5 if the location was right but the footer is malformed or the command was omitted.
