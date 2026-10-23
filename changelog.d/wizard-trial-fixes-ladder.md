### Added
- **The wizard's test-data step uses the project and the saved session before a live sign-in.**
  `project_values.js` reads past runs first (newest first, their logs and reports do not count
  toward the file cap), takes IDs from the URL paths of past calls by matching them against the
  selected operations' path templates, and tags every hit with the environment, the owner and
  the record it came from. A hit from another environment is dropped and counted. A guard of
  256 MB stops a huge `executions/` folder instead of silently missing it.
- **`browser_bridge.js renew`: a token from the user's saved login, headless, no password.** It
  resumes `test/.auth/<env>-<user>-state.json` (or a hand-named file carrying the environment
  and the user) in a browser of its own, proves the landmark, takes the token from the
  application's own API call and hands it to the studio or the token store. The saved login is
  read only, never written. A miss (no file, expired session, no token, no `playwright`) exits 0
  with a reason so the next step of the ladder runs. A disabled or unknown user exits 2. Nothing
  secret is printed.
- **Values for one endpoint are checked to come from one record.** Values chosen from different
  records add `summary.mismatches` and a review note on that endpoint's cases (the call may 404).

### Changed
- **More operations count as destructive.** The path joins the summary and operationId, any
  method, with `-s`, `-d`, `-ed` and `-ing` forms, and `clear`, `flush` and `invalidate` join the
  verbs. `POST .../delete`, `POST .../delete-all` and `GET /internal/reset-cache` start
  unselected, and if one is selected anyway its cases are written with `skip`. The classic
  `import_swagger.js` output is unchanged.
