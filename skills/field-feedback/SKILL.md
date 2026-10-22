---
name: field-feedback
user-invocable: false
description: >
  Record a gap in the AgenTeX plugin itself. Use when you work around an AgenTeX skill, command or
  script that failed or could not do the job; when the user corrects the same thing a second time in
  this session; when you write your own helper script for something AgenTeX should do; or when an
  AgenTeX skill is copied into .claude/skills/. Appends one entry to .agentex/plugin-learnings.md
  through a bundled script, says one line and never asks. Also writes a sanitized export of those
  entries when the user asks to export or send their AgenTeX learnings or feedback.
---

# Field feedback: record a gap in AgenTeX itself

This skill keeps `.agentex/plugin-learnings.md`, the project's record of gaps in the AgenTeX
plugin that were worked around here. A bundled script does every write. You decide whether a
trigger fired, write the text, run the script and say one line. Nothing leaves this machine:
an export is a local file the user reviews and sends by hand.

## Rules

- A capture never asks the user and never stops the task, whether it succeeds or fails.
- Name env vars, never their values. Never read `.env` for an entry: the script strips values
  itself.
- Never edit an existing entry, never mark one absorbed by hand, and never create the file by
  hand. Entries are the user's to edit or delete; marking them belongs to `/update-agentex`
  (its rubric is `references/absorption.md`).
- Never retry the export with a weaker sanitizer, and never write an export yourself.
- Never open a browser, run `gh` or send anything. The user sends the export.
- Never print the export file into the chat unless the user asks.

**Why are you here?**
- A trigger fired while you worked (section 1) → **Capture**.
- The user asks to export or send their AgenTeX learnings or feedback, or `/update-agentex
  feedback` sent you here → **Export** (section 2).

## 1. Capture

1. **Decide whether a trigger fired.** Examples of each, positive and negative, are in
   `references/capture.md`.

   | What happened | `--trigger` | Also pass |
   |---|---|---|
   | You worked around an AgenTeX skill, command or script that failed or could not do the job | `workaround` | |
   | You wrote your own helper script for something AgenTeX should do | `self-written-script` | `--script <project-relative path>` |
   | An AgenTeX skill is copied into `.claude/skills/` | `forked-skill` | `--fork <project-relative path>` |
   | The user corrects the same thing a **second** time in this session | `repeated-correction` | |

   A correction given once is not a trigger: record nothing and carry on. The same correction
   counts only on its second occurrence in this session. Nothing fired → no entry.
2. **Write the problem and the workaround** in plain words. Name env vars, never their values.
   Never paste file contents, URLs, credentials or customer data.
3. **Run the script** from the project root, the text as JSON on stdin through a heredoc. Quote
   the delimiter (`'EOF'`) so the shell expands nothing:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/field_feedback.js" capture --trigger <trigger> --affected <name|unknown> --mode sequential [--script <path>] [--fork <path>] [--rule CLAUDE.md] <<'EOF'
   {"problem": "<what the plugin could not do>", "workaround": "<what was done instead>"}
   EOF
   ```

   `--affected` is the AgenTeX skill or command the gap is in (`test-design`, `update-agentex`),
   or `unknown`; the script turns a name it does not know into `unknown`. The script reads `.env`
   itself and strips every value it finds: never read `.env` for this. It prints one JSON line.
4. **Exit 0**: say exactly one line (`<affected>` is `unknown` when the JSON has
   `affectedCoerced: true`), then continue the task. Never ask, never wait:

   > Recorded an AgenTeX learning (`<trigger>` · `<affected>`) in `.agentex/plugin-learnings.md`.
5. **Exit 1 or 2**: nothing was written. Say one line, "Could not record an AgenTeX learning:
   `<reason>`." with the reason from the JSON line, and continue the task.

**A rule for the plugin.** When you add a `CLAUDE.md` rule *because of* a plugin gap, tag it
`[agentex:promote]`, record a learning in the same step, and pass `--rule CLAUDE.md`.

## 2. Export

Read `references/export.md` and follow it. In short: one `export` run; on `OK`, tell the path and
the category counts, ask the user to read the whole file, and explain the manual send; on
`NOTHING_TO_EXPORT`, say there is nothing to export; on a hard stop, give the reason, say no
file exists, and give the fix.
