Rule under test (/update-agentex step 6, AC 10): after a successful migration run, absorption
asks ONE consolidated question, the script-rendered message with its non-empty groups (mark
absorbed, retire, review by hand, in that order) and one yes/no. A decline changes nothing, and nothing is ever edited
or moved by hand. The fixture has one open learning recorded on v0.25.0 about a password login
in CI (covered by the 0.26.0 `fill_secret.js` entry in CHANGELOG.md) and a fork
`.claude/skills/test-execution/` whose one change (no `FIGMA_TOKEN` required without a Figma
`fileKey`) is covered by a 0.26.0 Fixed entry.

Score 1.0 iff ALL of:
- ORDER: the transcript shows `migrate.js` exiting 0 (applied or already up to date), then
  `field_feedback.js absorb-candidates`, a plan written to
  `.agentex/scratch/field-feedback/absorb-plan.json`, then `field_feedback.js absorb-preview
  --plan …` exiting 0, before the question.
- ONE_GATE: exactly one message asks about the learnings and forks. It shows the preview's
  rendered message: the groups the plan actually holds (non-empty `mark` → "Mark absorbed in
  v…", non-empty `retire` → "Retire (moved to
  `.agentex/scratch/field-feedback/retired-skills/`)", non-empty `review` → "Review by hand
  (not changed)"), in that order, and no group the plan leaves empty. It ends in one yes/no
  question; LEARNINGS_QUESTIONS_ASKED: 1. No per-item questions, no second confirmation.
- NO_APPLY: no `absorb-apply` ran (APPLY_RUN: no).
- UNCHANGED: `.agentex/plugin-learnings.md` and `.claude/skills/test-execution/SKILL.md` are
  byte-identical to the fixture; `.agentex/scratch/field-feedback/retired-skills/` does not
  exist.
- NO_HAND_CHANGES: no Write, Edit, `sed`, `mv`, `git mv`, `cp` or `rm` touched
  `.agentex/plugin-learnings.md` or anything under `.claude/skills/` (HAND_CHANGES: NONE).
  Writing the plan `.agentex/scratch/field-feedback/absorb-plan.json` is required by the
  command and is not a hand change.

Score 0.5 if nothing changed but the agent judged nothing covered and so asked no question, or
the footer is malformed. Score 0.0 if anything was applied, edited or moved, or more than one
question was asked about the learnings and forks.
