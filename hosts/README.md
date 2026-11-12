# hosts/

Build settings for each AI coding tool AgenTeX is published to. `main` is written as a Claude
Code plugin and is the only source. For each folder here, the build turns `main` into that
tool's plugin format and publishes it to its own git branch.

This folder is for maintainers. Users never see it: it is left out of every published build.

## What's here

| Folder | Tool | Published branch | What its build does |
|--------|------|------------------|---------------------|
| [claude/](./claude/host.json) | Claude Code | `store` | Copies `main` minus maintainer-only files, with no format change. Guards keep it under the plugin directory's 512-file limit and without a root `.gitattributes`. |
| [codex/](./codex/host.json) | OpenAI Codex | `codex` | Converts commands into user-invoked skills, moves agent definitions to `references/agents/`, and adds the Codex manifest and marketplace file from `overlay/`. |
| [copilot/](./copilot/host.json) | GitHub Copilot (CLI and VS Code agent) | `copilot` | Small conversion, because Copilot reads the Claude layout: renames the ask tool, replaces the plugin-root path with a placeholder, names the agents and commands folders in the manifest, and adds `overlay/.github/plugin/marketplace.json`. |
| [devin/](./devin/host.json) | Devin (Desktop and CLI) | `devin` | Converts commands into skills (mentions rewritten to `/agentex:<skill>`) and replaces the plugin-root path with a placeholder. |

Each folder holds:

- **`host.json`**: the target branch, an optional release tag, extra paths to `exclude`, the
  `transforms` to run, and the `guards` the result must pass. Its `description` field explains
  the host in one paragraph.
- **`overlay/`** (some hosts): files copied on top of the converted tree, such as that tool's
  manifest or marketplace file.

## How a build runs

[`scripts/hosts/build_host.js`](../scripts/hosts/build_host.js) does it, in this order:

1. Export `main`'s files.
2. Drop the maintainer-only paths, plus this host's `exclude` list.
3. Run the `transforms`.
4. Copy `overlay/` on top.
5. Run the `guards`.

Any guard finding fails the build and nothing is published. The `.github/workflows/hosts.yml`
workflow runs one build per host on every push to `main`. To see what a build would produce
without publishing anything:

```
node scripts/hosts/build_host.js --host claude --list
```

## Read next

- [docs/contributing/host-branches.md](../docs/contributing/host-branches.md): the full explanation.

## Don't

- **Don't edit a host branch (`store`, `codex`, `copilot`, `devin`) by hand.** The builder
  refuses to build over a commit it did not make. Change `main` or the files here instead.
