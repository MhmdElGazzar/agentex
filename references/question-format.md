# Writing a question for a human reader

For any skill that asks a person something in writing: a clarification on a story, a
comment on a defect, a question posted on the tracker. The reader is busy and reads it
later, out of context.

**Why it matters.** A question with labelled options gets a fast, decisive reply. An open
question ("how should this work?") gets a vague one, or none, and the work waits.

## The rules

1. **Scenario, then two or three concrete options, then a real question.** Describe the
   situation in one or two sentences, list the realistic answers as labelled options, and
   end with a question the reader can answer by picking one.

   > On the search page, the search field accepts an empty query. Which should happen?
   > **(A)** the search runs and lists everything; **(B)** the button stays disabled until
   > something is typed; **(C)** a validation message appears. Which one is intended?

2. **One decision per point.** Two decisions in one paragraph get one answer. Number them
   and keep each to its own options.

3. **Only real options.** Every option must be something the product could plausibly do.
   No padding, no straw man to make one option look right.

4. **Name the evidence.** Point at something the reader can open: the story id, the
   acceptance criterion, the test case id, the screenshot. "As seen in the export story"
   is not evidence; the story's id is.

   > Story 1204, criterion 3 says the export "includes all columns", but the sample file in
   > the story has six of nine. **(A)** all nine columns; **(B)** the six in the sample.
   > Which one is right?

5. **Drop what is not in question.** If something is already clear, state it once as an
   assumption ("Assuming the export keeps the current file format …") instead of asking
   about it.

6. **Blockers first.** Order the points by what stops the work: a question that blocks
   testing comes before one that only refines a case.

## Titles

Defect and test-case titles follow test-design's Title Convention:
[`../skills/test-design/SKILL.md`](../skills/test-design/SKILL.md) §Step 4. This file does
not restate it.
