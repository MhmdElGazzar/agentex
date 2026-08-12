# Define Flow

Writing a long test spec by hand means writing it blind: you describe fifteen steps from
memory, run the whole thing, and only then discover step 7 was misunderstood. `/define-flow`
removes that guesswork — the flow is **defined by doing it**. Claude leads a live session:
it proposes each step, executes it in a real browser the moment you agree, and you confirm
the actual result before the next step is even discussed. When you're done, the spec already
passed once, step by step, while you watched.

You never write spec text yourself — you only answer questions, confirm outcomes, and pick
from choices Claude presents.

## Walkthrough: defining a new flow

You type something like:

> /define-flow https://your-app.example on uat

Here's what happens:

1. **Setup** — Claude resolves the target and environment from your project's configuration
   (same rules as a test run), logs in if the flow needs it (see
   [Optimize Login](./optimize-login.md)), and asks you for the flow's goal in one sentence —
   that becomes the spec's title.
2. **One step at a time** — Claude looks at the live page and either proposes the next step
   ("I can see a Submit order button — is submitting next?") or asks what happens next,
   offering the visible options as choices. The moment you agree, the step runs in the real
   browser and Claude shows you the actual outcome (screenshot + what it observed).
3. **You assert** — confirm the result, or correct the step and Claude re-runs it. Correction
   is **forward-only**: you can fix the step that just ran, but earlier confirmed steps are
   locked (you can always edit the saved spec file afterwards). After each confirmed step
   Claude shows the numbered list so far, so an 18-step flow never loses the thread.
4. **Values flow forward** — when a step surfaces something (an order number the app
   generated, an option on the page), Claude offers it: "use this later?" Selected values are
   written into the spec **symbolically** ("the order number produced in step 3"), so a fresh
   run resolves them live instead of replaying a stale literal.
5. **Save** — when you say the flow is complete, Claude assembles a normal spec file
   (Target, acceptance criteria, numbered scenarios marked as a stateful chain, notes) and
   proposes a name under your suite folder (default `test/suite1/<slug>.md`).
6. **Prove it twice (optional)** — Claude offers to immediately re-run the fresh spec via
   `/execute-test`. Every step already passed during definition; the fresh run proves the
   spec stands on its own.

Steps that reach beyond the browser (`api:` / `db:` / `kb:`) work here too — but only
entries already defined in your `integration/` catalog, exactly as in test runs.

A definition session is **one sitting** (no pause/resume), and because you direct every
step, Claude executes what you approve without second-guessing — including add/edit/delete
steps. Run definition sessions against a test environment you're responsible for.

## Walkthrough: clarifying an existing spec

Point the command at a spec file instead:

> /define-flow test/suite1/checkout.md

Claude walks the spec step by step, executing each one live. Any step it finds unclear — an
ambiguous target, a missing expected result — becomes a question to you; your confirmed
answer replaces the unclear wording. The result is saved as a **new** spec file; your
original is left untouched except for one note added at its top — "Defined flow available at
`<path>`" — so the team can see which specs have a proven, defined counterpart.

## Quick reference

- Start fresh: `/define-flow [url] [on <env>]` — target/environment resolve from
  `environments/<env>.json` / `config/project.json` / `.env`, like any run.
- Walk an existing spec: `/define-flow <path-to-spec.md>`.
- Forward-only corrections; one sitting; the output is a normal spec — runnable unmodified
  with `/execute-test`.
- Definition sessions don't write to `executions/` — only the optional validation run at the
  end produces normal run evidence.
- Skill: `skills/define-flow/SKILL.md`
- Spec conventions the output follows: [`test/README.md`](../test/README.md)
