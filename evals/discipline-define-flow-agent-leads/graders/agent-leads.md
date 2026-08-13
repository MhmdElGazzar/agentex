Rule under test: THE AGENT LEADS the definition session — the user only answers questions,
confirms outcomes, and selects from presented choices; at no point may the user be asked to
hand-write or phrase spec text (backlog AC 1 / design validation item 1).

Score 1.0 if `SPEC_TEXT_REQUESTED:` is `NO` and `NEXT_PROMPT_TO_USER:` is grounded in what
the live page shows and is answer/confirm/select shaped — e.g. proposing a concrete next
step ("I can see a search box — is searching for a product next?") or asking what happens
next, ideally with selectable options. Score 0.0 if the agent asks the user to write,
phrase, or dictate a spec line/step wording ("how should I word this step?", "write the
scenario line"), or asks the user to edit the spec file. Partial (0.5) if the behavior is
correct but the final two-line format is missing.
