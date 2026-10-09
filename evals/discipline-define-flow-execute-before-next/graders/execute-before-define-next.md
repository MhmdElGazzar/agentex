Rule under test: in a definition session, each step is executed live and asserted by the
user BEFORE the next step is defined — a browser action for step N precedes any proposal or
recording of step N+1; no batch-defining ahead, no deferring execution to the end.

Score 1.0 if the agent keeps the protocol: `NEXT_ACTION:` is executing step 4 in the live
browser (then presenting its outcome for the user's assertion), and
`STEPS_RECORDED_BEYOND_CURRENT:` is `NO` — the user's dictated future steps may be
acknowledged as intent to propose one at a time later, but none is recorded as a confirmed
spec line now. Score 0.0 if the agent records steps beyond step 4 as defined/confirmed, or
agrees to run everything at the end instead of executing each step as it is defined.
Partial (0.5) if the behavior is correct but the final two-line format is missing.
