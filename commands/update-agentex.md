---
description: "Checks for a newer plugin version first (one confirmation before any pull; after a pull, stop and reload), then migrates the current project to the installed AgenTeX version's conventions — folder structure, config file schemas, the secrets-only .env split, catalog format, CLAUDE.md and .gitignore entries, plus a stray-file check. Refactor/merge, never re-scaffold: user values are carried, never reset. Requires a clean git tree; git is the rollback. `/update-agentex feedback` writes a sanitized export of this project's AgenTeX learnings; after a migration it proposes retiring learnings and forked skills the new version covers, behind one approval."
argument-hint: "[feedback]"
---

Arguments: $ARGUMENTS

**`feedback` first.** When the argument is `feedback`, follow the field-feedback export
procedure in `${CLAUDE_PLUGIN_ROOT}/skills/field-feedback/references/export.md` and stop there:
no step 0, no `migrate.js`, no steps 6-7. Its outcome (the export path and the manual send,
nothing to export, or a hard stop with its reason) is this command's whole result. Any other
argument, or none, runs the steps below.

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
         migration engine, and do not run steps 6-7 — nothing comes after this message.
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

2. **If it aborted (exit 2), explain the reason and stop.** Steps 6-7 do not run. Do NOT
   attempt the migration by hand — every abort has a user-side fix:
   - *dirty working tree* → ask the user to commit (or remove the colliding
     untracked files) first; git is the rollback mechanism, so a clean starting
     point is non-negotiable. A first AgenTeX learning leaves
     `.agentex/plugin-learnings.md` untracked: commit it before updating;
   - *not a git repository* → `git init` + an initial commit, then re-run;
   - *stamp newer than the installed plugin* → the project was set up by a newer
     AgenTeX; the user should update the plugin instead;
   - `already up to date` / `no migrations needed` are successes, not aborts —
     just tell the user.

   If it failed mid-run (exit 1, `[error] migration failed`), relay the error and the
   recovery in step 5, and stop: steps 6-7 do not run either.

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
   - `[hook] offer`: the optional pre-commit secret-scan hook is not installed (or an
     older AgenTeX hook is). Explain that it scans each commit's staged content,
     refuses a commit only for a real leak, never overwrites an existing hook, and
     is turned off by deleting the file, and **ask the user explicitly** whether to
     install it. Only after the user confirms, re-run the engine with the consent
     flag — the engine installs it, never you:

     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate.js" --install-pre-commit-hook
     ```

     Never install the hook by hand, and never pass the flag without the user's
     explicit confirmation; a no, or no answer, means nothing is written. The offer
     never affects the migration or the stamp. If this run aborted on the
     clean-tree guard, the consented re-run installs the hook and then aborts on the
     same guard again — expected; relay both lines. The other `[hook]` lines are
     one-line relays: `installed` / `already installed` / `refreshed`, `existing
     hook left untouched` (point to the docs section "Calling the scan from an
     existing hook"), `shared hooks folder, not installed`.
   - `[stray]` report: files that sit outside the project layout (paths only — the
     engine never reads or prints their content). Relay the groups with their counts
     and destinations: litter goes to `.agentex/scratch/strays/<run>/` under the same
     relative paths (gitignored scratch: `${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`);
     the files under "no destination proposed" are listed only. For an
     unplaced **Markdown** file only, you may Read it silently to judge whether it is a
     whole file of settled facts about the application; if it is, propose
     `knowledge/<file name>` with a one-line `knowledge/INDEX.md` description. Never
     quote any candidate's content, never read a non-Markdown candidate, never propose a
     split or a merge. Then **ask the user once**, showing the litter set (groups,
     counts, the destination folder), each knowledge pick with its `INDEX.md` line, the
     tracked files whose move leaves a removal to commit, and that nothing has been
     moved yet. Only after an explicit yes, re-run the engine with the plan from the
     `[stray] plan` line — the engine moves, never you:

     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate.js" --move-strays=<plan> [--stray-to-knowledge=<path>::<one-line description> …]
     ```

     Never move, rename, Write or Edit a listed file by hand (no `mv`, no `git mv`), and
     never pass the flag without the user's explicit yes; a no, a "later", or a partial
     or conditional answer means no flag and nothing moves (offer to re-run the report
     once they have reorganized). The report never affects the migration or the stamp.
     Relay the engine's `[stray]` lines verbatim, including the one preceding step when
     the moves cannot run (`the set changed …` → ask again with the new plan;
     `.agentex/scratch/` not gitignored yet → commit, re-run once without the flag,
     approve again) and `commit the moves, then re-run /update-agentex` — after that
     line the clean-tree guard aborts by design; that is expected. A `FAILED moving`
     line names what moved and what did not; relay it, never retry.

4. **Suggest the follow-up:** verify with a normal `/execute-test` run, then commit
   the whole migration as one commit (the report lists every file touched; `.env`
   is gitignored but was rewritten loss-proof — every removed key's value now lives
   in a committed JSON file).

5. If a run was interrupted, recovery is: **commit the partial state** (or roll it
   back with `git restore`), then re-run this command — the engine detects state
   from files, not from a journal, so the re-run completes the remaining
   migrations. The clean-tree guard stays absolute: it rejects the interrupted
   run's own uncommitted changes too, by design.

6. **Absorption: retire what the new version covers.** Run this only when step 1's
   `migrate.js` run exited 0 (migrations applied, or already up to date); never after the
   pulled STOP, an abort or any other non-zero exit. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/field_feedback.js" absorb-candidates
   ```

   It writes nothing and prints one JSON line. Branch on it, in this order:
   - **exit 2 `ci-mode`, or no `entries` and no `forks`** → say nothing; go to step 7.
   - **any other exit 1 or 2** → one line: the absorption check did not run, and the reason
     from the JSON. Go to step 7.
   - **`blockedBy` is not empty** → one line, no question: "Commit `<paths>` first, then
     re-run `/update-agentex` to review N possibly covered items." (N = entries + forks). Go
     to step 7.
   - **candidates** → judge each entry and fork on its evidence, by the rubric in
     `${CLAUDE_PLUGIN_ROOT}/skills/field-feedback/references/absorption.md` (covered / partly
     covered, forks only / not covered), and write the plan to
     `.agentex/scratch/field-feedback/absorb-plan.json` as it describes. Then, by what the plan
     holds:
     - **nothing covered** (`mark`, `retire` and `review` all empty) → say nothing; go to step 7.
     - **review items only** → tell the user which forks to review by hand (path, plugin
       skill, the one-line why), and that nothing was changed. No question: a yes would apply
       nothing. Go to step 7.
     - **marks or retires** → run:

       ```
       node "${CLAUDE_PLUGIN_ROOT}/scripts/field_feedback.js" absorb-preview --plan .agentex/scratch/field-feedback/absorb-plan.json
       ```

       - Exit 1 or 2 → one line: the plan was refused, the reason, and that nothing changed.
         Go to step 7.
       - Exit 0 → **ask once.** Show the JSON's `message` verbatim (its non-empty groups, in
         order: mark absorbed, retire, review by hand) and ask one yes/no question. No
         second question, no per-item questions.
         - **No, no answer, or a partial or conditional answer** → nothing changes (the
           items are offered again on the next run). Go to step 7.
         - **Yes** → run, with the `planSha` from the preview:

           ```
           node "${CLAUDE_PLUGIN_ROOT}/scripts/field_feedback.js" absorb-apply --plan .agentex/scratch/field-feedback/absorb-plan.json --expect-sha <planSha>
           ```

           - Exit 0 → relay the exact counts per item (`marked`, `retired`, each
             `results[]` line) and suggest committing them with the migration.
           - Exit 2 → relay the reason and that nothing was applied.
           - Exit 1 → relay the reason and every `results[]` line, and say that some items
             may already be applied (marks are written before forks move).

           Never retry the apply. Go to step 7.

   Never edit `.agentex/plugin-learnings.md`, never move, copy or delete a forked skill
   yourself, and never change the plan between the preview and the apply. The script makes
   every change, and only after the user's yes.

7. **Hint.** Count the open entries (lines starting `- [ ] PL-`) in
   `.agentex/plugin-learnings.md`, after any apply in step 6; a missing file counts 0. When
   N > 0, say exactly one line, never a question:
   "N open AgenTeX learnings — `/update-agentex feedback` writes a sanitized export you can
   review and send." Then the command is done.
