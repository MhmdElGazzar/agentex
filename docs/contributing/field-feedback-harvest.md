# The field-feedback loop and the maintainer harvest

AgenTeX learns from the projects that use it, without any project sending anything
automatically. This page covers the loop end to end and the maintainer's harvest script.
The user-facing side is [field-feedback.md](../field-feedback.md).

## The loop

1. **Capture.** When an agent works around a gap in AgenTeX (a plugin skill, command or
   script failed or could not do the job, the user corrected the same thing twice, the agent
   wrote a helper script for something AgenTeX should do, or an AgenTeX skill was copied into
   `.claude/skills/`), the `field-feedback` skill appends one entry to
   `.agentex/plugin-learnings.md` through `scripts/field_feedback.js capture`, says so in
   one line and carries on. It never asks. Secret values never reach the file: `.env` values
   and credential shapes are replaced before the write.
2. **Absorb on update.** After `/update-agentex` has migrated the project, one message lists
   the entries the new version may cover and the forked plugin skills, with the CHANGELOG
   lines that back each item. One yes marks the entries absorbed (exactly the entry line
   changes) and moves the listed forks into `.agentex/scratch/field-feedback/retired-skills/`.
   A no changes nothing and is asked again next time. A plan with items to review by hand only
   is told, not asked. `CLAUDE.md` is never edited.
3. **Export.** `/update-agentex feedback` writes a sanitized file of the open entries to
   `.agentex/scratch/field-feedback/` and stops. The user reads it and sends it by hand.
4. **Harvest.** The maintainer reads every consumer project they can reach, read-only, with
   `scripts/harvest/harvest.js`, and triages the report.

## What leaves a machine, and what does not

- **Nothing leaves automatically.** No script of this loop reaches the network. The export
  is a file; the user sends it.
- **Sanitization is best effort, not a guarantee.** The export header says so and tells the
  user to read every line. Four layers run in order: secrets (the project's own `.env`
  values and credential shapes), names from the project's config and test data, structural
  patterns (URLs, emails, addresses, paths, hostnames), then a re-scan of the result. Any
  residue, an unparseable config file or a missing secret layer stops the export with no
  file. Counts of what was replaced appear in the file, never the values.
- **The destination is public.** The header names the plugin's public issue tracker and the
  `field-feedback` label (the link comes from `repository` in `plugin.json`). Anything sent
  there can be read by anyone.
- **The entries are the user's.** They may edit or delete any entry. Only the plugin appends
  or marks one.
- **Commit the learnings file before a migration.** `.agentex/` is migration-owned, so an
  uncommitted `plugin-learnings.md` stops a real migration. The absorption step also refuses
  to touch an uncommitted learnings file or a forked skill with uncommitted edits, and says
  which paths to commit.

## Running the harvest

```
node scripts/harvest/harvest.js --root <project> [--root <project>…] [--roots-file <file>] [--out <dir>]
```

Roots also come from `AGENTEX_HARVEST_ROOTS`; there is no default. The script lives under
`scripts/harvest/` and no host ships it. See [its README](../../scripts/harvest/README.md) for the
signals it reads and the exit codes.

It only reads. It never opens `.env` files or `test/.auth/`, starts no process and touches no
network. It writes two files, `report.md` and `report.json`, and refuses a destination inside
the plugin repo, the planning repo or any root.

**The report contains consumer specifics. It stays out of the plugin repo and the planning repo.**
Open the report, group what repeats, and write each finding up in general terms: the gap, the
skill it touches and the evidence count, never a project's names, URLs or data. A learning
the harvest lists as absorbed needs no action.

## For contributors

- `scripts/lib/learnings.js` owns the entry grammar (`schemaVersion` 1) and the append lock;
  `plugin_inventory.js` lists skills and commands and detects forks;
  `feedback_sanitize.js` is the export sanitizer and `sanitizeEntry` its pure per-entry core.
- The harvest reuses the learnings parser and the fork detection, so the grammar has one home.
- A new test seam environment variable goes into `INTERNAL_ENV` in `scripts/lint_plugin.js`
  with its reason. `AGENTEX_HARVEST_ROOTS` is there as maintainer-only and never appears in
  a consumer `.env.example`.
