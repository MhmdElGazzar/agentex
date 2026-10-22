### Added
- **A field feedback loop's scripts: `scripts/field_feedback.js`.** `capture` appends one
  entry to `.agentex/plugin-learnings.md` (created with its header on the first one) when an
  agent works around a gap in the plugin. `.env` values, short values after a password label
  and credential shapes are replaced before the write, so no secret reaches the file; 20
  parallel captures give 20 intact entries; under CI it runs as `mode: ci`. `forks` lists the
  project's copies of plugin skills. `export` writes ONE sanitized file under
  `.agentex/scratch/field-feedback/` (the open entries and the names of forked plugin
  skills, with counts of what was replaced and never the values) for the user to review and
  send by hand. It refuses when the folder is not git-ignored, when a config file does not
  parse, or when any residue is left, and writes nothing. `absorb-candidates`,
  `absorb-preview` and `absorb-apply` back the `/update-agentex` absorption step: open
  entries older than the installed version and forked plugin skills, each with the CHANGELOG
  lines that may cover it; a sha-bound plan; one all-or-nothing apply that marks exactly the
  entry lines and moves only the listed forks into scratch, losslessly. Nothing in the loop
  reaches the network, and `CLAUDE.md` is never edited.
- **Two rows in the AgenTeX block of `CLAUDE.md`:** where a workaround for a gap in the plugin
  goes (`.agentex/plugin-learnings.md`, through the `field-feedback` skill only) and how a
  rule the plugin should adopt is tagged (`[agentex:promote]`). `/update-agentex` refreshes a
  pristine block with them (migration 13, no new migration); a block edited by hand is flagged
  as before. The learnings file is plugin-defined, so the stray-file check never reports it.
  The block's size budget moves from 3 KB to 4 KB.
- **`repository` in `plugin.json`**, the public link the export header points the user to.
- **A maintainer harvest, `scripts/harvest/harvest.js`**, that reads consumer projects
  read-only (never `.env` or `test/.auth/`, no git, no network) and writes a grouped report
  outside the plugin repo, the planning repo and every root. It is never shipped to a host
  branch and no command or skill mentions it. Contributor page:
  `docs/contributing/field-feedback-harvest.md`.
