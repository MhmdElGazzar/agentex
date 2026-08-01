# User Manual Track — Design

**Date:** 2026-08-01
**Status:** Approved by user
**Scope:** Second of two content tracks (contributor docs shipped first). This spec covers
restructuring the existing `docs/` folder into a friendlier, walkthrough-style user manual.

## Purpose

The existing `docs/` folder is a solid technical reference (tables, terse bullets) but assumes
the reader already knows Claude Code and AgenTeX jargon. This track restructures it into a
manual usable by someone with **no prior technical background** — a QA person who has never
used an AI coding tool — while keeping the existing reference tables for quick lookup.

## Scope

**New pages:**
- `docs/using-claude-code.md` — absolute basics: typing a prompt, what a slash command is, how
  approving an agent's action works. Linked first from `getting-started.md` so every other page
  can assume the reader already knows this.
- `docs/optimize-login.md` — currently missing entirely (the only feature whose README row
  links straight to `skills/optimize-login/SKILL.md` instead of a `docs/` page). Written fresh
  in the new style.

**Restructured pages** (same shape applied to each, content updated only where it's now
inaccurate — otherwise reorganized, not rewritten from scratch):
`getting-started.md`, `browser-testing.md`, `api-db-steps.md`, `ask-kb.md`, `azure-devops.md`,
`extent-report.md`, `configuration.md`.

**Per-page shape:**
1. Plain-language intro — what the feature does for the reader, no jargon.
2. One or more walkthroughs — a real example prompt the reader would type, what Claude shows
   or asks at each step, what the reader sees when it's done.
3. **Quick reference** section at the bottom — the existing tables/bullets, preserved for
   lookup by a returning user who doesn't want the narrative again.

`configuration.md` is naturally reference-heavy (a list of env vars); it gets a short
walkthrough ("filling in `.env` for a typical first project") but stays mostly table-driven —
forcing a long narrative onto an inherently look-up page would work against clarity.

**Also:**
- `docs/README.md`'s index table gets `using-claude-code.md` and `optimize-login.md` added,
  and is reordered so `using-claude-code.md` comes before the feature pages.
- Root `README.md`'s feature table row for "Optimize login" is repointed from
  `skills/optimize-login/SKILL.md` to `docs/optimize-login.md`.

## Content accuracy

Every walkthrough example (prompts, commands, expected output shapes) must match what the
underlying skill/command actually does — verified against the current `SKILL.md` /
`commands/*.md` / script source for that feature before being written into the doc, the same
way the contributor-docs track verified its worked example by actually running it. This is a
narrative restructuring, not new behavior — no example may claim a capability the code doesn't
have.

## Out of scope

- Any change to skill/command/script behavior — documentation only.
- Adding features not already shipped (e.g. no new flags or modes get invented for a walkthrough
  to look complete).
- A visual redesign (this is markdown prose restructuring, not a docs site/theme change).

## Verification

Documentation-only change. Verification is: (1) every walkthrough's example prompts/commands
match what the actual skill/command/script does, cross-checked against source; (2) internal
links and anchors across all `docs/` files (and the two `README.md`s) resolve; (3) no page loses
information the old version had — the quick-reference section must be a complete carryover of
the old tables/bullets, not a lossy trim.
