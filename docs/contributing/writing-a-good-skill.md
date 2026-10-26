# Writing a Good Skill

How to write a `SKILL.md` that a person can read and Claude can follow. The rules come from the
[official Claude Code skills documentation](https://code.claude.com/docs/en/skills) and from
what a review of AgenTeX's own skills turned up.

For a step-by-step build of a skill from scratch, see [Adding a Skill](./adding-a-skill.md).
This page is about **the quality of the writing**, not the steps to add one.

---

## 1. Before you write: do you need a skill at all?

Make a skill when:
- you find yourself **pasting the same instructions or the same steps** into the chat every time;
- a section of `CLAUDE.md` has grown into a **procedure** instead of a piece of information.

Do not make a skill for one or two lines of information. Those belong in `CLAUDE.md`.

---

## 2. The `description` is the most important line in the file

Claude Code lists every installed skill to Claude by its `description`. It is the only part of
the skill Claude **always** sees, and Claude decides from it alone whether to run the skill. The
body of the skill is loaded only after that decision. A skill whose description does not match
what the user says never runs.

**Rules:**
- Say **what it does**, then **when to use it**.
- Use the phrases a user will actually say ("file bugs", "test this page").
- Put **the most important use first**: `description` and `when_to_use` together are cut off
  after **1,536 characters**, and Claude never sees what comes after the cut.
- Write it as two plain sentences, **not a bullet list inside the YAML**.

This plugin's own host builds add a stricter limit of their own (see
[Host Branches](./host-branches.md)): a description longer than 1024 characters fails the
Copilot, Devin and Codex builds.

**Good example:**
```yaml
description: Files defects from a test run as Azure DevOps Bugs. Use when the user asks to file, log, or report bugs after a test run.
```

**Bad example:** an 800-character paragraph about the internals (gates, ledgers, validation
passes), with the sentence about when to use it at the very end.

> **Note:** any change to a `description` changes when the skill runs. In this project, an
> **eval** is a scripted case under `evals/` that sends a prompt to the installed plugin and
> grades what happens. After any change to a skill's description, rerun that skill's evals
> whose names start with `trigger-*` (the ones that check the skill fires on the right request).

**`when_to_use`:** an optional field for trigger phrases, appended to the description. Use it
when the description is long. It works in **Claude Code only**: a skill uploaded to claude.ai or
used through the Skills API fails with an error when it has this field.

---

## 3. File layout

The **frontmatter** is the YAML block between the two `---` lines at the top of the file; it
holds the skill's settings. Always order a `SKILL.md` like this:

```markdown
---
name: my-skill
description: <what it does>. Use when <when, in the user's words>.
---

# My Skill

## Role
Two lines: who you are, what you do, and what you do not do.

## Hard rules
- One rule per line.
- Phrased as always / never / only.

## Glossary
| Term | Meaning |
|---|---|
| **BLOCKED** | ... |

## Steps
1. **STEP ONE**: what it does.
2. **STEP TWO**: what it does.

## Output format
The exact shape of the result.

## Resources
- `references/details.md`: what it holds. Read it before <when>.
```

**Why this order?**
- **Hard rules first.** **Compaction** is what Claude Code does when a conversation grows long:
  it replaces the conversation with a summary. After compaction, only **the first 5,000
  tokens** of each skill are put back. A rule at the end of a long file can be lost, and Claude
  then works without it.
- **A Glossary:** this project's convention is to add one once the skill has 3 or more
  internal terms (status names, phase names, placeholders). Without it, the reader has to know the skill's language before
  reading it.
- **Resources** must say, for every file, what it holds and when to read it. A file in
  `references/` that `SKILL.md` does not mention does not exist as far as Claude is concerned:
  it is never read.

---

## 4. Keep it small

The **context** is everything Claude holds in mind for the current conversation. A loaded
skill stays in the context on **every turn**, so each line has a fixed cost for as long as the
skill is loaded.

The hard numbers from Claude Code are the 1,536-character limit on `description` +
`when_to_use` (section 2) and the budgets re-attached after compaction: 5,000 tokens per skill
and 25,000 tokens for all skills together. The other numbers are recommendations.

| Measure | Number | Kind |
|---|---|---|
| **Target** | under ~3,000 tokens | this project's convention |
| Re-attached per skill after compaction | 5,000 tokens (anything after it can be cut) | Claude Code limit |
| All skills together after compaction | 25,000 tokens | Claude Code limit |
| Length | under 500 lines | Claude Code recommendation |

**How to shrink it:**
- Move long detail (schemas, many examples, step-by-step mechanics) to `references/`, and
  leave one line in `SKILL.md` that points to it.
- **Say what to do, not why.** If the reason matters, one sentence is enough.
- Remove repetition. A rule already stated in Hard rules is not repeated in detail inside a
  step; the step points to it.

---

## 5. Writing rules

These are this project's conventions, not Claude Code limits; the 50-word and two-dash numbers
are ours.

| Rule | Not this | This |
|---|---|---|
| **One idea per sentence** | "Resolve once — explicit env, then default — never fall back silently (list files instead) — and record it." | Three bullets, one idea each. |
| **Sentences under 50 words** | An 80-word sentence with a condition, an exception and an example. | Split it into sentences. |
| **At most two dashes (—) per sentence** | Three or more dashes in one sentence. | Bullets or a table. |
| **Rules of equal weight get the same format** | One important rule in a bullet, another just as important buried in the text of a numbered step. | Both in Hard rules. |
| **Standing instructions** | "In step 3, remember not to close other sessions." | "Never close a session this run did not create." |
| **Cases in a table** | A paragraph of "if A then X; if B then Y; if both then Z". | A table: case → result. |

**Why do standing instructions matter?** Claude reads the skill once and does not go back to
it. A rule has to be written so it holds for the whole task, not as a step that runs once and
is done.

---

## 6. Anything fixed and mechanical becomes a script

- A step with exactly one right result (a calculation, a check, an API call, creating folders)
  is written as a **script**. A script is **run, not loaded** into the context, so it costs no
  tokens, and it gives the same result every time.
- Use **`${CLAUDE_SKILL_DIR}/scripts/...`** for paths inside the skill. It is shorter than
  `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`. To point at another skill, this project uses
  `${CLAUDE_PLUGIN_ROOT}/skills/<other>/...` (our convention; we have not found it documented).
  (Every skill on `main` today uses the `${CLAUDE_PLUGIN_ROOT}` form, which is
  the one the [host branch](./host-branches.md) converters rewrite.)
- Let only your own scripts run without a permission prompt:
  ```yaml
  allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)
  ```
  Keep the permission narrow, on your scripts only, never all of `Bash`.
- Follow the project's script rules: every script prints **one JSON line** and has a `.test.js`
  next to it (see [Testing](./testing.md)).

---

## 7. Choose who can run the skill

| Kind of skill | Setting | The user can run it? | Claude runs it on its own? |
|---|---|---|---|
| Most skills | the default | Yes | Yes |
| Has an effect you cannot undo (deploy, commit, publish) | `disable-model-invocation: true` | Yes | No |
| Background knowledge, not a command a user types | `user-invocable: false` | No | Yes |

**`context: fork`** runs the skill in a separate **subagent**: another Claude instance that
starts with an empty context and does not see the conversation. This is a forked *skill*; it is
not the same as a fork of the conversation (see
[Writing an Orchestrator Skill](./writing-an-orchestrator-skill.md#1-facts-about-subagents-you-need-to-know)). Use it only when the skill is
**a clear, self-contained task**. If the skill is guidance only, the subagent comes back with
nothing useful.

---

## 8. Common frontmatter mistakes

- **Put `---` on the first line of the file.** In our experience, with a blank line before it
  the whole file is read as body text and none of the settings apply (we have not found this
  documented).
- **Keep the YAML valid.** Claude Code documents that an agent with invalid frontmatter loads
  with no fields; we have not found this documented for skills, so assume the same: no
  `description` and no settings, so Claude has nothing to decide from.
- **A misspelled field name is ignored without any warning.** For example `allowed_tools` with
  an underscore instead of `allowed-tools`: the setting has no effect and nothing tells you.
  Field names use hyphens, except `when_to_use`.
- **Do not name the folder `synced`.** That name is reserved for skills that come from
  claude.ai.

---

## 9. Test it

1. **Check it against every limit on this page:** the frontmatter (sections 3 and 8), the
   description length (section 2), the size and compaction budget (section 4), that every file
   path the skill names exists (section 3, Resources), and the sentence rules (section 5). Note
   the line of each finding so it can be fixed in place.
2. **Try it in a fresh session.** The context left over from writing the skill hides gaps:
   Claude already knows what you forgot to write down.
3. **Test two things, each on its own:**
   - **Does it run at the right time?** In this project: the evals whose names start with
     `evals/trigger-*`.
   - **Is its output right?** In this project: the evals whose names start with
     `evals/discipline-*`.

   Both run with `claude plugin eval` (see `evals/README.md`).

---

## Quick checklist before merge

- [ ] The `description` says what it does and when, with the most important use first.
- [ ] Hard rules at the top of the file, one rule per line.
- [ ] Internal terms are defined.
- [ ] The file is under ~3,000 tokens (this project's target), with the detail in `references/`.
- [ ] Every file in `references/` is mentioned, with when to read it.
- [ ] The fixed mechanics are scripts, with tests.
- [ ] Every check in section 9, step 1, passes.
- [ ] The skill's evals were run in a fresh session.
