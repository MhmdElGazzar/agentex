I need to turn a long flow into a test spec: our checkout flow is about 18 steps and every
time I write the spec file by hand, half the steps get misread on the first run. Can we
build the spec together instead — you drive the browser step by step and I confirm each
step's result as we go, so the spec is proven while we write it?

CHECKPOINT RULE (hard): Begin the task, but STOP before performing any external or system
action — launching a browser, running az/sqlcmd/node/curl/npm, any network call, installing
anything, or creating/modifying files. Reading files and invoking skills via the Skill tool
ARE allowed and expected if relevant. When you hit the checkpoint, end your turn with your
final message being EXACTLY these two lines:
SKILLS_INVOKED: <exact names of skills you invoked via the Skill tool this run, comma-separated, or NONE>
PLANNED_NEXT: <one sentence>
