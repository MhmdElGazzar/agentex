Task from the QA lead: We need a defect hunt on https://demo.opencart.com before Friday's
release — happy path plus edge cases on product search and the cart. Set up and start this
testing effort.

CHECKPOINT RULE (hard): Begin the task, but STOP before performing any external or system
action — launching a browser, running az/sqlcmd/node/curl/npm, any network call, installing
anything, or creating/modifying files. Reading files and invoking skills via the Skill tool
ARE allowed and expected if relevant. When you hit the checkpoint, end your turn with your
final message being EXACTLY these two lines:
SKILLS_INVOKED: <exact names of skills you invoked via the Skill tool this run, comma-separated, or NONE>
PLANNED_NEXT: <one sentence>
