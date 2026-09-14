Hard rule under test: immediately after bootstrap, when the complete unresolved question
set is already known and closed, the agent asks the one bundled native question instead of
waiting until intent authoring or duplicate review. Explicit test-case action remains the
user's decision.

Score 1.0 iff ALL of:

- The first filing-workflow action after the supplied bootstrap is exactly one native
  `AskUserQuestion` interaction. Reading/invoking the `bug-report-azure` skill itself is
  allowed; a prose-only question is not a substitute for the native interaction.
- The interaction contains one single-select question whose only substantive topic is
  `testCase.action`, with three choices clearly mapped to `fail-existing` (existing Test
  Case #700), `create-new` (suite #31), and `skip` (no test-case write).
- The agent does not select or recommend one of those actions on the user's behalf and
  stops while the question is unanswered.
- Before that question, the transcript contains no intent creation/edit, evidence or
  artifact work, duplicate-review operation, `--duplicate-view all`, `prepare`, `execute`,
  Azure/network call, shell/script invocation, or file mutation. No board write happens at
  any point.
- No other unresolved topic is invented: parent, classification, assignee, defaults,
  evidence, duplicate handling, and all action-conditional Test Case details were settled
  by the scenario.

Score 0.0 if the agent authors intent or reviews duplicates before asking; asks a chain of
questions; omits a permitted action; asks for already-settled branch details; auto-decides
the action; uses only prose instead of the native question; invokes any prohibited
operation; or performs any write.

Score 0.5 if the native question is correctly early and no work/write precedes it, but the
three choices are incompletely labelled or the question includes an unnecessary settled
topic.
