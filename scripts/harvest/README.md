# Field-feedback harvest

A maintainer tool. It reads the AgenTeX projects you name, read-only, and writes one report
of the field signals they hold: learnings the agent recorded, plugin skills a project copied,
helper scripts, port checklists, probes and ad hoc watchlists. It is never shipped to a host
and no command, skill or agent mentions it.

```
node scripts/harvest/harvest.js (--root <dir>)… [--roots-file <file>] [--out <dir>] [--label basename|index]
```

## Roots

The union of every `--root`, the `--roots-file` (one path per line, `#` comments, blank lines
ignored) and the `AGENTEX_HARVEST_ROOTS` environment variable (the OS path delimiter: `:` or
`;`). There is no default. With no root the script exits 2 and writes nothing. A roots file
inside the plugin repo is refused: it names consumer projects.

## What it reads

Only `readdir`, `lstat` and `readFile` on paths it matched. It starts no process (no git), loads
no network module, follows no symlink, never descends into `.git`, `node_modules`,
`executions`, `.auth` (so `test/.auth`) or `.playwright-cli`, and never opens a file whose name
starts with `.env`. Every root is byte-identical afterwards, `.git/index` and `.git/config`
included.

| Signal | Where | Reported |
|---|---|---|
| `learning` | `.agentex/plugin-learnings.md` | id, date, trigger, affected, version, status, problem, workaround |
| `fork` | `.claude/skills/*/SKILL.md` | the plugin skill, the rule (`name` or `self-described`), the folder |
| `promotion` | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` | file, line, the bullet. `[agentex:promote]`, or "candidate for promotion to AgenTeX", or "promote / upstream … to AgenTeX". The AgenTeX block's own text is skipped |
| `helper-script` | `.agentex/scripts/**`, `.agentex/*.{js,mjs,cjs,ts,py,sh,ps1}` | path, size, line count. Never the content |
| `port-checklist` | `.agentex/**/*.md`, root `*notes*.md` with a "port to the plugin", "pending changes" or "upstream" line | file, count and text of the unchecked items |
| `root-probe` | root `probe-*`, `explore-*`, `recon-*` scripts, `*-out.txt`, `*_dump*.json` | names. Never opened |
| `adhoc-watchlist` | files named like a watchlist, pending questions or open questions, outside the configured `qaRecords` paths | path, line count |

## What it writes

Two files in `--out` (default: `<temp dir>/agentex-harvest-<UTC timestamp>/`):

- `report.md`: grouped by affected plugin skill, then by signal kind, with counts across
  projects. Learnings the plugin already absorbed get their own section at the end. The first
  line says it holds consumer specifics.
- `report.json` (`schemaVersion` 1): the same data for tooling.

The destination is resolved with `realpath` and refused (exit 2, nothing written) inside the
plugin repo (which covers the nested planning repo) or inside any root. **The report contains
consumer specifics: never commit it to the plugin repo or the planning repo. Generalize before
filing anything from it.**

## Output and exit codes

One JSON line on stdout:
`{"tool":"agentex-field-harvest","schemaVersion":1,"result":"OK|PARTIAL|ERROR","roots","scanned","unreadable","signals":{…},"out"}`.

| Exit | Meaning |
|---|---|
| 0 | OK |
| 1 | PARTIAL: a root was unreadable (named by label in `unreadableRoots`); the rest is reported |
| 2 | usage error or refused destination; nothing written |

`--label basename` (default) names a project by its folder name (duplicates get `-2`, `-3`);
`--label index` uses `project-1`, `project-2`, so the folder names never reach the report.
