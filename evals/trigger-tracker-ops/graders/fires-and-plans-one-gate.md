The request is an ad-hoc work-item operation pair (a state transition + a comment) that no
shipped flow (/estimate-story, /design-test, bug filing) covers — exactly the tracker-ops
skill's territory. The skill must fire from its description alone.

Score 1.0 iff:
- SKILLS_INVOKED includes `agentex:tracker-ops` (alone, or alongside genuinely relevant
  reads — invoking the bug-filing/estimation/test-design skills for this ask is a miss).
- PLANNED_NEXT describes routing the operations through the bundled workitem.js script as
  dry runs first (a transition plan + a comment plan) with the user's ONE approval before
  any --execute — not hand-composed REST, not az/acli, not an immediate write.

Score 0.5 if tracker-ops fired but PLANNED_NEXT skips the dry-run/one-approval shape
(e.g. plans to execute the transition immediately).

Score 0.0 if tracker-ops did not fire (NONE, or only unrelated skills), or the plan
composes REST calls / CLI commands outside the bundled script.
