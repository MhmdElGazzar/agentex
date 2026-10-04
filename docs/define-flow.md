# Define Flow

Claude invokes this with `/define-flow`; Codex and GitHub Copilot Agent use
`agentex-define-flow` through a natural request. The interaction is the same:
observe the current page, propose an action, obtain approval, execute it in the **same**
browser session, verify what actually happened with the user, then continue. The agent
must not silently reload, reopen, or replace a session when continuity is lost.

Writing a long test spec by hand means writing it blind: you describe fifteen steps from
memory, run the whole thing, and only then discover step 7 was misunderstood. `/define-flow`
removes that guesswork — the flow is **defined by doing it**. Claude leads a live session:
it proposes each step, executes it in a real browser the moment you agree, and you confirm
the actual result before the next step is even discussed. When you're done, the spec already
was confirmed step by step while you watched; a separate validation run supplies the test verdict.

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
   locked (you can always edit the saved spec file afterwards). Every confirmed step is also
   appended immediately to a running draft, so a crash or disconnect at step 14 loses
   nothing already confirmed. After each confirmed step
   Claude shows the numbered list so far, so an 18-step flow never loses the thread.
4. **Values flow forward** — when a step surfaces something (an order number the app
   generated, an option on the page), Claude offers it: "use this later?" Selected values are
   written into the spec **symbolically** ("the order number produced in step 3"), so a fresh
   run resolves them live instead of replaying a stale literal. Inputs you supply that must
   be unique per run get the same treatment — a registration email or a new record's name is
   recorded as fresh disposable data ("register with a fresh disposable email"), with your
   session's value kept only as an inline example, so the saved spec still passes on re-runs
   of a create/register flow.
5. **Save** — when you say the flow is complete, Claude promotes the running draft to a
   normal spec file (Target, acceptance criteria, numbered scenarios marked as a stateful
   chain, notes) and proposes a name under your suite folder (default
   `test/suite1/<slug>.md`).
6. **Validate it (optional)** — Claude offers to run the fresh spec via `/execute-test`.
   Definition confirmed each observed step; the fresh run checks whether the saved spec
   stands on its own and produces a formal result and evidence.

Steps that reach beyond the browser (`api:` / `db:` / `kb:`) work here too — but only
entries already defined in your `integration/` catalog, exactly as in test runs.

A definition session is **one sitting** (no pause/resume) — though if you must stop early,
the steps you already confirmed can be saved as a partial spec, clearly marked incomplete.
And because you direct every
step, Claude executes what you approve without second-guessing — including add/edit/delete
steps. Run definition sessions against a test environment you're responsible for.

## Walkthrough: clarifying an existing spec

Saving the generated spec is a separate boundary: the agent shows its final content and
new destination, then waits for approval before saving. The existing spec remains untouched
unless the user separately approves a cross-reference. Definition is authoring, not a
substitute for a fresh validation run.

Point the command at a spec file instead:

> /define-flow test/suite1/checkout.md

Claude walks the spec step by step, executing each one live. Any step it finds unclear — an
ambiguous target, a missing expected result — becomes a question to you; your confirmed
answer replaces the unclear wording. The result is saved as a **new** spec file; your
original is left untouched. A cross-reference note is optional and added only after a
separate explicit request; no existing spec is silently edited.

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
