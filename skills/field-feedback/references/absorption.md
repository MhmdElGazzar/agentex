# Absorption: judging what a new AgenTeX version covers

`/update-agentex` step 6 uses this rubric after a migration. A script lists the candidates and
their evidence, you judge each one, and you write a plan. The script then renders the one
question, and only a yes lets it change anything. You never edit the learnings file or move a
fork yourself.

## The input

`absorb-candidates` prints one JSON line:

- `installed`: the installed plugin version;
- `entries[]`: the open learnings recorded on an **older** version than `installed`;
- `forks[]`: the project skills in `.claude/skills/` that copy or override a plugin skill: the
  plugin skill `plugin`, the detection `rule` and the local `path`;
- for each item, `evidence.changelog[]` (`version`, `file`, `fromLine`, `toLine`,
  `namesAffected`): the plugin's `CHANGELOG.md` sections to read. For an entry they cover the
  versions after the one it was recorded on; for a fork, the whole file;
- for each item, `evidence.skillFile`: the installed plugin's `SKILL.md` for that skill;
- `blockedBy[]`: paths with uncommitted changes that the apply would touch.

## Reading the evidence

- Read each changelog range by its line numbers, and the installed `skillFile`.
- For a fork, also read the fork's own `SKILL.md` at its local `path` to see what it changes.
  It is read on this machine only: never quote it in the plan, the question or the chat, and it
  is never exported.
- `namesAffected: true` means the section names the skill. It is a hint, not proof.

## The verdict per item

| Verdict | When | Plan |
|---|---|---|
| **covered** | The evidence shows, specifically, that the installed version now does what the entry's problem needed, or everything the fork changes | an entry → `mark`; a fork → `retire` |
| **partly covered** (forks only) | Some of the fork's changes are covered and others are not, or you cannot tell what the fork changes | `review`, with a one-line `why` |
| **not covered** | Nothing in the evidence addresses it | left out of the plan |

An entry that is only partly covered stays open: it counts as not covered. When you hesitate
between two verdicts, take the weaker one.

## The plan

Write it to `.agentex/scratch/field-feedback/absorb-plan.json` (gitignored scratch:
`${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`):

```json
{
  "schemaVersion": 1,
  "installed": "<installed, as the script gave it>",
  "mark":   [{ "id": "<entry id>", "lineSha": "<the entry's lineSha, as given>" }],
  "retire": [{ "path": "<fork path, as given>", "plugin": "<plugin skill>" }],
  "review": [{ "path": "<fork path, as given>", "plugin": "<plugin skill>", "why": "<one line>" }]
}
```

Copy every id, hash and path exactly as the script gave it. A path goes in `retire` or in
`review`, never both. Never change the plan after the preview: the apply is bound to its hash.
