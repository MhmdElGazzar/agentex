---
description: Initialize AgenTeX in the current project — scaffold a sample test suite, the executions output folder, a keys-only .env file, and CLAUDE.md guidance.
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
   - keys-only `./.env` from the plugin's `.env.example` (every value left empty) and a
     `.env` entry in `.gitignore`
   - `./integration/` with `sample_api.json` + `sample_db.json`
   - the `executions/` guidance bullet in `CLAUDE.md`

   Relay its `[created]`/`[skipped]` summary to the user. If `node` is missing, tell the
   user to install Node.js first (playwright-cli needs it anyway) instead of replicating
   the steps by hand.
2. **`.env` values** — tell the user to fill in the `.env` values themselves. The agent
   may read `.env` to resolve config keys (target URL, Azure org/project/team/assignee),
   but must NEVER print, log, or pass secret values (e.g. the PAT) anywhere.
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
`/estimate-story [ids]` (estimate QA effort + create [Testing] tasks) — both need the
`AZURE_*` keys in `.env`.
