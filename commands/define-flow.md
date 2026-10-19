---
description: "Define a test flow by doing it: an agent-led session that executes each step live as you define it, then saves a runnable spec. Usage: /define-flow [url] [on <env>] [existing-spec-path]. Pass an existing spec path to walk it through step by step and clarify it."
---

> **AgenTeX on GitHub Copilot.** `<agentex-root>` stands for this plugin's install folder: `..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), start it as a subagent.

Use the **define-flow** skill to run a guided definition session.

Arguments: $ARGUMENTS

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
  the project's `defaultEnvironment` applies (legacy projects: `.env`). An environment with
  no file is an error — list `environments/` and stop.

Then follow the skill: resolve target & environment per test-execution's environment rules,
read the skill's referenced `playwright-cli.md` (browser-driver) before the first browser action, and run the
session (SETUP → STEP LOOP → ASSEMBLE → VALIDATE). The session is one sitting, forward-only,
and driven by you, the main agent — never by a subagent.
