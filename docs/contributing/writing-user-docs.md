# Writing User Docs

How to write the pages a user of AgenTeX reads, and how to check that a reader understood them.

A **reader test** is that check: someone who has never seen the project reads the page and
answers a fixed list of factual questions about it from the text alone. The score says how much
of the page got across. "It reads better" is not a measure; the score is.

## The rule

**What:** two habits, both about content and order:

1. **Define a term before its first use.** Write "acceptance criteria (ACs)" the first time,
   then "ACs". A term the reader has to guess costs them the sentence it sits in.
2. **Say the consequence of a mechanism in plain words.** Naming a mechanism does not tell the
   reader what it means for them. "Validated fail-closed" says how it works; "if validation
   fails, nothing is written to the board" says what happens to them.

**Why:** in a reader test on 2026-10-23, six public writing-style skills each rewrote part of
the README under the same rules (keep every fact, add none). None scored above the unchanged
text (7.5 of 9 each). The one gain came from defining "ACs" before using it (8.5 of 9). Every
reader missed that a validation failure writes nothing to the board, because the text never
said so. A fact missing from the text cannot be fixed by restyling it. Content and order decide
whether a reader understands, not word choice.

**When:** `README.md` and every page under `docs/`.

**When not:** user-facing prose inside a skill — its `description:` or its output templates —
is out of scope for this page.

**How:** write the facts first, in the order a reader needs them, then check with a reader test.
No style skill is needed or recommended: when a reader test misses something, add the missing
fact or definition; do not reword what is already there.

**Example:** the README's Tracker planning row said the flows are "validated fail-closed first".
Readers could not say what that means for the board. The row now adds: "Fail-closed means that
if validation (the checks every task or test case must pass, run before any write) fails,
nothing is written to the board."

**Pros/cons:** + a fix is usually one added fact, not a rewrite — but each definition or
consequence adds words to the page.

## Running a reader test

**Terms used below:**

- A **variant** is one version of the page under test (for example today's README and a draft
  that changes one row).
- The **answer key** is the correct answer to each question, taken from the facts the page is
  meant to teach.
- The **baseline** is the score recorded for the page as it stands, the number every new
  variant is compared with.
- A **blind reader** is a fresh reader with no repo context: a new model session (a subagent
  is enough) or a person who has not seen the project. It gets only the variant and the
  questions — never the repo, the answer key, or the design behind the change.

**When:** the maintainer runs it before a release that changed `README.md` or anything under
`docs/`. A score below the baseline is a finding the owner can waive at the release
confirmation. Contributors' PRs are not blocked by it, but running it on your own change is
the fastest way to see whether it works.

**How:**

1. **Write the questions.** 6-9 factual questions about what the page must teach, each with
   one answer that the text either states or does not. A question added later to prove that a
   fixed fact now gets across keeps its place in the set (the README set below has ten for that
   reason).
2. **Write the answer key before any reader runs.** A key written after reading the answers
   bends toward them.
3. **Give each variant to its own blind reader.** At least one fresh reader per variant (more
   readers on the same variant are fine, each fresh), never one reader for two variants. Tell it to answer from the text alone, to write "not stated" when the text
   does not say, to name the sentence it had to reread, and to give the text a clarity score
   from 1 to 10.
4. **Score each answer against the key:** 1 = correct and complete, 0.5 = partly right or a
   guess, 0 = wrong or "not stated". The variant's score is the sum.
5. **Read the misses.** A question every reader misses means a fact is missing from the text:
   fix the content (add the fact, define the term), not the style, and run the test again. The
   reread sentences show where a reader stumbled; with one reader per variant, clarity scores a
   point or two apart are noise.
6. **Compare with the baseline.** A score below the baseline is a finding. When no baseline is
   recorded yet, this score becomes the baseline.

## Appendix: the README question set

**Text under test:** `README.md`, at least its opening paragraph and the Tracker planning
(Azure DevOps or Jira Cloud) row of the features table — the two parts these questions cover.

| # | Question | Answer key |
|---|---|---|
| Q1 | What does AgenTeX give you at the end of a run? | A consolidated defect report, plus screenshot/log evidence |
| Q2 | What is the difference between the two run modes? | Sequential = human in the loop (you approve); parallel = autonomous, one session per spec file |
| Q3 | Will it change my application's source code? | No, never |
| Q4 | Which tasks does `/estimate-story` create, where does that list come from on the first run, and what are they on Jira? | The `[Testing]` tasks defined in `config/estimation.json`; the first run proposes them from the team's last closed sprints; on Jira, sub-tasks with time tracking |
| Q5 | Do I need to install the Azure CLI or a Jira CLI? | No; bundled scripts call the tracker REST API (no `az`, no `acli`) |
| Q6 | If one field is invalid, can the tracker end up with only some items written? | No; everything is validated first and it stops before writing (fail-closed) |
| Q7 | How many times am I asked to approve during one `/design-test` run? | Once (one consolidated approval per flow) |
| Q8 | Jira has no Test Case type. What does `/design-test` create there? | You choose what to create |
| Q9 | What does "AC" mean here? | Acceptance criteria |
| Q10 | If a field fails validation during `/design-test`, what has been written to the board? | Nothing; validation runs first and a failure stops before any write |

Baseline: to be measured by the verifier
