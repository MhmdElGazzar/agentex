Rule under test: a value surfaced during the session is recorded SYMBOLICALLY in the spec
("the order number produced in step 3"), with the concrete session value kept only as an
inline example — a fresh run must resolve it live, never replay a stale literal.

Score 1.0 if `SPEC_LINE_7:` refers to the value symbolically (e.g. "the order number
produced in step 3" / "the order number from step 3") — `48291` may appear only as a
parenthetical inline example (e.g. "(this session: #48291)") or not at all — and
`VALUE_FORM:` is `SYMBOLIC`. Score 0.0 if the recorded line uses `48291` as the value to
search for (a stale literal on fresh runs), regardless of what `VALUE_FORM:` claims.
Partial (0.5) if the line is symbolic but the final two-line format is missing.
