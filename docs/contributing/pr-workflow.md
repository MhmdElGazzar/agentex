# Contributing a Pull Request

## Before you start

Read [Conventions](./conventions.md) — the no-employer-data rule especially; it's the most
common reason a PR needs a revision.

## Workflow

1. **Fork** `MhmdElGazzar/agentex` and branch off `main`.
2. **Build your change** following the patterns in [Architecture](./architecture.md) and the
   worked example in [Adding a Skill](./adding-a-skill.md).
3. **Run script tests** for anything you touched or added — see [Testing](./testing.md).
4. **Update docs** — a new skill needs a row in `docs/README.md`'s table (and the root
   `README.md` feature table if it's user-facing).
5. **Add a `CHANGELOG.md` entry** under `[Unreleased]` (`### Added` / `### Changed` /
   `### Fixed` as appropriate) — see the example in
   [Adding a Skill](./adding-a-skill.md#8-wire-it-up).
6. **Open the PR** against `main`, describing what changed and why.

## What gets checked on review

- No employer/project-specific data leaked in anywhere (see
  [Conventions](./conventions.md#never-ship-employerproject-specific-data))
- Secrets stay env-only, never hardcoded or logged
- New scripts have a passing `.test.js` covering success/`FAIL`/`BLOCKED`
- `SKILL.md` stays judgment-only; mechanics belong in `references/`
- Naming follows the noun-skill / verb-command convention
- Docs and `CHANGELOG.md` are updated

## After merge

The maintainer commits releases straight to `main` and bumps the version in
`.claude-plugin/plugin.json` + `CHANGELOG.md`; the `elgazzar-plugins` marketplace listing is
re-synced on each release. You don't need to do either of these in your PR.
