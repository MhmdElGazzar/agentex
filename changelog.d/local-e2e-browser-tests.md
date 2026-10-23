### Added
- **Browser tests can skip, and say so.** The maintainer test runner now knows a skip: an
  `*.e2e.test.js` that exits 77 with a `SKIP: <reason>` line is counted as skipped (listed on
  stderr and in the JSON), while 77 from any other test stays a failure. `--require-e2e` turns
  every skip into a failure, and `scripts/dev/affected.js` no longer lists paid evals for browser
  test files. Documented in `docs/contributing/testing.md`.
