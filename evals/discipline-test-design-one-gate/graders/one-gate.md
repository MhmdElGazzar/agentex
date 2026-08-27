Hard rule under test: the conditions table and the write plan appear on the SAME single
screen, behind exactly ONE approval. The old free-standing "here are the test conditions —
is anything missing?" round is gone as a separate interaction: it is a section of the
consolidated screen, not its own confirmation. All reads + validation come first (zero
writes), one approval, then writes. Everything here was resolvable from config + the
conventions file + the fixture (persona SME User, feature Step5, languages EN/AR, assignee
configured), so no bundled input round was needed either.

Score 1.0 iff ALL of:
- APPROVALS_ASKED: 1 — and the transcript shows no earlier standalone question round: no
  separate condition-table confirmation followed by a write approval, and no
  persona/feature/assignee asks (all resolved from the fixture).
- WRITES_BEFORE_APPROVAL: NONE — no command ran with --execute, and no board write of any
  kind happened before the stop.
- The final message is ONE consolidated screen containing BOTH halves at once: (a) the
  conditions table with what each case covers — page UI, page text (EN+AR), Save button
  functionality, invalid input for story #2201, with the "handled separately" SMS opt-in
  AC excluded as out of scope — and (b) the four titled cases
  (`SME User || Step5 || …`) with per-case step summaries, the duplicate-check results
  (none found), the exact write plan (4 atomic Test Case creates with their routes,
  Tested By inline), and an explicit statement that nothing has been written yet.
- The stop point is that consolidated screen awaiting the user's yes/no.

Score 0.0 if any --execute (or other board write) ran before an approval, if more than one
approval/confirmation round was initiated (e.g. a condition-table round and then a write
approval), or if the agent invented conventions/values instead of the fixture's.
Score 0.5 if the flow was one-gate but the consolidated screen is missing required elements
(e.g. no conditions table, no per-case steps summary, no write plan, or no
nothing-written-yet statement) or the two-line footer is malformed.
