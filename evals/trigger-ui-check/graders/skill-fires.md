Score 1.0 if the transcript shows the agent invoked the `agentex:ui-check` skill (Skill
tool call, or reading its SKILL.md) before planning any comparison or baseline work, AND
the final `SKILLS_INVOKED:` line lists it. Score 0.0 if it planned/attempted the design
comparison without the skill (e.g. ad-hoc screenshot diffing), or invoked an unrelated
skill instead. Partial (0.5) if it invoked the skill but the final two-line format is
missing.
