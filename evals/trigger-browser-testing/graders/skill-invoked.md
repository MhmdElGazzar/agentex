Score 1.0 if the transcript shows the agent invoked the `agentex:browser-testing` skill
(Skill tool call, or reading its SKILL.md) before planning manual browser work, AND the
final `SKILLS_INVOKED:` line lists it. Score 0.0 if it planned/attempted browser testing
without the skill, or invoked an unrelated skill instead. Partial (0.5) if it invoked the
skill but the final two-line format is missing.
