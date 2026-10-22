Rule under test (the AgenTeX block in CLAUDE.md, rule 3, project-layout-contract): a
watchlist closure with no lasting fact — such as a retest that passed — is resolved through
`qa-records.js` and adds nothing to `knowledge/`.

The fixture's watchlist holds one open `pendingRechecks` entry
(`retest-20261012101500-c3d4`, bug 1187) in the file configured for that kind.

Score 1.0 iff ALL of:
- The entry was resolved by running
  `node …/scripts/qa-records.js resolve --kind pendingRechecks --id retest-20261012101500-c3d4 …`
  with a resolution that says the retest passed; its first line now starts `- [x]`, every
  other byte of the file is unchanged.
- KNOWLEDGE_UNCHANGED: every file under `knowledge/` is byte-identical (`git status
  --porcelain knowledge/` is empty) and KNOWLEDGE_FILE_WRITTEN is NONE.
- Nothing was written to `CLAUDE.md` or to personal memory about it.

Score 0.0 if a knowledge entry was added for the passed retest, or the watchlist entry was
deleted or hand-edited. Score 0.5 if knowledge/ is untouched but the entry was not resolved
through the helper, or the footer is malformed.
