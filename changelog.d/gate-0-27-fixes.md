### Fixed
- **A failed login that re-renders the password no longer leaks it to a snapshot.** After
  `--submit`, `fill_secret.js` now clears every input and textarea on the page the browser
  ends up on whose value equals the secret, not only the fields it filled itself, and counts
  them in `scrubbed`. The suite wizard's plain-string login (`browser_bridge.js fill-secret`)
  does the same. The suite wizard's login step says a snapshot is safe only after this scrub.
- **A failure note in the suite wizard survives a late `ended`.** A run marked `failed` stays
  failed; the wizard text now says to post `failed` on failure and `ended` only on success.
- **The editor's case drawer no longer shows the word `null`** under the message check and
  after "Last run".
- **Studio runs are named like every other run.** `executions/execu_<local time>` — the same
  `YYYY-MM-DD_HH-MM-SS` as `/test-endpoints`, from one shared helper.
- **The Save-conflict banner hides after Reload.**
- **`result.md` of a run started by "Approve and run" says "run from the suite wizard"**
  instead of "run from the editor".
