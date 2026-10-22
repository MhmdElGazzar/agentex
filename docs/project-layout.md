# Project layout

Every AgenTeX project has the same layout, so the agent always knows where a file belongs and
where to look first: settled knowledge about your application in one folder, open items in
another, and every temporary file in one ignored scratch folder. This page describes that
layout, the block AgenTeX keeps in your `CLAUDE.md`, and the stray-file check that
`/update-agentex` runs.

## The layout

```
<project>/
├── CLAUDE.md            your own rules + ONE AgenTeX-managed block (see below)
├── config/ environments/ integration/    settings and catalogs (committed)
├── test/<suite>/ · test/test-data/       specs and test data (committed)
├── knowledge/           settled facts about the application under test (committed)
│   ├── INDEX.md         one line per file; the agent reads it first
│   ├── app-map.md       pages, flows, personas
│   ├── business-rules.md   settled business rules (confirmed BA/PO answers)
│   └── gotchas.md       recurring tool or environment problems, with their workaround
├── qa-watchlist/        open items with a trigger (paths set in config/project.json → qaRecords)
├── .agentex/            plugin state (version stamp, test template)
│   ├── plugin-learnings.md   gaps in AgenTeX itself that this project worked around (committed)
│   ├── scratch/         every temp, probe, dump or intermediate file (gitignored)
│   └── cache/           tracker field metadata (gitignored)
└── executions/          run output: reports, screenshots, logs
```

`knowledge/` and the QA watchlist files appear the first time something is recorded. A project
that never records a fact has no `knowledge/` folder, and that is normal.

## The AgenTeX block in `CLAUDE.md`

`/init-test` adds one block to the end of your `CLAUDE.md`, and `/update-agentex` adds it to an
existing project. It sits between two marker lines:

```
<!-- agentex:begin project-layout v1 hash=… -->
…
<!-- agentex:end project-layout -->
```

It holds the routing table below, the instruction to read `knowledge/INDEX.md` first, and the
three lifecycle rules. Claude Code loads `CLAUDE.md` in every session, including the parallel
executors of a test run, so this block is the one place the agent always checks before it
writes a file.

- **Your own rules go outside the block.** AgenTeX never edits a byte outside the markers: not
  your bullets, not their order, not the `executions/` bullet an earlier version added.
- **A refresh arrives with `/update-agentex`.** When a new AgenTeX version changes the table
  (a later feature may add a row), the block is updated in place, wherever you moved it.
- **If you edit inside the block, AgenTeX stops refreshing it.** The next `/update-agentex`
  leaves it exactly as you left it and shows a `[flag]`. To get the current block back, move
  your own lines outside it, delete the block (both marker lines too), and re-run
  `/update-agentex`.
- If the file ends up with two blocks, or a marker without its partner, nothing is written and a
  `[flag]` asks you to keep one begin/end pair.
- **A `CLAUDE.md` that is a symlink stays a symlink.** If your `CLAUDE.md` links to another
  file (for example `AGENTS.md`), the block is written into that file, and the file keeps its
  permissions. If the link points to a file that does not exist, nothing is written, no
  file is created, and a `[flag]` names the missing target.

## Where things go

The block's routing table, as it ships:

| If you are about to write… | …put it here |
|---|---|
| A settled fact about the application, confirmed by a BA/PO answer, by the user, or by the application's own documentation | `knowledge/`: `app-map.md` (pages, flows, personas), `business-rules.md` (settled business rules), `gotchas.md` (recurring tool or environment problems and their workaround) |
| An open item with a trigger: a question awaiting an answer, a retest, an environment blocker, a deferred condition | The QA watchlist, only through AgenTeX's `qa-records.js` helper; each kind's file is set in `config/project.json` → `qaRecords` |
| A test spec or test data | `test/<suite>/`, `test/test-data/` |
| Project settings, environments, API/DB catalog entries | `config/`, `environments/`, `integration/`, through the AgenTeX flows that own them |
| Run output: reports, screenshots, logs | `executions/` |
| Any temp, probe, exploration, dump or intermediate file, including every `--out`, `--spec` and `--*-file` argument and your own helper scripts | `.agentex/scratch/`, one subfolder per task, and nowhere else |
| A rule about how you should work in this project | `CLAUDE.md`, outside this block |
| A workaround for a gap in the AgenTeX plugin itself: a plugin skill, command or script failed or could not do the job, the user had to repeat a correction, you wrote a helper script for something AgenTeX should do, or an AgenTeX skill was copied into `.claude/skills/` | One entry in `.agentex/plugin-learnings.md`, appended only through AgenTeX's `field-feedback` skill; never by hand, never edit an existing entry |
| A project rule you believe the AgenTeX plugin itself should adopt | A `CLAUDE.md` bullet outside this block, tagged `[agentex:promote]` |
| Anything about this project or its application you want to remember next session | The matching row above (usually `knowledge/`), never your personal memory: no teammate ever sees it. Personal memory is only for the user's own preferences |

## `knowledge/` and `INDEX.md`

`knowledge/` holds **settled** facts about the application under test: confirmed by a decisive
source (a BA or PO answer, you, the application's own documentation), or observed repeatedly
and confirmed by you. A one-off observation is not settled.

- The agent reads `knowledge/INDEX.md` first, then opens only the files that matter for the
  task. `INDEX.md` has one line per file, saying what the file holds.
- Every entry is a list item with a `Source:` line naming who or what confirmed it and the
  date:

  ```markdown
  - The export includes all nine columns, including the two audit columns.
    Source: PO reply on story 1204 · 2026-10-10
  ```

- The agent **adds** entries as it learns and tells you in one line what it recorded and where.
  It **never rewrites or removes** an existing entry, yours or its own, without your explicit
  yes for that change. A new fact that contradicts an old one is added with its own source, and
  the agent asks you which one stands.
- You can add your own files; list each one in `INDEX.md`.
- `knowledge/` is committed, so the next session and your teammates start from what was
  already learned.

## The QA watchlist and when it drains into `knowledge/`

Open items with a trigger (a question waiting for an answer, a retest, an environment
blocker, a deferred condition) go to the QA watchlist, through AgenTeX's `qa-records.js`
helper. When an item closes with a settled answer, the entry is resolved (its history stays in
the file) and the answer is added to `knowledge/`. A closure with no lasting fact adds nothing.

| Kind resolved | Carried to `knowledge/` when… | File |
|---|---|---|
| `pendingQuestions` | the reply decides a rule or expected behaviour | `business-rules.md` (a rule) or `app-map.md` (how a page or flow behaves) |
| `envIssues` | the problem is recurring and has a known workaround; a one-off outage carries nothing | `gotchas.md` |
| `pendingRechecks` | normally never (a passed retest is not a fact) | none |
| `deferredConditions` | it was dropped by the owner's decision (a scope rule) | `business-rules.md` |

## Scratch

Every temporary, probe, exploration, dump or intermediate file that any AgenTeX skill, command
or agent writes goes under `.agentex/scratch/`, one subfolder per task (`tracker/`,
`qa-records/`, `bugs/<run>/`, `swagger/`, `login/`, `define-flow/`, `probes/`). Nothing of
that kind lands at the project root or in a system temp folder.

`.agentex/scratch/` is gitignored and safe to delete at any time. Tools that keep their own
scratch, such as playwright-cli's `.playwright-cli/`, keep it there, also ignored. Run evidence
is not scratch: it stays in `executions/`.

## The stray-file check

Every `/update-agentex` run, including on a project that is already up to date, lists the
files that sit outside this layout. It never affects the migration or the version stamp.

**What is reported:**

- agent litter anywhere outside the protected folders: `probe-*`, `explore-*`, `recon-*`,
  `scratch-*`, `tmp-*`, `temp-*`, `.tmp-*`, `.scratch_*`, `*-out.txt`, `*.tmp`, and any file in
  a folder named `tmp`, `temp` or `scratch` (dotted or not);
- files at the project root that are not ordinary project files: data dumps (`.json`,
  `.txt`, `.log`, `.csv`, …) and scripts are litter; anything else is listed with no
  proposal;
- files under `.agentex/` that AgenTeX does not define;
- extra files you put beside the QA watchlist files.

**What is never reported:** `test/`, `config/`, `environments/`, `integration/`,
`executions/`, `knowledge/`, `.git/`, `.claude/`, `.env` files, the files AgenTeX defines,
anything your `.gitignore` ignores, ordinary root files, OS files such as `.DS_Store`, and the
contents of folders you created yourself (only litter-named files inside them are reported).
Ordinary root files are `README.md`, `LICENSE` and the like; package manifests and lockfiles
(`package.json`, `requirements.txt`, `requirements-dev.txt`, `pyproject.toml`, `pom.xml`,
`.terraform.lock.hcl`, …); tool configuration by its shape (`*.config.*`, `*.conf.*`, `.*rc`,
`.*rc.*`, `.*ignore`, `tsconfig*.json`, `global-setup.*`, `jest.setup.js`, `cucumber.js`,
`nodemon.json`, `cypress.env.json`, `appsettings.json`, `appsettings.<Environment>.json`,
`sonar-project.properties`, `renovate.json`, …); and build, container and CI files
(`Makefile`, `Taskfile.yml`, `justfile`, `Dockerfile*`, `docker-compose*.yml`,
`azure-pipelines*.yml`, …). A litter-named file stays litter even when it looks like tool
config: `probe-jest.config.js` and `jest.config.js.tmp` are both reported, and so is a dump
such as `requirements-probe-output.txt` (a requirements or constraints file has one name
part after `requirements` or `constraints`).

**The guarantees:**

- **Report-only by default.** The report lists paths only. It never reads or prints a file's
  content, and it changes nothing.
- **One yes, exactly the listed set.** The agent shows the proposed set once: litter to
  `.agentex/scratch/strays/<run>/`, under the same relative paths, and, for a Markdown file it
  judges to be a whole file of settled facts, `knowledge/<file>` with its `INDEX.md` line.
  Only your explicit yes moves anything. Anything else ("no", "later", a partial answer)
  moves nothing. The agent never moves a file by hand.
- **Lossless.** A moved file is byte-identical at its destination. An existing file is never
  overwritten, nothing is ever deleted, and files are never merged or split.
- **Tracked files.** Moving a file git already tracks leaves its removal for you to commit.
- **A yes is never lost.** If the moves cannot run in the same invocation, you are told the
  one step to take first (for example, commit the moves and re-run `/update-agentex` to finish
  a pending migration).

**To keep a root file without it being reported,** put it in a folder of your own, or add it to
`.gitignore`.
