### Added
- **Field feedback: AgenTeX records the gaps it had to work around.** A new model-only skill,
  `field-feedback`, appends one entry to `.agentex/plugin-learnings.md` (committed, created on
  first use) when the agent works around an AgenTeX skill, command or script, when the user
  corrects the same thing a second time in a session, when it writes its own helper script for
  something AgenTeX should do, or when an AgenTeX skill is copied into `.claude/skills/`. It
  says one line and never asks; a failed capture is one line and the task continues. Every
  write goes through `scripts/field_feedback.js capture`, which strips `.env` values and token
  shapes. The qa, mobile-qa and api executors record with `--mode parallel` and list the ids
  on a `LEARNINGS:` line; the three orchestrators relay one line per id at MERGE.
- **`/update-agentex feedback`** writes a sanitized export of the open learnings to
  `.agentex/scratch/field-feedback/` and does nothing else. Secrets, names, URLs, hosts,
  addresses, paths and test data become placeholders, a residue stops the export with no file,
  and the user reviews the file and sends it by hand to the public tracker. AgenTeX never sends
  anything.
- **Absorption after a migration.** After `migrate.js` succeeds (or finds the project up to
  date), `/update-agentex` judges older open learnings and forked skills against the new
  version's changelog and skills, and behind one yes/no marks covered entries absorbed and
  moves covered forks to `.agentex/scratch/field-feedback/retired-skills/`. A decline changes
  nothing. When open learnings remain, one closing line points to `/update-agentex feedback`.
- **`docs/field-feedback.md`**: the learnings file, the export and the manual send, and
  absorption. `docs/putting-your-project-in-git.md` lists the learnings file as committed.
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
