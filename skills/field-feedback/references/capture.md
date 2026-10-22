# Capture: when a gap in AgenTeX is worth one entry

An entry records a gap in the **AgenTeX plugin itself**: one of its skills, commands or
scripts could not do what the project needed, and something else was done instead. Problems
with the application under test, its environment or its tools go to `knowledge/gotchas.md`,
never here (`${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`).

## The four triggers

### `workaround`: an AgenTeX skill, command or script failed or could not do the job

- **Record.** Test design could not attach steps to an existing test case; you called the
  tracker script's `update` directly with hand-written steps.
  `--trigger workaround --affected test-design`
- **Record.** The HTML report could not show a run that was split over two sessions; you
  merged the two run summaries yourself before generating it.
- **Do not record.** A runner reported BLOCKED because a catalog entry is missing. That is the
  plugin working as designed: report it, never work around it.
- **Do not record.** The application returned a 500 and the test failed. That is a defect in
  the application, not in AgenTeX.

### `repeated-correction`: the user corrects the same thing a second time in this session

- **Record, on the second time.** The user tells you twice in this session that the test case
  titles AgenTeX proposes must start with the story id. The second correction is the trigger.
- **Do not record.** The user corrects a title format once. One correction is not a trigger;
  if it comes again in this session, it is.
- **Do not record.** The user corrects a fact about the application (a page name, a rule). That
  belongs to `knowledge/`, not here.

### `self-written-script`: you wrote a helper script for something AgenTeX should do

- **Record.** You wrote `.agentex/scratch/probes/merge-csv.mjs` to merge two test-data CSVs
  because no AgenTeX flow can.
  `--trigger self-written-script --affected unknown --script .agentex/scratch/probes/merge-csv.mjs`
- **Do not record.** A one-off probe to read a page's structure during a run. Probing is part
  of testing, not a missing plugin feature.

### `forked-skill`: an AgenTeX skill is copied into `.claude/skills/`

- **Record.** `.claude/skills/task-estimation/` is a copy of the AgenTeX skill with an edited
  weights table, whether you copied it or found it there.
  `--trigger forked-skill --affected task-estimation --fork .claude/skills/task-estimation/`
- **Do not record.** A project skill in `.claude/skills/` that does something AgenTeX has no
  skill for and does not claim to replace one.

## The fields

- `problem`: what the plugin could not do, in one or two plain sentences.
- `workaround`: what was done instead.
- `script:` (`--script`), `fork:` (`--fork`): the project-relative path of the helper script or
  the forked skill folder. Both stay on this machine: the export drops them.
- `rule:` (`--rule CLAUDE.md`): pass it when you added a `CLAUDE.md` rule tagged
  `[agentex:promote]` because of this gap.

## Writing the text

Name the env var, never its value. Name the skill, the flag or the step; never paste file
contents, URLs, host names, credentials, user names or customer data.

- **Good.** "workaround: Called the tracker's REST API directly, authenticated with the
  `TRACKER_PAT` variable from `.env`."
- **Bad.** The full `curl` command with the token, the organization URL, or the work item's
  text.

The script also strips every `.env` value and every token shape it finds, but that is a safety
net, not permission: write the text so there is nothing to strip.
