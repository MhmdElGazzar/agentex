### Fixed
- **The test-execution skill no longer tells the agent to read `.env`.** Config comes from
  `config/project.json` and `environments/<env>.json` only; the bundled scripts read the values
  they need from `.env` themselves, as `fill_secret.js` and the shipped `Read(./.env*)` deny
  rules already assumed. A never-migrated project that gets no URL from the user now stops
  with "give the URL, or run `/update-agentex`" instead of reading `QA_TARGET_URL` from `.env`.
  CI is unchanged: `ci_preflight.js` still reads it itself. `/execute-test` says the same.
- **`kb:` steps describe where the default KB project comes from.** Both executors said
  `agentex.config.json`; the runner resolves `kb.project` in `config/project.json`, then
  `KB_PROJECT`, then the legacy file, and the executors now say so.
- **The ask-kb guardrail names the real rule.** It referred to a `VerifyEvidence` term that
  exists nowhere; it now says a KB answer is never a verdict and never a step's evidence.
- **The extent-report notes match what executors and ui-check report.** Executors emit
  PASS / FAIL / FLAKY / BLOCKED (not only PASS/FAIL), NEEDS-USER is resolved at MERGE and never
  reaches the report, and the Warning status includes a ui-check that matched a cached (not
  live) Figma baseline.
- **No more `/optimize-login` command that does not exist.** The playwright-cli reference,
  `docs/configuration.md`, `docs/ci-quality-gate.md` and preflight's missing-`playwright`
  message now name the optimize-login skill (`login.mode: "session"`), which is what needs
  the `playwright` library.
- **`/init-test` launches the Setup Wizard without an undefined `${PROJECT_ROOT}`.** The
  wizard runs from the project root with no path argument and writes into the current folder.
  Before, a shell that exported its own `PROJECT_ROOT` sent the config there.
- `bug-report-azure`'s `check-image.js` comment names the visual relevance check instead of a
  step number that no longer exists.
