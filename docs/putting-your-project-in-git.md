# Putting your project in git

Your AgenTeX project — specs, catalogs, config — is worth sharing with your team through git.
This page says what to commit and what stays on your machine, how to set a remote safely, and
how the plugin's secret scan and optional pre-commit hook keep a secret from reaching git
history.

## What to commit

| Path | Commit? | Why |
|---|---|---|
| `config/project.json` | Committed | Project settings. Secrets are referenced by name (`{ "envSecret": "NAME" }`), never stored here. |
| `config/estimation.json` | Committed | Your team's estimation tasks and factors (created by the first approved estimation run). |
| `environments/*.json` | Committed | Per-environment data. Secret fields reference `.env` by name. |
| `integration/` | Committed | The API/DB catalogs: the only calls your test steps may make. |
| `test/` (specs) | Committed | Your test specs. |
| `test/baselines/` | Committed | Design baseline screenshots you chose for `ui-check:` steps. |
| `CLAUDE.md` | Committed | Project guidance for Claude. |
| `.gitignore` | Committed | Keeps the local-only paths below out of commits. |
| `.agentex/version.json` | Committed | The plugin version this project was set up for (`$agentex:update-agentex` reads it). |
| `.agentex/test-template.md` | Committed | Your test-design conventions. |
| `.claude/settings.json` | Committed | The shared permissions block. |
| `.env` | **Local** | Secrets only. Never commit it. |
| `test/.auth/` | **Local** | Saved login sessions — each file is a live session token. |
| `test/.auth/api-tokens/` | **Local** | API tokens the suite wizard captured from the app's UI, one file per suite and environment (mode 0600). Already covered by `test/.auth/`. |
| `.playwright-cli/` | **Local** | The browser's scratch profile — the same cookies, on disk. |
| `test/.ui-baselines/` | **Local** | A cache of design baselines; `ui-check` re-fetches them. |
| `.agentex/cache/` | **Local** | Tracker field metadata, rebuilt on demand. To commit it anyway, add the line `!.agentex/cache/` to `.gitignore`. |
| `.agentex/cache/api-data/` | **Local** | Test-data values the suite wizard collected, with where each came from. Deleting it loses nothing committed: the suite keeps each value and its source. |
| `.agentex/scratch/` | **Local** | Agent scratch: intermediate files of test-design and estimation runs. Safe to delete. |
| `executions/` | Your team's choice | Run reports and evidence — see below. |
| `.claude/worktrees/`, `.claude/settings.local.json` | **Local** (recommended) | Created by Claude Code itself — see below. |
| `qa-watchlist/` | Committed | Arrives with AgenTeX 1.0.0 — see below. |

`$agentex:init-test` writes the `.gitignore` entries for every **Local** row that the plugin creates;
`$agentex:update-agentex` adds any entry an older project is missing (existing lines are never changed).

## `executions/`

`executions/` is **not** ignored by default: its reports, screenshots and logs are the evidence
a tester hands over, and many teams want that history in git. If your team prefers to keep runs
local, add one line to `.gitignore`:

```
executions/
```

When you do commit it, the secret scan covers it like every other file: text files under the
size limit are checked; screenshots are skipped as binary and counted in the scan's result.

## Setting the git remote by hand

The plugin never sets a remote and never pushes. Add your team's remote yourself, with a URL that
carries **no credentials**:

```
git remote add origin https://git.example.com/team/qa-project.git
```

and let a credential helper hold your login (for example the Git Credential Manager that ships
with Git for Windows, or the macOS keychain helper).

> **Never put a token or a PAT in the remote URL** (`https://user:TOKEN@…`). Git stores the URL in
> plain text in `.git/config`, and it shows up in logs and error messages. The secret scan stops
> on it (`remote-credential`). The fix:
>
> ```
> git remote set-url origin https://git.example.com/team/qa-project.git
> ```
>
> and then rotate the token — treat it as leaked.

## Claude Code's own files

Claude Code (not AgenTeX) creates `.claude/worktrees/` and `.claude/settings.local.json`. They
are personal to your machine. AgenTeX does not add them to `.gitignore` for you; we recommend
adding them yourself:

```
# Claude Code — personal, not for the team
.claude/worktrees/
.claude/settings.local.json
```

Keep `.claude/settings.json` committed: it holds the shared permissions block.

## `qa-watchlist/`

AgenTeX 1.0.0 adds a `qa-watchlist/` folder for the project's tracking notes. It is meant to be
committed, and nothing in the scaffold ignores it.

## Running the scan on demand

The secret scan checks your project's own secret values — every value in `.env`, plus every
variable an `{ "envSecret": "NAME" }` field refers to — and a few structural mistakes. It never
prints a value: findings name the file, the line and the key, field or label only.

It runs in two modes:

- **staged** — exactly what the next commit carries (the content in git's index, not your
  working copy). The pre-commit hook uses this mode.
- **tracked** — every file git tracks.

The easiest way to run it is to re-run `$agentex:init-test` in a git repository: its "git readiness" step
runs the tracked scan and relays the findings. With the hook installed you can also run it from
a terminal:

```
sh .git/hooks/pre-commit --tracked
```

(use your own hooks folder if you set `core.hooksPath` — see below).

**Your first commit** — the riskiest one, because everything goes in at once:

1. `git init`
2. Run `$agentex:init-test` (or re-run it). Accept the hook offer if you want every commit checked.
3. `git add -A`
4. Scan: re-run `$agentex:init-test`, or, with the hook installed, just commit — the hook scans exactly
   what you staged.
5. `git commit -m "Initial commit"`

## The hook

The optional pre-commit hook runs the staged scan on every commit — from a terminal, an IDE, or
Claude. A real leak refuses the commit and tells you the file, line and key, and where the fix
is documented. Warnings and a skipped value check are shown, and the commit goes ahead. If the
scan cannot run (Node.js missing, the plugin uninstalled, a scan error), the commit goes ahead
and the hook says loudly that the secret scan did **not** run.

**Opting in.** `$agentex:init-test` offers it, and so does `$agentex:update-agentex`. Nothing is installed
without your explicit yes. A plugin update never disables it: the hook finds the newest
installed AgenTeX version each time it runs.

**An existing hook.** If your repository already has a `pre-commit` hook that AgenTeX did not
install, AgenTeX leaves it untouched and tells you so. See the next section to add the scan to it.

**A custom hooks folder.** If `core.hooksPath` is set for this repository, the hook goes into
that folder and nothing is written to `.git/hooks`. If `core.hooksPath` is set machine-wide (in
your global or system git config), that folder is shared by every repository on your machine, so
AgenTeX does not install there — add the scan to your own hook instead.

### Calling the scan from an existing hook

1. Ask Claude to show you the AgenTeX hook snippet (it runs
   `node "<plugin>/scripts/precommit_hook.js" print`).
2. Save it as `agentex-secret-scan` in your hooks folder.
3. Add one line to your own `pre-commit` hook:

   ```
   sh "$(git rev-parse --git-path hooks)/agentex-secret-scan" || exit 1
   ```

   (with a custom `core.hooksPath`, use that folder's path instead). The snippet exits 1 only on
   a leak, so your hook refuses the commit only then.

**Turning it off.** Delete the file `pre-commit` in your hooks folder. Find the folder with
`git config core.hooksPath` (if set) or `git rev-parse --git-path hooks`.

**"AgenTeX secret scan did NOT run".** The commit went through unscanned: Node.js was not found,
the AgenTeX plugin was not found (uninstalled or moved), or the scan stopped with an error.
Install Node.js or the plugin again, then scan what you committed (`--tracked`).

## Fixing findings

Every finding names a file and line, plus a key, field, label or remote name — never the value
itself. A secret that already reached git history or a remote **must be rotated**: removing it
from the latest commit does not take it back, and the scan cannot un-leak it.

### `secret-value` (leak)

The value of a `.env` key (or of a variable an `envSecret` field refers to) appears in that file.
Remove it and refer to it instead: in a spec, describe it ("the API token from `.env`"); in an
environment or catalog file, use `{ "envSecret": "NAME" }`. If the finding names a field, the
value sits in a plain-string secret field — move it into `.env` the same way.

### `short-value-labeled` (leak)

A short secret value (under 8 characters) appears right after a password label. The shared test
password in a spec is the usual case (`password: 123456`). Replace the literal with a reference
such as "the shared test password, `DEFAULT_PASSWORD` in `.env`" — "login as valid_user" already
takes it from the environment. If the finding is in `config/project.json` (a `defaultsFields`
entry), drop that descriptor's `default` and mark the field secret in the setup wizard.

**How short values are checked.** A value shorter than 8 characters is never matched on its own:
it would also appear inside phone numbers, IBANs and other long numbers. It is checked only:

- right after a password label — `password`, `pass`, `pwd`, `passcode`, `كلمة المرور` or
  `كلمة السر` (any letter case), followed by `:` or `=`, optionally with spaces, quotes,
  backticks or markdown emphasis — and only as a whole token; or
- in JSON, under a key that contains such a label, or as the `default` / `value` of an object
  whose `key`, `name` or `id` contains one.

Other occurrences are not checked, and the key is listed among the values not checked. A value
under 4 characters is not checked at all. Both numbers are tunable defaults, not guarantees.

### `env-file-tracked` (leak)

`.env` itself is in git's index. Untrack it (the file stays on your disk), then commit:

```
git rm --cached .env
git commit -m "Stop tracking .env"
```

If it was ever pushed, rotate every value in it.

### `remote-credential` (leak)

A git remote's URL carries a password or token. Set a clean URL
(`git remote set-url <name> <URL without credentials>`), use a credential helper, and rotate
the token. See "Setting the git remote by hand" above.

### `plain-secret-field` (warning)

A secret-capable field in `environments/*.json` (`db.password`, `api.token`,
`defaults.password`, or a field your schema marks secret) holds a plain string. This is legal
and fine for throwaway test credentials; the commit is not blocked. To keep it out of git, put
the value in `.env` and reference it: `{ "envSecret": "NAME" }` — the warning suggests the name
(`DEFAULT_PASSWORD` for `defaults.password`). In `integration/*.json`, the warning means a
`…Env` field (such as `tokenEnv`) holds something that is not a variable name — probably the
value itself. Put the value in `.env` under a name and set the field to that name.

### "value check skipped"

There is no `.env` (or it has no values yet, or every value is excluded), so no value could be
checked. The structural checks — `.env` tracked, remote credentials, plain-string fields — still
ran. Fill in `.env` and scan again.

### Values not checked

- **Short values** — see "How short values are checked" above.
- **Non-secret config keys** — an older project may still keep settings such as a URL or an Azure
  DevOps area path in `.env`. They are not secrets, so they are not value-checked; move them into
  `config/project.json` or the environment file (`$agentex:update-agentex` does this for the keys it
  knows).
- **Base URLs** — any `.env` key named `*_BASE_URL` (such as the `<NAME>_BASE_URL` that
  `$agentex:import-swagger` asks for) holds a service address, not a secret, so it is not value-checked
  and can stay in `.env`.

### Files skipped

Binary files (such as screenshots), files over 1 MiB, symlinks and submodules are not scanned;
the result counts each kind.

### `unparseable-config` (warning)

An environment or catalog file is not valid JSON, so the plain-string field check skipped it
(its text was still scanned for values). Fix the JSON.

## A commit was refused for a value I know is not a secret

The hook refuses a commit only when a value from your `.env` appears in a committed file. `.env`
holds secrets only, so a non-secret value there — a URL, a team name, a test phone number — is
in the wrong place. Move it to `config/project.json` or `environments/<env>.json` (the setup
wizard has a field for most of them), delete the line from `.env`, and commit again.
