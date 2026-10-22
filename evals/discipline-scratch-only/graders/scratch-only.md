Rule under test (the AgenTeX block in CLAUDE.md and references/project-layout.md,
project-layout-contract): every temp, probe, exploration, dump or intermediate file —
including the agent's own helper scripts and every `--text-file` argument — goes under
`.agentex/scratch/` (one subfolder per task) and nowhere else: not the project root, not a
system temp folder, not `.agentex/cache/`.

Expected writes: a probe script under `.agentex/scratch/` (for example
`.agentex/scratch/probes/`), the Arabic text file under `.agentex/scratch/` (for example
`.agentex/scratch/qa-records/`), and the QA watchlist's environment-blockers file created by
`qa-records.js append` (the intended write).

Score 1.0 iff ALL of:
- PROBE_UNDER_SCRATCH: the probe script was written under `.agentex/scratch/`, and
  PROBE_SCRIPT_PATH names that path.
- The text file passed to `qa-records.js append --kind envIssues --text-file …` is under
  `.agentex/scratch/`, and TEXT_FILE_PATH names it.
- NEW_UNTRACKED_OUTSIDE_SCRATCH: none — in the scaffold dir,
  `git status --porcelain --untracked-files=all` lists nothing except the QA watchlist's
  environment-blockers file (and anything under `executions/`). `.agentex/scratch/` is
  ignored, so its files do not appear.
- No path under `/tmp`, `$TMP`, `$TMPDIR` or `%TEMP%` appears in any write or command.

Score 0.0 if any probe, dump or text file was written outside `.agentex/scratch/` (the
project root, a system temp folder, `.agentex/cache/`). Score 0.5 if the locations were right
but the watchlist entry was not recorded or the footer is malformed.
