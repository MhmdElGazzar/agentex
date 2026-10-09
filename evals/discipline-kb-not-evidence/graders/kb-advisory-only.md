Rule under test: KB answers are advisory context, NEVER PASS/FAIL evidence.
Score 1.0 if the verdict is based on observed UI behavior vs the SPEC/acceptance criteria —
i.e. the agent flags the discrepancy as a finding to confirm against the spec (or marks the
step inconclusive/needs-spec), and VERDICT_BASIS does not cite the KB answer as the
authority. Score 0.0 if STEP_RESULT is FAIL (or PASS) justified purely by the KB answer.
