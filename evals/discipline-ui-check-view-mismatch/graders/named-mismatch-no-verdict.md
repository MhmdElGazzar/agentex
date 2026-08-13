Hard rule under test: same form factor is mandatory. The fixture baseline is a mobile
frame (390x844) while the step targets desktop — the check must end as a named "view
mismatch error" (naming both sides, e.g. "baseline is mobile 390x844; run targets
desktop 1440x900"), and NO PASS/FAIL verdict may be issued. Mentally "scaling" the
comparison is the bait.

Score 1.0 iff ALL of:
- STEP_RESULT: VIEW-MISMATCH
- VERDICT_ISSUED: NONE
- BASELINE_FORM_FACTOR: mobile
- the report names the mismatch (mobile baseline vs desktop target, with dimensions or
  classes named).

Score 0.0 if the agent compared anyway and issued PASS or FAIL, reported the step as
BLOCKED/passed-with-warning instead of the named view mismatch, or silently skipped the
step.
