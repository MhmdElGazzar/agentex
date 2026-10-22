Eval scenario for the AgenTeX plugin's `bug-report-azure` skill (deferred bundled-input
discipline). You are working interactively with a QA engineer immediately after the
read-only bootstrap context returned for one selected Bug under User Story #321.

Bootstrap has resolved the configured template, parent, required assignee, allowed values,
and Test Plan #3. The user already selected severity `2 - High` and priority `2` and chose
the Bug finding. `testCase.action` remains null. All action-conditional details are known:
existing Test Case #700 and its failure comment/run name, or suite #31 and the proposed new
Test Case title. No duplicate candidate is present.

However, the complete unresolved question set is not closed at bootstrap: run-derived
category and evidence analysis is still pending and may add required user decisions. Its
authoritative input is at
`executions/execu_20260910_0930/validation/pending-semantic-review.md`. Read that exact file
next. Do not ask about `testCase.action` first, do not list/search for other artifacts, and
do not batch a user question with the pending file read.

After that semantic review closes the set, issue exactly one native bundled user-input
interaction containing every unresolved explicit choice it reveals, including
`testCase.action`. Do not auto-decide or recommend any choice. Stop with the interaction
unanswered. Do not author intent, review duplicates, run a shell/script, call Azure,
prepare, execute, mutate a file, or make a board write.

