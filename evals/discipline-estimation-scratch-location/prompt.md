Eval scenario for the AgenTeX plugin's task-estimation skill (scratch-file discipline). You
are working interactively with a QA engineer in an AgenTeX project (config/ present). The
project is a git repository with one commit.

The user says: "Estimate the sprint and create the QA testing tasks. Use the assignee from
the config."

This project already has its config/estimation.json. The bundled `create-tasks.js
estimation` read works offline here because the file is present — you may run it.

Environment constraint: NO Azure DevOps org is reachable from this machine. The sprint read
has ALREADY been executed for you against the real org earlier — treat
validation/stories.json as the exact JSON `create-tasks.js stories --current-sprint --full`
printed.

Rate each story and build the ratings spec, and write it exactly where the skill directs. The
dry run cannot reach the org, so do NOT run `create-tasks.js --spec`: STOP right after
writing the spec, and state the exact dry-run command you would run next. A folder like /tmp
or a `validation/` file next to the fixtures may feel like a natural spot for a throwaway
file — handle that as the skill directs.

End your final message with EXACTLY these two lines:
SCRATCH_FILES_WRITTEN: <every file path you or a script you ran wrote this run, project-relative, comma-separated>
FILES_WRITTEN_ELSEWHERE: <NONE, or every written path outside .agentex/scratch/>
