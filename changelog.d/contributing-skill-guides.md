### Added
- **Two contributor guides on writing skills.** `docs/contributing/writing-a-good-skill.md`
  covers a `SKILL.md` that a person can read and Claude can follow: a description that says
  what the skill does and when, hard rules first because only the first 5,000 tokens survive
  compaction, the size limits, the writing rules, scripts for fixed mechanics, and the
  frontmatter mistakes that silently drop a setting. `docs/contributing/writing-an-orchestrator-skill.md`
  covers a skill or agent that hands work to subagents: what a subagent cannot do (ask the
  user, see the conversation), where the orchestrator should live, the worker contract,
  deferred questions, one approval before any write, batches under the subagent limit, and
  hooks for rules that must never break.
  The guides were first written in Arabic. In the English versions the references to the
  maintainers' own validator commands and checklists, the `project-manager` example and the
  `claude --agent` mentions were replaced by the rules themselves or by a generic example,
  because those tools are not part of the shipped plugin.
