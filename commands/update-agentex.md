---
description: "Checks for a newer plugin version first (one confirmation before any pull; after a pull, stop and reload), then migrates the current project to the installed AgenTeX version's conventions — folder structure, config file schemas, the secrets-only .env split, catalog format, CLAUDE.md and .gitignore entries. Refactor/merge, never re-scaffold: user values are carried, never reset. Requires a clean git tree; git is the rollback."
---

Bring this project's AgenTeX setup up to the conventions of the installed plugin
version — after first checking whether the plugin itself is stale. Both halves are
fully deterministic — bundled scripts do every check and every file change; you run
them, branch on their one-line JSON, relay their reports, and explain what they
flagged.

0. **Plugin self-update check — before any migration.** Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/self_update.js" check
   ```

   It derives the plugin and marketplace identity from its own install path,
   refreshes the marketplace's local cache, and prints ONE JSON line. Branch on its
   `status` (never derive names or compose `claude plugin` CLI calls yourself):

   - **`up-to-date`** → say so in one line (include the `installed` version; if the
     JSON carries `note: "installed-ahead"`, say the installed version is ahead of
     the marketplace — never offer a downgrade) and proceed to step 1. No
     confirmation detour.
   - **`update-available`** → ask exactly **one** confirmation before any pull.
     That one message must show: the installed and latest version numbers from the
     JSON, the `<plugin>@<marketplace>` identity, and what a yes does — install the
     new version side-by-side while this session keeps the old one loaded until a
     reload/restart. One yes/no question; no second "are you sure", no extra
     sub-questions. Never pull without the user's yes, and never merely mention the
     newer version without offering the pull.
     - **Yes** → run:

       ```
       node "${CLAUDE_PLUGIN_ROOT}/scripts/self_update.js" pull
       ```

       - On `pulled` → **STOP the command here.** Report the pulled `from` → `to`
         versions, instruct the user to run `/reload-plugins --force` (or restart
         the session) and then re-run `/update-agentex`, and state explicitly that
         the project migration did NOT run in this invocation. Do not invoke the
         migration engine — nothing comes after this message.
       - On `pull-failed` → report it loudly: relay the failing command and its
         captured error `detail` from the JSON, and that the plugin remains at the
         `installed` version. Then proceed to step 1 with a loud note that the
         migration is running on the OLD plugin version — no additional gate; the
         update part is over.
     - **No** → proceed to step 1 on the installed version, exactly as before (the
       stamp-newer abort in step 2 still applies if relevant).
   - **`check-unavailable` (exit 2) — or any unexpected error (exit 1)** → report
     it loudly, never silently: name the reason from the JSON
     (`not-marketplace-install` — e.g. a local dev clone, `cache-refresh-failed` —
     covers offline, `cache-missing`, `marketplace-entry-missing`), state
     explicitly that the freshness check did NOT run, and that the migration
     proceeds on installed version `installed`. Then proceed to step 1 — a failed
     check never blocks the migration.

1. **Run the migration engine** from the project root:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate.js"
   ```

   It detects the project's setup state from its files (legacy projects carry no
   version stamp), applies every needed migration, and prints one
   `[migrated]`/`[ok]`/`[flag]`/`[manual]` line per action plus a summary. The
   version stamp (`.agentex/version.json`) is written only when no `[manual]` items
   remain — otherwise it is withheld so a later run re-enters the pipeline. Relay that report to the user faithfully —
   **never print secret values** (the script only ever prints key names; the same
   rule binds your relay).

2. **If it aborted (exit 2), explain the reason and stop.** Do NOT attempt the
   migration by hand — every abort has a user-side fix:
   - *dirty working tree* → ask the user to commit (or remove the colliding
     untracked files) first; git is the rollback mechanism, so a clean starting
     point is non-negotiable;
   - *not a git repository* → `git init` + an initial commit, then re-run;
   - *stamp newer than the installed plugin* → the project was set up by a newer
     AgenTeX; the user should update the plugin instead;
   - `already up to date` / `no migrations needed` are successes, not aborts —
     just tell the user.

3. **Explain every `[manual]` and `[flag]` line.**
   - `[manual]` (e.g. both `integrations/` and `integration/` exist): describe the
     exact hand-move the message asks for.
   - `[manual]` phantom sample environment (`phantom-sample-env`): the named
     `environments/<name>.json` is a pristine leftover of the old scaffold —
     structurally identical to the shipped sample, zero user values, and not the
     project's default environment. Relay that finding and **ask the user
     explicitly** whether to remove it. Only after the user confirms, re-run the
     engine with the consent flag — the engine deletes it, never you:

     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate.js" --remove-phantom-sample
     ```

     Never delete the file by hand, and never pass the flag without the user's
     explicit confirmation. If the user wants to keep the file, tell them the
     alternative the message names: rename it or change any value in it
     (claiming it), then re-run this command to finish and stamp.
   - `[flag]` on a catalog `connection` block: the DB connection now lives in the
     environment file's `db` block, which takes precedence; the legacy block still
     works and can be deleted whenever convenient.
   - `[flag] spec drift`: the user's spec files were left byte-identical on
     purpose. Offer to help modernize the flagged specs **only if the user
     explicitly asks** — never edit them as part of this command's run.

4. **Suggest the follow-up:** verify with a normal `/execute-test` run, then commit
   the whole migration as one commit (the report lists every file touched; `.env`
   is gitignored but was rewritten loss-proof — every removed key's value now lives
   in a committed JSON file).

5. If a run was interrupted, recovery is: **commit the partial state** (or roll it
   back with `git restore`), then re-run this command — the engine detects state
   from files, not from a journal, so the re-run completes the remaining
   migrations. The clean-tree guard stays absolute: it rejects the interrupted
   run's own uncommitted changes too, by design.
