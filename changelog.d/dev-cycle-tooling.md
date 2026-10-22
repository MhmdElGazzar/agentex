### Changed
- **Maintainer tooling: changelog fragments and file-level eval selection.** Nothing here
  reaches a consumer.
  - A feature now adds `changelog.d/<slug>.md` instead of editing `CHANGELOG.md`, so merges
    into a moving `main` stop conflicting there. `node scripts/dev/changelog.js --check`
    validates the fragments; `--assemble <X.Y.Z>` folds them (and any `[Unreleased]` section)
    into the release section at release time. `changelog.d` is excluded from every host build
    and inert in the release-gate plan.
  - `scripts/dev/affected.js`: an `evals/coverage.json` pattern that names a folder no longer
    matches a changed script (a `.js` outside `*.test.js`), directly or through a file that
    requires it, so a script edit in a skill stops selecting every eval of that skill. A
    pattern naming a file still matches it; prompts, references and data keep matching folder
    patterns.
