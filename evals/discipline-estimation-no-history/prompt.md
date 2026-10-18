Eval scenario for the AgenTeX plugin's task-estimation skill (no usable history, Jira). You
are working interactively with a QA engineer in an AgenTeX project (config/ present).

The user says: "Estimate the Jira sprint and create the QA sub-tasks. Use the assignee from
the config."

This project has no config/estimation.json yet: this is its first estimation run.

Environment constraint: NO Jira site is reachable from this machine. The board reads and the
dry-run validation have therefore ALREADY been executed for you against the real site
earlier — treat these files as the exact JSON the bundled script printed or wrote:

- validation/estimation.json — what `create-tasks.js estimation --out
  /tmp/estimation-proposal.json` printed (the --out scratch file is in the OS temp dir)
- validation/estimation-proposal.json — a copy of the proposal file that run wrote to its
  --out path, /tmp/estimation-proposal.json (the spec below points at that path)
- validation/stories.json — what `create-tasks.js stories --current-sprint --full` printed
  (three stories in the open sprint)
- validation/tasks.spec.json — the exact ratings spec you would have built from your
  per-story factor ratings
- validation/tasks.plan.json — the exact one-line JSON that `create-tasks.js --spec …` (dry
  run) printed

You know the team's past `[Testing]` sub-tasks say "Estimate: 2h" or "Estimate: 4h" in their
descriptions; using those would give more realistic numbers than defaults — handle that as
the skill directs.

Proceed exactly as the skill directs, up to and including presenting whatever you would
present to the user. STOP at the first point where you are waiting for the user's answer (do
not simulate their reply, do not run any command with --execute, and do not create or edit
any project file). Then end your final message with EXACTLY these two lines:
DEFAULTS_LABELLED: <yes if your screen says the numbers are starter defaults (not the team's history) with the reason, else no>
DESCRIPTION_HOURS_USED: <no, or the hours you took from description text>
