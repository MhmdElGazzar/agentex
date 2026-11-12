# scripts/

Plugin-wide Node scripts: project setup and migration, the secret scan, plugin self-update,
shared libraries, and the tools maintainers use to test and release AgenTeX. Scripts that
belong to a single skill live in that skill's own `skills/<name>/scripts/` folder instead.

Every script runs with plain `node` (Node.js 20+) and needs no `npm install`. Each file starts
with a header comment giving its usage, so read that first. Next to most scripts is a
`*.test.js` file that tests it.

## What's here

### Used in your project (they ship with the plugin)

| File | What it does | Called by |
|------|--------------|-----------|
| [init.js](./init.js) | Scaffolds a project: config, environment, `.env`, sample specs, catalog, `CLAUDE.md`. Never overwrites an existing file. | `/init-test` |
| [migrate.js](./migrate.js) | Migrates a project to the installed plugin's conventions, carrying your values over, never resetting them. | `/update-agentex` |
| [self_update.js](./self_update.js) | Checks for a newer plugin version and, with your OK, updates it. | `/update-agentex` (step 0) |
| [secret_scan.js](./secret_scan.js) | Checks whether a project is safe to commit: secrets in files, a tracked `.env`, credentials in the remote URL. | `/init-test`, the pre-commit hook, on request |
| [precommit_hook.js](./precommit_hook.js) | Installs the optional git pre-commit hook that runs the secret scan, only after you say yes. | `/init-test` |

| Folder | What it holds |
|--------|---------------|
| [lib/](./lib/) | Shared code: project config loading, scaffolding, the secret-scan core, git helpers, version info, estimation config, and `tracker/` (the Azure DevOps and Jira REST layer every tracker skill uses). |
| [migrations/](./migrations/) | One numbered file per migration step that `migrate.js` runs in order (for example `03-env-split.js`). |
| [wizard/](./wizard/) | The local setup-wizard page behind `/init-test`: `server.js`, `engine.js`, `ui.html`, and the question `schema.json`. |

### For maintainers

| Path | What it does | Ships? |
|------|--------------|--------|
| [run-tests.js](./run-tests.js) | Runs every `*.test.js` in the repo in parallel: `node scripts/run-tests.js [--filter <text>]`. | no |
| [dev/](./dev/) | `affected.js` picks the tests and evals a change can affect. `architecture.js` generates the diagrams in the main README. `changelog.js` folds `changelog.d/` fragments into `CHANGELOG.md` at release time. `e2e/` is the end-to-end harness. | no |
| [hosts/](./hosts/) | `build_host.js` builds the plugin for each AI tool (Claude Code, Codex, Copilot, Devin) from `main`, with `transforms.js` and `guards.js`. The settings live in [`../hosts/`](../hosts/README.md). | no |
| [release-gate/](./release-gate/README.md) | The end-to-end check run before a release. `gate-plan.js` decides which test lanes a change needs. Has its own README. | yes, except `gate-plan.js` |

"Ships?" means "is included in the plugin users install". The list of what is left out is
`COMMON_EXCLUDES` in [hosts/build_host.js](./hosts/build_host.js).

## Read next

- [docs/contributing/testing.md](../docs/contributing/testing.md): how tests are run and written.
- [docs/contributing/host-branches.md](../docs/contributing/host-branches.md): how host builds work.
- [docs/configuration.md](../docs/configuration.md): what `init.js` and `migrate.js` write, from a user's view.

## Don't

- **Don't print or pass secret values on a command line** from any script. Scripts read `.env`
  themselves and send values only in request headers.
- **Don't add a migration that resets a user's value.** Migrations move values to their new
  home; they never replace them with samples.
