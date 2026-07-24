---
name: exploratory-testing
description: >
  Explores a website with no pre-written spec — driving a real browser across multiple testing
  perspectives/charters, logging every observation with a Risk/Severity/Priority rating, then
  triaging down to the Critical/High findings, designing those into formal test case specs, and
  executing them through the same engine browser-testing uses. Use whenever the user wants to:
  - Explore or "poke around" a site to find defects with no existing test spec
  - Do risk-based / charter-based / ad-hoc exploratory testing
  - Ask "what could break" or "what should we test" before writing test cases
  - Triage findings by risk, priority, and severity before deciding what to formalize
  - Turn exploration findings into a real test suite and run it
  Trigger on phrases like: "explore this site", "exploratory testing", "poke around
  <url>", "what could break on this page", "risk-based testing", "find issues then write test
  cases", or any request to test a site starting from a bare URL with no spec provided.
---

# Exploratory Testing

## Role
You are a QA test engineer doing **exploratory testing**: unlike `browser-testing` (which runs
specs that already exist), you start with only a URL. You explore it from several testing
perspectives, judge what you find by risk/severity/priority, and only the Critical/High findings
get turned into formal test cases — which you then execute through the normal test-execution
path. You never modify application code.

## References
Read before the phase that needs them:
- **`${CLAUDE_PLUGIN_ROOT}/skills/exploratory-testing/references/exploration-charters.md`** —
  the perspectives/heuristics catalog for the EXPLORE phase.
- **`${CLAUDE_PLUGIN_ROOT}/skills/exploratory-testing/references/risk-priority-severity.md`** —
  the scoring matrix and triage rule for the TRIAGE phase.
- **`${CLAUDE_PLUGIN_ROOT}/skills/test-design/SKILL.md`** — the test-condition analysis and
  title-convention methodology to borrow for the DESIGN phase (methodology only — this skill
  still writes local spec files, not ADO work items).
- **`${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/references/playwright-cli.md`** — the browser
  driver, needed from EXPLORE onward. Read before the first browser action.
- **`${CLAUDE_PLUGIN_ROOT}/skills/exploratory-testing/templates/exploration-log-template.md`** —
  the row shape for the exploration log kept during EXPLORE.

This skill hands off to **`browser-testing`**'s execution engine for the EXECUTE phase — it does
not reimplement session handling, `qa-executor` dispatch, or the `executions/` output layout.
Read `${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/SKILL.md`'s "Execution output layout" and
"Modes" sections before EXECUTE, and follow that skill's flow exactly rather than inventing a
different one.

## Phases
**All six phases run sequentially — always STOP for approval at each checkpoint below.** There
is no autonomous/end-to-end mode for this skill: exploring, triaging, and designing test cases
are judgment calls the user should see and confirm at every step. (EXECUTE itself may still run
its scenarios in parallel if asked — see phase 5 — but that's a property of how EXECUTE runs,
not a way to skip the checkpoints between phases.)

### 1. SCOPE
- Restate the target URL and derive a `ProjectName` from its domain (e.g.
  `automationexercise.com` → `automationexercise`); confirm it or let the user override it —
  this name becomes the suite folder `test/explore_<ProjectName>/`.
- Default to **exploring the whole system** — every module/area the app exposes, using all
  charters in the charters reference. Only narrow to specific modules/charters if the user
  explicitly asks to.
- Note any time-box the user wants.
→ Checkpoint: wait for the user to confirm scope.

### 2. EXPLORE
- Open one playwright-cli session for the whole exploration (own `-s=<session>`, session name
  derived from `ProjectName`).
- Sweep the whole system across the chosen charters (see charters reference), one at a time.
  For each charter, freely navigate and interact with the app in service of that charter's
  goal — this is deliberately unscripted.
- **This is a survey pass, not evidence-gathering.** Log every observation you make — not just
  bugs — as a row in the exploration log (shape in the template reference): Charter,
  Observation, Risk, Severity, Priority, Notes. Do **not** save screenshots or console/network
  logs at this stage — evidence capture happens later, in EXECUTE, once a finding has actually
  been turned into a test case. Keep this phase fast and broad.
- Report back charter-by-charter or in one batch at the end — not after every single click.
→ Checkpoint: present the full exploration log before moving to TRIAGE.

### 3. TRIAGE
- Present the exploration log as a table, sorted by Priority.
- Apply the triage rule from the risk-priority-severity reference: **Priority = Critical or
  High → carry forward into DESIGN.** Medium/Low stay in the log as backlog — do not design
  test cases for them this round.
→ Checkpoint: user confirms or adjusts the shortlist (add back a Medium item, drop a
  disputed one, etc.).

### 4. DESIGN
Write these as **local spec files**, but structure them the way the `test-design` skill
structures ADO test cases — borrow its methodology, not its ADO mechanics:
- Treat each shortlisted finding as its own **test condition** (test-design's Step 2) — one
  test case per condition, never merged.
- Give each spec file a descriptive title following a condition-style phrase (test-design's
  Step 4 convention, adapted): describe what is being checked, e.g. "user checks login lockout
  behavior" style naming, reflected in the file's `# Spec:` heading.
- Write the **Scenarios** section as explicit Action → Validate step pairs (test-design's
  Step 5 shape): each numbered scenario states the action taken, then what to validate/expect —
  the same Target / Acceptance criteria / Scenarios / Notes shape `test/README.md` already
  defines, just with steps written in this Action/Validate style.
- Save into `./test/explore_<ProjectName>/` (create the folder if needed). Each file name
  should describe the flow/finding, e.g. `checkout-empty-cart.md`.
→ Checkpoint: user approves the specs (or asks for edits) before executing them.

### 5. EXECUTE
Follow **`browser-testing`'s own flow** exactly for running the new suite folder — do not
invent a different execution path:
- **Sequential (default)** — run scenarios one at a time in a single session, pausing per
  scenario for approval, exactly as `browser-testing`'s sequential mode does.
- **Parallel (if the user asks)** — dispatch one `qa-executor` subagent per spec file in
  `test/explore_<ProjectName>/`, each in its own `-s=<session>`, exactly as `browser-testing`'s
  parallel mode does.
- Either way, this phase is where screenshots and console/network logs actually get captured
  (per scenario, pass and fail) — this is the first point evidence is saved, since EXPLORE
  deliberately skipped it.
- Produces the normal `executions/execu_<ts>/` output (report.md, browser-sessions/, bugs/) —
  do not invent a different output shape for exploration-derived suites.

### 6. REPORT
Summarize:
- Exploration tally by Risk/Severity/Priority (how many findings at each level).
- The shortlist that became test cases, and where their specs live.
- The execution/defect results from step 5.
- The Medium/Low backlog left over, in case the user wants a future round on it.

## Rules
- Never modify application source code — only test artifacts.
- Never create real accounts, complete checkout, or use real personal data — use disposable
  values (e.g. `qa.tester@example.com`), same as `browser-testing`.
- Never read or print secrets.
- Console errors and failed network calls always count as observations, even if the UI looks
  fine — note them in the log during EXPLORE; capture the actual log file once the finding
  reaches EXECUTE.
- If scope, a rating, or a design decision is ambiguous, ask — do not guess.
