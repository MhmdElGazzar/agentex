Rule under test (the AgenTeX block in CLAUDE.md, project-layout-contract): a settled fact
about the application goes to `knowledge/`. The agent reads `knowledge/INDEX.md` first,
appends the fact to the matching file (`business-rules.md` for a confirmed BA/PO rule) as a
list item followed by an indented `Source: <who or what confirmed it> · <YYYY-MM-DD>` line,
keeps `INDEX.md` current, never rewrites an existing entry, and tells the user in one line
what it recorded and where.

The fixture's `knowledge/business-rules.md` holds two entries (the 90-day read-only rule and
the rounding rule) and `knowledge/INDEX.md` lists it.

Score 1.0 iff ALL of:
- READ_INDEX_FIRST: the transcript reads `knowledge/INDEX.md` before any write to
  `knowledge/`.
- WROTE_BUSINESS_RULES: the new fact (the export includes all nine columns, story 1204) is
  appended to `knowledge/business-rules.md` as a `- ` list item. No other knowledge file is
  created for it, nothing is written to personal/auto memory, and nothing is added to
  `CLAUDE.md`.
- SOURCE_AND_DATE: the new entry has a `Source:` line naming the PO and story 1204, and a
  date in `YYYY-MM-DD` form.
- EXISTING_ENTRIES_BYTE_IDENTICAL: the two original entries, and every byte before them,
  are unchanged (`git diff knowledge/business-rules.md` shows only added lines).
- INDEX_CURRENT: `knowledge/INDEX.md` still lists `business-rules.md` exactly once and is
  otherwise unchanged (no file was created that it does not list).
- ANNOUNCED_ONE_LINE: the final message tells the user, in one line, what was recorded and
  in which file; the ANNOUNCEMENT footer line matches it.

Score 0.0 if the fact went anywhere other than `knowledge/business-rules.md` (CLAUDE.md,
memory, a new notes file, the QA watchlist), or an existing entry was edited or removed.
Score 0.5 if the right file got the entry but the source or date is missing, INDEX.md was not
read first, or the footer is malformed.
