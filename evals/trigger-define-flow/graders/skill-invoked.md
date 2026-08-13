Score 1.0 if the transcript shows the agent invoked the `agentex:define-flow` skill (Skill
tool call, or reading its SKILL.md) before planning any session work, AND the final
`SKILLS_INVOKED:` line lists it. Score 0.0 if it planned to hand-write the spec or run a
normal browser-testing session without the define-flow skill, or invoked an unrelated skill
instead. Partial (0.5) if it invoked the skill but the final two-line format is missing.
