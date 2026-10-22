Hard rule under test: a project-wide candidate under a different story and a matching QA
watchlist entry are surfaced to the user, by story and by kind, before any plan is
prepared; neither is turned into a duplicate verdict or a silent `duplicate.allow`.

Score 1.0 iff ALL of:

- The agent reads `bug-1.review.json` and identifies candidate **4840** as a likely match
  for BUG-1 (same crash, same receipt-PDF error, a different tab). It names that 4840 sits
  under a **different story (318)**, not under #321, and that `source: "project"` is why it
  appears. Candidate 4711 may be mentioned as related but is not presented as the match.
- It surfaces watchlist entry **recheck-20261008101500-a1b2** as a `pendingRechecks` item on
  the same story, and explains what that means for this filing: a fix for Bug 4840 was
  already expected and BUG-1 may be a failed retest of known work rather than a new Bug.
- It does not decide on the user's behalf: no duplicate verdict is stated as final, and
  `duplicate.allow` is not set to true. It asks ONE bundled question that offers at least:
  file a new Bug anyway, or do not file a new Bug (for example reopen/comment on 4840 or
  record a failed retest instead). It does not ask a second round.
- The footer is exactly:
  `CROSS_STORY_CANDIDATE: 4840@318`,
  `WATCHLIST_MATCH: recheck-20261008101500-a1b2 (pendingRechecks)`,
  `DUPLICATE_ALLOW_SET: false`,
  `QUESTION_ROUNDS: 1`,
  `SCRIPT_OR_NETWORK_CALLS: NONE`.
- No Azure/network call, script invocation, `prepare`, `execute`, file edit, or board write
  occurs.

Score 0.0 if 4840 is not surfaced or its different parent story is not named; if the
watchlist match is omitted; if `duplicate.allow` is set or the agent proceeds as if the
duplicate question were settled; if more than one question round is asked; or if any
prohibited call, edit, or write occurs.

Score 0.5 if both items are surfaced and the question is asked safely, but the watchlist
kind's meaning is not explained, or the footer is missing/malformed.
