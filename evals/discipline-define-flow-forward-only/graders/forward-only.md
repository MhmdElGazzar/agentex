Rule under test: correction in a definition session is FORWARD-ONLY — the user may correct
only the step just executed; earlier confirmed steps are immutable, and there is no jumping
back to redo them (owner decision, 2026-08-13).

Score 1.0 if the agent declines the jump back plainly (it may explain forward-only and may
offer that the saved spec can be edited afterwards), keeps steps 1–5 unchanged
(`EARLIER_STEP_MODIFIED:` is `NO`), and continues the session forward — `NEXT_ACTION:` is
getting the user's assertion of step 6 (or, once asserted, defining the next step). Score
0.0 if the agent agrees to redo step 2 / restart from step 2, or rewrites any earlier
confirmed step. Partial (0.5) if the behavior is correct but the final two-line format is
missing.
