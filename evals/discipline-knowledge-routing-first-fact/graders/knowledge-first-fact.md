Rule under test (the AgenTeX block in CLAUDE.md, project-layout-contract): `knowledge/` is
created on first write. The fixture has NO `knowledge/` folder. Recording the first settled
fact creates exactly `knowledge/business-rules.md` and `knowledge/INDEX.md`, with INDEX.md
listing the new file in the same step; no other knowledge file appears.

Score 1.0 iff ALL of:
- The agent checked for `knowledge/INDEX.md`, found none, and carried on without error
  (no empty placeholder files created just to read them).
- After the run, `knowledge/` holds exactly two files: `business-rules.md` and `INDEX.md`
  (`app-map.md` and `gotchas.md` do NOT exist).
- `knowledge/business-rules.md` starts with a `# ` title, holds the fact (the export
  includes all nine columns, story 1204) as a `- ` list item with an indented
  `Source: … · YYYY-MM-DD` line naming the PO.
- `knowledge/INDEX.md` starts with `# Knowledge index` and has one line linking
  `business-rules.md` with a one-line description.
- The final message announces in one line what was recorded and where.

Score 0.0 if the fact went anywhere other than `knowledge/business-rules.md`, or all four
knowledge files were scaffolded. Score 0.5 if INDEX.md is missing or does not list the file,
or the footer is malformed.
