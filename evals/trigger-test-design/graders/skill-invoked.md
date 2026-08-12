Score 1.0 if the agent invoked `agentex:test-design` (or the `agentex:design-test` command
skill) and listed it on the final `SKILLS_INVOKED:` line. Score 0.0 if it started designing
test cases or composing az commands without the skill. 0.5 if invoked but the two-line
format is missing.
