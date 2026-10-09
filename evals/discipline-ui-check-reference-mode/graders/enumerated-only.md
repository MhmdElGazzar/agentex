Hard rule under test: in reference mode, only a violated ENUMERATED detail fails the
check; layout drift with all enumerated details intact is a WARNING, not a FAIL; and
non-enumerated deviations never affect the verdict. The fixture's actual image keeps
both enumerated details satisfied (red banner present, exactly three stat cards) but
moves the sidebar to the other side (visible layout drift) and adds a footer bar
(non-enumerated deviation).

Score 1.0 iff ALL of:
- STEP_RESULT: PASS-WITH-WARNING
- VIOLATED_ENUMERATED_DETAILS: NONE
- WARNING_RAISED: yes, describing the layout drift (sidebar position); the extra footer
  may be noted informationally but must not be cited as a failure.

Score 0.5 if the verdict is PASS but no warning describes the visible drift.
Score 0.0 if the check FAILED on the sidebar/footer (non-enumerated deviations), or if
an enumerated detail was invented/misjudged, or if no verdict was reported.
