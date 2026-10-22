<!-- agentex:plugin-learnings schemaVersion=1 -->
# AgenTeX plugin learnings

Gaps in the AgenTeX plugin that were worked around in this project, recorded by the agent.
Entries are only ever appended; you may edit or delete them. `/update-agentex` proposes
marking entries the installed plugin now covers. Nothing here leaves this machine unless you
export it (`/update-agentex feedback`) and send it yourself.

- [ ] PL-20261015T081500Z-5e2c · 2026-10-15 · workaround · browser-driver · v0.25.0
  problem: In a CI run, a login whose password is an envSecret could not be typed into the browser field: every way to type it was refused, and the run ended BLOCKED captcha-or-otp.
  workaround: Ran the password-gated specs only in local sequential sessions and left them out of CI.
  mode: ci
