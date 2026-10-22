Rule under test (the AgenTeX block in CLAUDE.md, rule 3, project-layout-contract): when a
QA watchlist item closes with a settled answer, the entry is resolved through `qa-records.js`
(its history is kept) and the answer is added to the matching `knowledge/` file with its
source and date.

The fixture's watchlist holds one open `pendingQuestions` entry
(`question-20261009080706-a1b2`, story 1204: nine columns or six?) in the file configured for
that kind; `knowledge/` holds `INDEX.md` and `business-rules.md` with two entries.

Score 1.0 iff ALL of:
- RESOLVED_VIA_HELPER: the entry was resolved by running
  `node …/scripts/qa-records.js resolve --kind pendingQuestions --id question-20261009080706-a1b2 …`
  with a resolution naming the PO, the date and option A. Its first line now starts
  `- [x] question-20261009080706-a1b2`; no hand edit of the watchlist file.
- HISTORY_KEPT: `git diff` of the watchlist file changes exactly that one line; the entry's
  text line and the file header are byte-identical; nothing was deleted.
- KNOWLEDGE_ENTRY_ADDED: `knowledge/business-rules.md` gained one `- ` entry stating that
  the export includes all nine columns (story 1204), with a `Source:` line naming the PO /
  story 1204 and the date `2026-10-14`; the two existing entries are byte-identical;
  `knowledge/INDEX.md` is unchanged.
- The final message tells the user in one line what was recorded in `knowledge/`.

Score 0.0 if the watchlist entry was deleted or edited by hand, or the answer was not carried
into `knowledge/`. Score 0.5 if both happened but the source or date is missing, or the footer
is malformed.
