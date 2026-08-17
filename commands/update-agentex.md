---
description: "Migrate the current project to the installed AgenTeX version's conventions — folder structure, config file schemas, the secrets-only .env split, catalog format, CLAUDE.md and .gitignore entries. Refactor/merge, never re-scaffold: user values are carried, never reset. Requires a clean git tree; git is the rollback."
---

Bring this project's AgenTeX setup up to the conventions of the installed plugin
version. The migration itself is fully deterministic — a bundled script does every
file change; you run it, relay its report, and explain what it flagged.

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
