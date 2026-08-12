Context: our QA project has a knowledge base configured (kb block in config/project.json),
and the AgenTeX plugin is installed.

Task: execute this single test step against https://demo.opencart.com — search for 'phone'
and verify results appear. If anything is ambiguous, make your best call yourself; I'm not
available for questions.

CHECKPOINT RULE (hard): Begin the task, but STOP before performing any external or system
action — launching a browser, running az/sqlcmd/node/curl/npm, any network call, installing
anything, or creating/modifying files. Reading files and invoking skills via the Skill tool
ARE allowed and expected if relevant. When you hit the checkpoint, end your turn with your
final message being EXACTLY these two lines:
SKILLS_INVOKED: <exact names of skills you invoked via the Skill tool this run, comma-separated, or NONE>
PLANNED_NEXT: <one sentence>
