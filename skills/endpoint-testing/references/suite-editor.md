# Suite editor (`/test-endpoints --edit`)

A local page over every suite under `integration/api_test_suites/` (searched recursively,
hand-written suites included). The tester reviews, fixes and re-runs cases there without
editing JSON by hand. The page needs no agent: Save and Run are done by the studio server
itself.

## Launch

From the project root, in the background:

    node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/studio/server.js" --mode editor [--suite <path>] [--lang=ar|en]

- It prints `{"ok":true,"url":…}`. Give the tester the URL. Arabic is the default; `--lang=en`
  opens it in English, and the page has a language toggle.
- `"error":"port-in-use"`: relay the message (it names the next port). `"already-running"`:
  give the tester that URL instead.
- The server binds 127.0.0.1 only, refuses every API call without the page's per-run token,
  answers only `http://127.0.0.1:<port>` or `http://localhost:<port>` (any other host name
  gets 403, so give the tester the printed URL), loads nothing from the internet, and stops by itself after 120 minutes without use (or when
  the tester presses "Close").
- "Import another Swagger" opens the wizard on the same server. No agent is attached there,
  so its step 3 tells the tester to ask in chat (`/import-swagger --wizard` is the path that
  keeps you attached).

## What the page does

- **Rail:** each suite with its endpoint and case counts, how many cases need review, and how
  many are failing (from the newest `suite-result.json`).
- **Top bar:** environment (starts on `defaultEnvironment`), counts, Save with an
  unsaved-changes marker, Run all.
- **Cases tab:** cases grouped by endpoint. Each value carries a source badge (UI · Project ·
  Auto · Placeholder · Manual); a value with no recorded source shows as Manual. Filters: All ·
  Needs review (a case that is not skipped and still sends a placeholder value) · Failing ·
  Skipped. A skipped case counts under Skipped only, so the rail, the filters and the wizard's
  step 4 give the same Needs review number for the same suite.
- **Drawer:** rename; suite token or no token; per value: pick from the collected data, type
  one (Manual), or leave it out (never a path param); status, required fields, one message
  check (equals / contains; other `equals` entries are kept and shown as "+N other checks");
  skip; delete; Run this case; Apply.
- **Collected data tab:** the values the wizard collected, with owner, where each came from
  and how many cases use it. The token appears by owner and time only. "Still missing" lists
  what no case could be filled with. There is no in-page button that asks the agent to
  collect: the tester asks in chat.

## Save (#11)

- Save sends the applied edits with the file's hash as loaded. If the file changed on disk
  since (a hand edit, a `git pull`, another tool), nothing is written. The page lists the
  unsaved edits so the tester can reload and apply them again.
- Otherwise only the keys the editor manages change. Unknown fields, `review` notes and the
  order of untouched cases are kept.
- A file that is not 2-space JSON gets a one-time notice before its first Save.
- Catalogs (`*_api.json`) are never written.
- **Never write over a suite to "resolve" a conflict** for the tester. Ask them to reload in
  the page and re-apply; show what changed on disk if they ask.

## Run

- Run all and Run this case spawn
  `run_suite.js --suite <file> [--case <n>] --env <top-bar env>`.
- The evidence goes in `executions/execu_<ts>/api-tests/`, as `/test-endpoints` leaves it:
  per-case logs and `suite-result.json`. A deterministic `result.md` reads "Severity: not
  rated (run from the editor — ask the agent in chat to triage)". If the tester asks, triage
  the failures from that folder's logs.
- With unsaved edits, the page offers "Save and run" or "Cancel": a run always matches the
  file on disk. A file that changed on disk must be reloaded first.
- Skipped cases are reported skipped. A case whose value is still a placeholder is BLOCKED
  ("needs a real value") and never sent. When nothing is runnable, the page says so and
  sends nothing.
- An unknown environment comes back BLOCKED from the runner and is shown as it is; it is
  never replaced by another.

## Requests in chat while the editor is open

- **"Collect this missing value" / "refresh the token":** follow
  `${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/references/suite-wizard.md` §5. Propose any
  suite edit in chat and write it only after a yes. If the page holds unsaved changes for that
  suite, ask the tester to Save or reload first.
- **"It's blocked, just send it anyway"** (a placeholder): ask for a real value. Never strip
  the `placeholder` marker without one, and never send the request yourself.
- **Token problems** (`token-missing`, `token-expired` in a result): capture again through
  the bridge (`--store`), or tell the tester to set the catalog's `tokenEnv` in `.env`.
