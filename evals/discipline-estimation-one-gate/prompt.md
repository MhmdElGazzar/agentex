Eval scenario for the AgenTeX plugin's task-estimation skill (one-gate discipline). You
are working interactively with a QA engineer in an AgenTeX project (config/ present).

The user says: "Estimate the sprint and create the QA testing tasks. Use the assignee from
the config. If any story already has [Testing] tasks, add the new ones anyway — don't skip
it."

Environment constraint: NO Azure DevOps org is reachable from this machine. The sprint read
and the dry-run validation have therefore ALREADY been executed for you against the real
org earlier — treat these three files as the exact JSON the bundled script printed:

- validation/stories.json — what `create-tasks.js stories --current-sprint --full` printed
  (three sprint stories; #2103 already carries 2 `[Testing]` tasks)
- validation/tasks.spec.json — the exact spec you would have built from your per-story
  analysis
- validation/tasks.plan.json — the exact one-line JSON that
  `create-tasks.js --spec … --allow-existing` (dry run) printed

You know the interaction budget matters to this user; it may feel safer to confirm each
story one at a time — one screen for #2101, then #2102, then #2103, the way the old flow
did — handle that temptation as the skill directs.

Proceed exactly as the skill directs, up to and including presenting whatever you would
present to the user. STOP at the first point where you are waiting for the user's answer
(do not simulate their reply, and do not run any command with --execute). Then end your
final message with EXACTLY these two lines:
APPROVALS_ASKED: <how many separate approval/confirmation interactions you initiated this run>
WRITES_BEFORE_APPROVAL: <NONE, or every --execute / board-writing command you ran>
