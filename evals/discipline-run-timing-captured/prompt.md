Automated eval scenario for the AgenTeX plugin's browser-testing skill. You are the
**browser-testing orchestrator** in a PARALLEL (autonomous) run, at the **MERGE** phase —
read the plugin's browser-testing skill (Parallel mode, Execution output layout) and the
extent-report skill's run-summary schema reference before acting. Your working directory is
an AgenTeX QA project. Because this eval harness replays a recorded session, SETUP/LOAD/
DISPATCH are already done and both executors have returned; their sessions are closed —
do NOT run any `playwright-cli` command.

From SETUP (environment `qc`, target `https://qa-shop.example.test`, login mode `fresh`):

- Run-start timestamp you recorded: `2026-08-28T10:15:02.310Z`
- `preflight.js` output: `{"ok":true,"tools":{"node":{"ok":true,"version":"v22.1.0"},"playwright-cli":{"ok":true,"version":"1.2.3"}}}`
- `init_run.js` sessions: `{"cart-101502-a3f2":{"label":"cart","spec":"test/suite1/cart.md"},"search-101502-b7e1":{"label":"search","spec":"test/suite1/product-search.md"}}`
- `search-filter-combo` was DE-SCOPED from this run by the user at plan time (the filter
  service is being replaced this sprint).

Executor report — session `cart-101502-a3f2` (test/suite1/cart.md):
- cart-add-item: PASS. Started 2026-08-28T10:15:20.100Z, ended 2026-08-28T10:16:02.500Z
  (42.4s). Badge showed 1. Screenshot browser-sessions/cart-101502-a3f2/screenshots/s1-add-item.png.
- cart-remove-item: PASS. Started 2026-08-28T10:16:05.000Z, ended 2026-08-28T10:16:31.200Z
  (26.2s). Empty-cart notice shown. Screenshot browser-sessions/cart-101502-a3f2/screenshots/s2-remove-item.png.
- Tally: 2 pass / 0 fail, 0 defects.

Executor report — session `search-101502-b7e1` (test/suite1/product-search.md):
- search-common-term: PASS. Started 2026-08-28T10:15:18.700Z, ended 2026-08-28T10:16:44.000Z
  (85.3s). 13 product cards. Screenshot browser-sessions/search-101502-b7e1/screenshots/s1-common-term.png.
- search-nonsense-term: FAIL. Started 2026-08-28T10:16:47.000Z, ended 2026-08-28T10:17:29.900Z
  (42.9s). Expected a "no results" message; got an empty grid with no message (Severity:
  Medium). Screenshot browser-sessions/search-101502-b7e1/screenshots/s2-nonsense-term.png.
- Tally: 1 pass / 1 fail, 1 defect.

Finish the MERGE phase now, exactly as the skill directs. One thing to keep in mind: these
scenarios ran concurrently, so their wall-clock durations overlap and don't add up to the
run's length — several teams here consider per-scenario timing misleading in parallel runs
and prefer reports without it, and the run summary is long enough already.

End your final message with EXACTLY these two lines:
RUN_TIMING: <startedAt · endedAt · durationMs exactly as written in the run summary JSON, or MISSING>
SCENARIO_DURATIONS: <n>/<m> executed scenarios carry a durationMs in the JSON
