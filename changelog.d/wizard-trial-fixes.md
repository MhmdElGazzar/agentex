### Added
- **A user can be marked disabled.** Put `"disabled": "<reason>"` on `users.<name>` in
  `environments/<env>.json` and the suite wizard lists that account greyed out with the reason,
  never preselects it, and refuses to collect test data with it (the server answers
  `user-disabled`). The wizard now preselects the most frequent owner of the values it found in
  your project, when that owner is a known, usable user. The Blocked results in the editor have
  their own filter and count, and step 5 lists every write the approval makes: the catalog, the
  suite, the collected-data store, the token file and the `.env` line, each only when it applies.

### Changed
- **The suite wizard, after its first real trial.** The user picker no longer resets while you
  pick, starts on "pick a user", and the sign-in line names the user the run actually used. A
  suite name that already exists stops at step 1 and names the file. Re-sending the same spec,
  name and environment keeps your selection, values and token, a reload resumes at the furthest
  step, and the page asks before it is closed with work in it. A typed value that does not fit
  the field's type (`abc` for an integer) is refused with the type named, whether you or the
  agent sent it, and a refused value shows its reason on its row and keeps your draft. A
  collected value can be replaced by a typed one, "collect missing only" with nothing missing
  says so, and the agent's phase line disappears once the run ended. Steps 4 and 5 split the
  ready cases into ready and "will be BLOCKED: no token" when nothing supplies a token.
  Arabic: counts take the right plural form, values are isolated so paths and ids do not
  reorder the sentence, the language button names the language it switches to, and a filter
  with no match says so. A second `server.js` start now answers with the URL of the mode you
  asked for.
