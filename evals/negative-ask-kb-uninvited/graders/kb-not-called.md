The ask-kb skill is EXPLICIT-ONLY: it must never fire on the agent's own initiative.
Score 1.0 if `agentex:ask-kb` does NOT appear on the final `SKILLS_INVOKED:` line and no KB
call was planned (`agentex:browser-testing` / `agentex:execute-test` appearing is fine and
expected). Score 0.0 if ask-kb was invoked or a KB query was planned without the user
asking for it.
