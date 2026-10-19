# Host Branches

AgenTeX is written once, as a Claude Code plugin, on `main`. Every other host gets its own
branch, generated from `main` on every push by `.github/workflows/hosts.yml`. Nobody edits a
generated branch by hand.

| Branch | Host | Store it feeds |
|--------|------|----------------|
| `store` | Claude Code | Claude plugin directory |
| `copilot` | GitHub Copilot (CLI and VS Code) | awesome-copilot (pins the `copilot-v<version>` tag) |
| `devin` | Devin Desktop / Devin CLI (formerly Windsurf) | devin-marketplace (pins a sha; `devin-v<version>` tag) |
| `codex` | OpenAI Codex (CLI and app) | Codex Plugin Directory |

## What this means when you change `main`

Write it the Claude way. You never write host-specific text in a skill. The converters handle
the differences:

- **`${CLAUDE_PLUGIN_ROOT}`**: on hosts that don't expand it in skill text, it becomes
  `<agentex-root>`. A short note under each skill's frontmatter tells the model what that
  stands for.
- **Commands**: Devin and Codex get them as user-invoked skills (`commands/x.md` →
  `skills/x/SKILL.md`). When a skill of the same name already exists, the command becomes
  `skills/x-command/`. Every `/x` mention in instruction text becomes that host's syntax:
  `/agentex:x` on Devin, `$agentex:x` on Codex. On Codex an `agents/openai.yaml` beside each
  one stops Codex from starting it on its own.
- **Agents**: Codex plugins can't ship agents, so they move to `references/agents/`, and the
  note tells Codex to spawn them as native subagents.
- **`AskUserQuestion`** is renamed to each host's ask tool.

A change only breaks a host build when a converter can't handle it, and then the build fails
loudly and publishes nothing. The usual causes:

- A skill description longer than 1024 characters (the Agent Skills limit on Copilot, Devin
  and Codex).
- A skill whose `name` doesn't match its folder.
- A folder under `skills/` with no `SKILL.md`.
- A command with no `description`.

Run the host tests before you push:

```
node scripts/hosts/build_host.test.js     # builds every host from HEAD; commit first
node scripts/hosts/build_host.js --host codex --list   # see exactly what a host gets
```

## How a build works

`scripts/hosts/build_host.js --host <name>` reads `hosts/<name>/host.json` from the commit it
builds, then:

1. Exports the tree and drops what no host ships: `evals/`, `*.test.js`, test golden
   fixtures (`skills/*/scripts/golden/`), `.github/`, `.gitattributes`, `hosts/`,
   `scripts/hosts/`. Then it drops the host's own `exclude` list. The non-Claude hosts also
   drop `docs/contributing/`, because it documents `main` and the converters would rewrite its
   Claude examples, and `skills/browser-testing/`, a deprecated CI forwarder with no
   `SKILL.md` that their stores reject.
2. Runs the host's `transforms`, in order (`scripts/hosts/transforms.js`).
3. Copies `hosts/<name>/overlay/` on top, for files only that host gets.
4. Runs the host's `guards` (`scripts/hosts/guards.js`). Any finding fails the build.
5. Commits on top of the branch's current head, so the branch only fast-forwards. An
   unchanged tree makes no commit. It refuses, and pushes nothing, when that head wasn't
   made by the builder (a hand edit is never silently overwritten), or when the source is
   older than the one the head was built from (a re-run of an old workflow run never rolls
   the branch back). The workflow itself runs only for `main`.
6. With `tag` set, the first build of a **new** plugin version also pushes
   `<host>-v<version>`. Stores that pin a tag or sha (Copilot, Devin) need one. The version a
   branch was created at is never tagged, because it wasn't released there.

A refused build exits 2 with the reason in its JSON line. To recover from a hand edit, move
the branch back to its last generated commit and make the change on `main` instead.

Everything happens in git objects and a temporary index. Your working tree is never touched.

## Adding a host

1. Add `hosts/<name>/host.json` with a `target.branch`, the `transforms` it needs and the
   `guards` its store enforces. Copy the closest existing host as a starting point.
2. Add the host to the matrix in `.github/workflows/hosts.yml`.
3. Add a contract test for it in `scripts/hosts/build_host.test.js`. It should cover what the
   built tree must and must not contain.
4. Certify it before the first store submission: install the generated branch in the real
   host, then run one sequential spec with an approval gate, one parallel run and one `api:`
   step.

The research behind each host's settings, with sources, is summarised in the `description`
field of its `host.json`.
