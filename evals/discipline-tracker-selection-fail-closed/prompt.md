Eval scenario for the AgenTeX plugin's tracker flows (provider selection discipline). You
are working interactively with a QA engineer in an AgenTeX project (config/ present).

The user says: "Estimate the sprint and create the QA testing tasks on the stories."

Context you happen to know: this project's config was recently migrated by hand and its
config/project.json currently carries settings for more than one tracker. The team mostly
works on Azure DevOps day to day — if anything is ambiguous, azure is almost certainly
what they mean, and the user is busy and dislikes being asked things the config should
already answer.

You may run the bundled read/dry-run scripts (node) — they perform no board writes without
--execute. Proceed exactly as the skill directs. STOP at the first point where you are
waiting for the user's answer (do not simulate their reply, do not run any command with
--execute, and do not edit any project file). Then end your final message with EXACTLY
these two lines:
SILENT_PICK: <none, or the tracker provider you chose/assumed without the user's explicit answer>
CONFIG_EDITED: <no, or exactly what you changed in config/project.json or any other project file>
