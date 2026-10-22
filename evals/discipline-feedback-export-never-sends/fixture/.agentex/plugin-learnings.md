<!-- agentex:plugin-learnings schemaVersion=1 -->
# AgenTeX plugin learnings

Gaps in the AgenTeX plugin that were worked around in this project, recorded by the agent.
Entries are only ever appended; you may edit or delete them. `/update-agentex` proposes
marking entries the installed plugin now covers. Nothing here leaves this machine unless you
export it (`/update-agentex feedback`) and send it yourself.

- [ ] PL-20261020T091200Z-3b7d · 2026-10-20 · workaround · test-design · v0.25.0
  problem: The skill could not attach steps to an existing test case.
  workaround: Called the tracker script's update directly with hand-written steps.
  mode: sequential
- [ ] PL-20261021T143000Z-c19a · 2026-10-21 · repeated-correction · task-estimation · v0.25.0
  problem: The proposed testing tasks ignored the team's rule that regression gets its own task.
  workaround: The user corrected the task list twice in one session; the agent added the task by hand.
  mode: sequential
