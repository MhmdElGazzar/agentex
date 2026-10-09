---
description: Initialize AgenTeX in the current project — scaffold a sample test suite, config/project.json, environments/qc.json, the executions output folder, a keys-only .env file, and CLAUDE.md guidance.
---

Initialize **AgenTeX** in the current project so the user has a working starting point.
Do these steps, then report what was created:

1. **Run the scaffolding script** from the project root:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.js"
   ```

   It performs the whole file scaffold in one call, idempotently — existing files are
   never overwritten, `CLAUDE.md`/`.gitignore` are append-only:
   - sample specs → `./test/suite1/` + `./test/README.md` (skipped entirely if the user
     already has their own specs under `./test/`)
   - `./executions/` output folder (no timestamped run folder — that happens at run time)
   - `./config/project.json` — project settings (Azure org/project, default environment, login mode)
   - `./environments/qc.json` — sample environment (portal URL, defaults, test users, db/api targets); copied only when `./environments/` has no environment files yet, and the wizard reconciles it to the name the user actually chooses
   - keys-only secrets `./.env` (PAT, DB password, API token, KB key) from the plugin's `.env.example` (every value left empty) and, in `.gitignore`, entries for everything that holds a live credential — `.env`, `test/.auth/` (saved login sessions) and `.playwright-cli/` (browser scratch profile)
   - `./integration/` with `sample_api.json` + `sample_db.json`
   - the `executions/` guidance bullet in `CLAUDE.md`

   Relay its `[created]`/`[skipped]` summary to the user. If `node` is missing, tell the
   user to install Node.js first (playwright-cli needs it anyway) instead of replicating
   the steps by hand.

2. **Launch the Setup Wizard** to guide the user through filling in their project config:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/wizard/server.js" "${PROJECT_ROOT}"
   ```

   This starts a local web server and opens the browser automatically at
   `http://127.0.0.1:7373/setup`. The wizard is bilingual: it opens in Arabic and carries
   an EN/ع toggle in its header. If the user has been writing to you in English, add
   `--lang=en` to the command above and it opens in English instead.

   Tell the user — in the language they have been using with you — that the Setup Wizard
   is now open in their browser, that they should fill in their project data in order,
   and that the files are saved for them automatically.

   Wait silently for the wizard to complete. The server shuts itself down once the user
   saves and closes the wizard (the browser calls `/api/done`). You will see:
   `[setup-wizard] ✅ Done. Closing server.`
   in the terminal output when it finishes.

   **File / paste import:** the wizard extracts data from pasted text and uploaded
   text files (`.md`, `.txt`, `.env`, …) entirely on its own. Binary files (PDF/Word)
   are rejected with a clear message in the UI — no action needed from you.

   **If the wizard is already complete (user skipped it or ran `/init-test` again):**
   skip this step entirely.

3. **Integration catalog** — tell the user the files in `./integration/` define the ONLY
   API calls / DB queries test steps can execute (`api:`/`db:` steps in specs) and to
   replace the samples with their own services.
4. **Permissions reminder** — remind the user to copy the `permissions` block from
   `${CLAUDE_PLUGIN_ROOT}/settings.example.json` into their project's `.claude/settings.json`
   if they haven't already (plugin manifests can't ship permission rules).
5. **Playwright preflight** — mention they need `@playwright/cli` installed
   (`npm install -D @playwright/cli && npx playwright-cli install-browser chromium`); offer
   to run it. Do not install without confirmation.

Finish by telling the user to edit the sample specs in `./test/suite1/` to match their app,
then run `/execute-test <url or scope>`. Also mention the Azure DevOps commands if they use
ADO: `/design-test <story-ids>` (create linked test cases from a story's ACs) and
`/estimate-story [ids]` (estimate QA effort + create [Testing] tasks) — both read the
`azure` block in `config/project.json` (legacy `AZURE_*` keys in `.env` still work).
