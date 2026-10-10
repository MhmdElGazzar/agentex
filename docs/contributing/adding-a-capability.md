# Adding a Capability

[Adding a Skill](./adding-a-skill.md) walks through a small, single-script skill end to end.
This page is for something bigger: a whole new **part** of AgenTeX — its own driven-tool, its
own subagent, its own command, its own docs page — the way `test-execution` /
`qa-executor` / `/execute-test` fit together. Use it as a checklist when a change is more than
"one skill, one script."

The real (non-toy) worked example for this page is the **mobile-testing** capability — Appium
support alongside the existing test-execution flow. Every file category below names its
mobile-testing counterpart so you can read the actual files instead of a synthetic example.

**A new way to execute test steps should prefer the driver contract.** If the capability
runs spec steps against a new kind of target (a device, a desktop app, a queue), build it
as a *driver* of `test-execution`, per
[`skills/test-execution/references/concepts/driver-contract.md`](../../skills/test-execution/references/concepts/driver-contract.md):
a driver skill, a routing row, a `spec_drivers.js` entry, a `ci_preflight.js` check, and the
same `executions/` tree and `run-summary.json`. Then reports, CI, and bug filing work
unchanged. A separate command + subagent + orchestrator, the shape mobile-testing currently
has, forks all of that; only choose it when the driver contract genuinely cannot fit, and
say why in the design.

## Checklist

1. **Confirm it's capability-sized, not skill-sized.** If it's one deterministic script behind
   one judgment call, you want [Adding a Skill](./adding-a-skill.md) instead — don't build the
   scaffolding below for something that small (see
   [Conventions](./conventions.md#shared-reference-rule) on avoiding premature structure).

2. **Name it** — noun-style skill, verb-style command, exactly like a regular skill (see
   [Conventions](./conventions.md#naming)). A capability with its own driven tool usually also
   gets its own subagent name, distinct from `qa-executor` if the driving mechanics genuinely
   differ (isolation model, evidence shape, tool commands) — e.g. `mobile-qa-executor` alongside
   `qa-executor`, not a flag bolted onto the existing one.

3. **`skills/<name>/SKILL.md`** — judgment layer, same shape as any skill: role, target/config
   resolution, tools pointer, execution output layout, modes, defect format, rules. Model it
   directly on the closest existing skill rather than inventing a new shape. `mobile-testing`
   was modeled on an earlier `test-execution`, then diverged: it keeps its own run tree
   (`mobile-sessions/`), writes no `run-summary.json`, and has no CI mode. Compare against the
   current `test-execution`, not against the fork.

4. **`skills/<name>/references/*.md`** — one file per distinct tool/mechanism the skill can
   drive with. It's fine to document more than one way to do the same job side by side (e.g.
   `appium-server-cli.md` for raw WebDriver REST vs `appium-client-wrapper.md` for the bundled
   script) — `SKILL.md` should say which to read before which action, and let the agent (or the
   project's existing setup) pick.

5. **`skills/<name>/scripts/`** — reuse the existing orchestration scripts' *shape*, not their
   code, for anything mechanical: a `preflight.js` that probes every tool the capability needs
   in one call, an `init_run.js` that scaffolds the execution tree in one call, a `merge_run.js`
   that copies bug evidence in one call. **Every script ships with a `.test.js`** per
   [Testing](./testing.md), the small fs/probe ones included: the mobile `init_run.js`,
   `merge_run.js`, and `preflight.js` each hid a real bug (path traversal, a stack trace on a
   missing value, a silent `npx` download) until a test pinned it. Better still, reuse
   `test-execution`'s scripts instead of forking them.
   - **No bundled npm dependencies.** The plugin ships zero npm packages of its own — every
     script uses only Node built-ins (or global `fetch`). If a capability's driver needs a
     real npm client library (like `webdriverio`), it must be the **consumer's** own
     devDependency, resolved dynamically from `process.cwd()` at run time
     (`require.resolve('<pkg>', { paths: [process.cwd()] })`), with a `BLOCKED` result and
     install instructions when it's missing — see `appium_client.js`.

6. **A dedicated subagent**, if the capability has its own isolated-session model (own
   `agents/<name>-qa-executor.md` if the isolation/evidence mechanics genuinely differ from the
   existing one; otherwise reuse `qa-executor.md`). Keep the injected-parameters block, tool
   commands, evidence paths, and output contract in the same shape as the existing subagent so
   the orchestrating skill's dispatch logic stays consistent.

7. **`commands/<verb>.md`** — thin entrypoint, same pattern as any command (suite-folder
   resolution, environment resolution, mode selection, a pointer to read the relevant
   reference before the first tool use). See `commands/execute-mobile-test.md` next to
   `commands/execute-test.md`.

8. **Reuse tool-agnostic skills as-is.** Step types like `api:` / `db:` / `kb:` aren't
   browser-specific — the mobile-testing skill and subagent call `api-integration` /
   `db-integration` / `ask-kb` exactly as test-execution does, no duplication (see
   [Conventions](./conventions.md#shared-reference-rule)).

9. **If the config shape needs to grow** (a new kind of target beyond `portalUrl`), add it as
   a new optional block in `environments/<env>.json` rather than a parallel config file — see
   the `mobile` block added alongside `db`/`api`. Document it in `docs/configuration.md`, with
   an example block. Keep an optional block **out of** the scaffolded sample
   (`templates/environments/qc.json`): it would land in every new project and break opt-in.
   If you ever change that template, append the outgoing shape to
   `HISTORICAL_SAMPLE_ENV_SHAPES` in `scripts/lib/scaffold.js`, so projects scaffolded from
   it are still recognised as pristine. Never break existing (browser-only) projects: the
   new block must be optional and additive.

10. **`docs/<name>.md`** — user-facing doc mirroring the closest existing one (walkthroughs,
    spec-writing guide, quick reference table, setup snippet, reference pointers). See
    `docs/mobile-testing.md` next to `docs/test-execution.md`.

11. **Wire it up everywhere a skill would, plus:**
    - Row in `docs/README.md`'s table and the root `README.md` feature table (a new capability
      this size usually also earns a badge next to the existing ones).
    - `CHANGELOG.md` entry under `[Unreleased]`.
    - `settings.example.json` — permission entries for the capability's new CLI tools.
      `allow` only read-only probes (like `adb devices`, `npx appium --version`). Put in
      `ask` anything that installs or fetches code, runs an arbitrary command, sends data off
      the machine, or destroys state: `curl`/`sqlcmd` are `ask` entries, and so are
      `npx appium driver install`, `xcrun simctl spawn`, and `adb uninstall`. `ask` beats
      `allow`, so a narrow `ask` can carve a prompt out of a broad `allow`.
    - `.claude-plugin/plugin.json` — new keywords, and update the top-level `description` if
      the capability is a first-class feature (not just an internal helper).
    - Bundled sample specs under `test/<name>-suite1/` if the capability runs test specs, and a
      pointer to them from `test/README.md`.

## Recap

| File | Layer |
|------|-------|
| `skills/<name>/SKILL.md` | judgment |
| `skills/<name>/references/*.md` | mechanics, one file per tool/mechanism |
| `skills/<name>/scripts/*.js` (+ a `.test.js` for each) | deterministic orchestration + drivers |
| `agents/<name>-qa-executor.md` | isolated per-session execution (only if mechanics differ from the existing subagent) |
| `commands/<verb>.md` | thin entrypoint |
| `docs/<name>.md` | user-facing walkthrough |
| `docs/README.md` / root `README.md` / `CHANGELOG.md` / `plugin.json` / `settings.example.json` | wiring |

Next: [Conventions](./conventions.md) for the naming/security rules this checklist assumes, or
[PR Workflow](./pr-workflow.md) to open the change.
