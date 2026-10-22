# Field feedback: AgenTeX learns from your project

Sometimes the agent has to work around AgenTeX itself: a skill could not do the job, you had
to correct it twice, it wrote a helper script for something AgenTeX should do, or someone copied
an AgenTeX skill into `.claude/skills/` to change it. Each of those is a gap in the plugin. This
page explains how AgenTeX records them in your project, how you can send them to the AgenTeX
maintainers, and how a later version retires the ones it fixed.

**Nothing leaves your machine.** AgenTeX never sends anything anywhere. Sending feedback is
always something you do yourself, by hand, after reading it.

## The learnings file

Gaps are recorded in `.agentex/plugin-learnings.md` in your project. The file is created the
first time something is recorded; a project with no file simply has no learnings yet.

```markdown
- [ ] PL-20261022T101500Z-7f3a · 2026-10-22 · workaround · test-design · v0.26.0
  problem: The skill could not attach steps to an existing test case.
  workaround: Called the tracker CLI's update directly with hand-written steps.
  mode: sequential
```

Each entry has an id, the date, what triggered it, the AgenTeX skill or command it is about,
and the plugin version it was recorded on, then the problem and the workaround in plain words.

- **When the agent records one.** It worked around an AgenTeX skill, command or script that
  failed or could not do the job; you corrected the same thing a second time in one session (a
  single correction records nothing); it wrote its own helper script for something AgenTeX
  should do; or it found an AgenTeX skill copied into `.claude/skills/`. Parallel runs record
  them too, and the run's summary lists each one.
- **What you see.** One line, such as "Recorded an AgenTeX learning (`workaround` ·
  `test-design`) in `.agentex/plugin-learnings.md`." The agent never asks and never stops the
  task for it. If recording fails, it says so in one line and carries on.
- **What it holds.** Env-var names, never their values; no file contents, URLs, credentials or
  customer data. A bundled script writes every entry and strips any `.env` value or token shape
  that slips into the text.
- **The entries are yours.** The agent only ever appends. You may edit or delete any entry.
- **Commit the file.** It is meant to be committed with the rest of your project. Commit it
  before you run `/update-agentex`: the migration needs a clean git tree, and an uncommitted
  learnings file stops it.

A rule you add to `CLAUDE.md` because of a plugin gap can be tagged `[agentex:promote]`: it marks
the rule as one the plugin itself might adopt.

## Sending feedback: `/update-agentex feedback`

`/update-agentex feedback` writes a sanitized copy of your open learnings and does nothing else
(no update check, no migration). You can also just ask the agent to export or send your AgenTeX
feedback.

1. The export is one file, `.agentex/scratch/field-feedback/export-<timestamp>.md`. That folder
   is gitignored; if it is not in your project yet, the export refuses and tells you to run
   `/update-agentex` first. Your learnings file is not changed.
2. Before writing, AgenTeX replaces secrets, organization, project and site names, URLs, host
   names, IP and email addresses, user names, paths and test data with placeholders such as
   `<secret>` or `<org-name>`, then re-checks the result. Anything left over stops the export,
   and no file is written. Forked skills appear by the AgenTeX skill name only, never your
   folder's name or content.
3. The agent tells you the path and how many values of each kind were replaced. It never shows
   the values.

**Sanitization is best effort, not a guarantee.** Read the whole file and remove anything that
identifies your organization, client, application or data.

**The destination is public.** To send it, open the AgenTeX public issue tracker (the link is in
the file's header), start a new issue, add the `field-feedback` label, paste the file's contents
and remove anything you are unsure about. Anyone can read what you post there.

## After an update: retiring what the new version covers

After `/update-agentex` migrates your project (or finds it already up to date), it checks your
open learnings recorded on an older version, and the forked skills in `.claude/skills/`, against
the new version's changelog and skills.

- When nothing is covered, it says nothing.
- When some forks only need a look, it lists them to review by hand and asks nothing.
- Otherwise it shows **one** message with up to three groups (entries to mark absorbed, forks to
  retire, forks to review by hand; an empty group is left out). One yes or no.
  - **Yes**: the entries are marked `[x]` with `absorbed in v<version>` (only those lines
    change), and the retired forks move to `.agentex/scratch/field-feedback/retired-skills/`
    (moved, never deleted; nothing is overwritten). Commit the result with the migration.
    If moving a fork fails, the marks already written stay and the agent lists what was
    applied; nothing is retried.
  - **No**, or no answer: nothing changes, and the same items are offered again next time.
- If the learnings file or a fork has uncommitted changes, it asks you to commit them first and
  re-run.

At the end, when open learnings remain, `/update-agentex` adds one line: "N open AgenTeX
learnings — `/update-agentex feedback` writes a sanitized export you can review and send."
