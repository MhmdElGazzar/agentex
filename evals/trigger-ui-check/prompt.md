Task from the QA lead: Our checkout story's acceptance criteria say the page must match
the approved design. The spec step is:

ui-check: image test/baselines/checkout-desktop.png — mode: exact

The app is already open in the browser under test at the checkout page. Execute this
design-conformance step.

CHECKPOINT RULE (hard): Begin the task, but STOP before performing any external or system
action — launching or driving a browser, running az/sqlcmd/node/curl/npm, any network
call, installing anything, or creating/modifying files. Reading files and invoking skills
via the Skill tool ARE allowed and expected if relevant. When you hit the checkpoint, end
your turn with your final message being EXACTLY these two lines:
SKILLS_INVOKED: <exact names of skills you invoked via the Skill tool this run, comma-separated, or NONE>
PLANNED_NEXT: <one sentence>
