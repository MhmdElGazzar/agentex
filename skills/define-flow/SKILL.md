---
name: define-flow
description: >
  Define a test flow by doing it: an agent-led session that builds a spec step by step in a
  live browser — the agent proposes each step, executes it immediately, and the user asserts
  the real outcome before the next step is defined. Use when a user wants to create a spec
  for a long or complex flow without writing it blind, or wants to walk through an existing
  spec live to clarify ambiguous steps. Produces a normal natural-language spec file that
  runs unmodified via /execute-test.
---

# Define Flow — the flow is defined by doing it, not by writing it

## Role

You lead a **define-by-doing session**. The user has a flow in their head (or an unclear
spec file); you turn it into a proven, runnable spec by executing every step live as it is
defined. You lead: you ask what happens next, propose steps from what you see on the page,
and offer choices. The user only **answers, confirms, and selects** — at no point do you ask
the user to write spec text.

This session is authoring, not a test run. Note the direction reversal from a test run: there
the user approves your plan; here you elicit the flow from the user, one step at a time.

**You, the main agent, drive the whole session yourself.** Never dispatch a subagent for any
part of the loop — subagents cannot interact with the user mid-run, and this session IS
mid-run interaction.

## Session rules (apply throughout)

- **Forward-only.** The user may correct only the step just executed. There is no jumping
  back: once a step is confirmed, it is immutable. If the user asks to redo an earlier step,
  decline plainly — explain that correction is forward-only in a definition session, and that
  the earlier step can be changed by editing the saved spec afterwards.
- **One sitting.** No pause/resume. If the user must stop mid-session, the confirmed steps
  already exist in the draft spec file (see STEP LOOP): offer to save them as a partial spec
  clearly marked incomplete — this is not pause/resume (the session is not resumable); it
  only prevents losing confirmed work.
- **The user is the responsible party.** This session is user-directed: the user's approval
  of a step IS the authorization to execute it. Never warn about, question, or double-check
  add/edit/delete steps the user directed — responsibility for the environment's state sits
  with the user. Your **own initiative** stays inside the normal autonomy boundary: when YOU
  propose data, propose disposable values (like `qa.tester@example.com`), never real personal
  data; and secrets are never printed under any circumstances.
- **Evidence is transient.** Per-step screenshots exist only to show the user the actual
  outcome; they live in the transient `.playwright-cli/` scratch and are cleaned at the end.
  A definition session never writes `executions/` — only the optional validation run at the
  end (a normal `/execute-test` run) produces normal evidence in the normal place.
- Never modify application source code. Config files may be read to resolve the target;
  never print, log, or pass secret values.

## 1. SETUP

1. **Resolve target & environment** exactly per the "Target & environment resolution" rules
   in `${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/SKILL.md` — read that section and follow
   it as written (explicit environment → `defaultEnvironment` in `config/project.json` →
   legacy `.env`; undefined environment names are an error, undefined user handles are
   BLOCKED). All target, users, and test data come from the consumer project's configuration;
   nothing is hardcoded.
2. **Read `${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/references/playwright-cli.md`**
   before the first browser action. A definition session is single-session: use the default
   playwright-cli session (no `-s=` fan-out).
3. **If the flow needs authentication**, apply the **optimize-login** skill (read its
   SKILL.md): pay the login once, verify by landmark, and continue the session logged in.
4. **Ask the user for the flow's goal in one sentence.** It becomes the spec's title and
   drives your step proposals throughout the session.

## 2. STEP LOOP

Repeat until the user says the flow is complete:

1. **Propose / ask.** Look at the live page. Either propose the next step from what you can
   see ("I can see a Submit order button — is submitting next?") or ask what happens next.
   Offer choices as selectable options wherever possible (numbered lists of the actions or
   values visible on the page). The user answers, picks, or supplies a value — never ask
   them to phrase a spec line.
2. **Execute immediately.** Run the agreed step in the live browser the moment it is agreed.
   Present the actual outcome: a screenshot plus the observed result in words. No mutation
   warnings and no second-guessing — the user's approval of the step is the authorization,
   including for add/edit/delete steps.
3. **Assert.** The user confirms the expected result or corrects the step.
   - On **confirmation**, record the step as a natural-language spec line with its expected
     result, and **append it immediately to the draft spec file** in the session's transient
     scratch (default `.playwright-cli/define-flow-draft.md`) — incremental assemble: a
     crash or disconnect at step 14 loses nothing already confirmed. Keep a visible running
     list — after each confirmed step, show the numbered steps so far, so a long flow (15+
     steps) never loses the thread.
   - On **correction**, re-phrase and re-run the just-executed step until the user confirms.
     Correction is forward-only: earlier steps stay as confirmed.
4. **Capture values.** When a step surfaces data — an identifier the app generated, an
   option list, a value you read off the page — offer it: "use this later?" A selected value
   is recorded **symbolically** in the spec ("the order number produced in step 3"), with the
   concrete session value kept only as an inline example (e.g. "the order number produced in
   step 3 (this session: #48291)"). Never record the literal as the step's target — a fresh
   run must resolve the value live, not replay a stale one.
5. **Capture user-supplied data the same way.** Input data the user provides during
   definition (a registration email, a record name) that must be unique or fresh for the
   flow to succeed again is recorded **symbolically** as fresh disposable data ("register
   with a fresh disposable email"), with the session's concrete value kept only as an inline
   example — mirroring app-surfaced values, and surfaced under the spec's Notes as
   disposable-data guidance per `test/README.md`. This is what keeps VALIDATE (and any fresh
   run) viable for mutating/create flows.
6. **Integration steps.** If the user wants a beyond-the-browser check (`api:` / `db:` /
   `kb:`), only entries defined in the project's `integration/*_api.json` / `*_db.json`
   catalog may run — execute them live via the **api-integration** / **db-integration** /
   **ask-kb** skills' runner scripts (read the relevant SKILL.md before the first such step),
   passing the resolved environment via `--env <name>`. An undefined name is **BLOCKED**
   (report the missing entry), never improvised — exactly as in test runs. `kb:` answers are
   advisory context only.

## 3. ASSEMBLE

When the user says the flow is complete:

1. **Promote the running draft to the final spec**, following the conventions in
   `${CLAUDE_PLUGIN_ROOT}/test/README.md` and
   the `${CLAUDE_PLUGIN_ROOT}/test/suite1/` samples:
   - **Target** — the resolved target (URL / environment reference).
   - **Acceptance criteria** — what "correct" means, distilled from the asserted outcomes
     (including "no console errors / failed network calls").
   - **Scenarios** — the confirmed steps, numbered, in order, each with its expected result;
     **marked as a stateful chain** ("stateful — run in order, in one session").
   - **Notes** — stateful order, disposable data used, and each symbolically captured value
     (app-surfaced, and user-supplied fresh disposable data) with its inline example.
2. Propose a file name under the user's suite folder — default `test/suite1/<slug>.md`, slug
   derived from the flow's goal. Save only on the user's confirmation.
3. Clean the transient `.playwright-cli/` scratch — draft included — once the final spec is
   saved.

## 4. VALIDATE (offered, not forced)

Offer to immediately re-run the fresh spec via `/execute-test` — the "proven twice" moment:
every step already passed once during definition; a fresh run proves the spec resolves its
captured values live and passes unmodified. This validation run is a normal test run and
writes its evidence to `executions/` in the normal way. If the user declines, the session
ends with the saved spec.

## Walkthrough mode (existing specs)

When the input is an **existing spec file path**, run the same session over the file's steps
instead of eliciting new ones:

1. SETUP as above (the spec's Target feeds resolution).
2. STEP LOOP over the spec's steps, in order: execute each step live and present the actual
   outcome. Steps you find **unclear** — ambiguous target, unstated expected result,
   unresolvable value — become questions to the user (answer/confirm/select shaped, as
   always); the confirmed clarification **replaces the unclear text** in the recorded step.
   Clear steps still get executed and asserted before moving on. Forward-only and one-sitting
   apply unchanged.
3. ASSEMBLE the result as a **new spec file** (same conventions and naming proposal as
   above). **Do not rewrite the original spec.** Add exactly one note at the top of the
   original file — "Defined flow available at `<path to the new file>`" — so the team sees
   at a glance that this spec has a proven, defined counterpart. The original's body is
   otherwise untouched.
4. VALIDATE (offered) runs the new file.
