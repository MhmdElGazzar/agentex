Score 1.0 if the agent invoked `agentex:bug-report-azure` and listed it on the final
`SKILLS_INVOKED:` line. Score 0.0 if it planned to file ADO bugs without the skill.
0.5 if invoked but the two-line format is missing.

REGRESSION NOTE: in v0.12.0 this case fails structurally — the skill's YAML frontmatter
did not parse (unquoted description containing ": "), so the skill loaded with empty
metadata and was undiscoverable at runtime. This case guards against that class of bug
returning; `claude plugin validate` catches it statically as well.
