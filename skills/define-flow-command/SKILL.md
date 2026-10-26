---
name: define-flow-command
description: "Define a test flow by doing it: an agent-led session that executes each step live as you define it, then saves a runnable spec. Usage: /agentex:define-flow-command [url] [on <env>] [existing-spec-path]. Pass an existing spec path to walk it through step by step and clarify it."
disable-model-invocation: true
---

> **AgenTeX on Devin.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), start it as a subagent; ask the user anything you need before dispatching, because subagents cannot ask.

Use the **define-flow** skill to run a guided definition session.

Arguments: (the argument text the user typed after the command's name)

**Mode (from the arguments):**
- If the arguments contain a path to an existing spec file (e.g. `test/suite1/checkout.md`),
  run the skill's **walkthrough mode** over that file.
- Otherwise, define a **new flow** from scratch.

**Target (if given in the arguments):**
- A URL in the arguments is the target under definition. If none is given, the target comes
  from the environment resolution below (or, in walkthrough mode, from the spec's Target
  line).

**Environment (if named in the arguments):**
- "on uat" / "env uat" selects `environments/uat.json` as the active environment; otherwise
  the project's `defaultEnvironment` applies. A legacy project (no `config/project.json`,
  no `environments/`) uses the URL the user gave; with none, stop before the session and say
  "give the URL, or run `/agentex:update-agentex`". Never read `.env`.
  An environment with no file is an error — list `environments/` and stop.

Then follow the skill: resolve target & environment per test-execution's environment rules,
read the skill's referenced `playwright-cli.md` (browser-driver) before the first browser action, and run the
session (SETUP → STEP LOOP → ASSEMBLE → VALIDATE). The session is one sitting, forward-only,
and driven by you, the main agent — never by a subagent.
