# The project layout: where everything the agent writes goes

Every AgenTeX project has the same layout, so the agent always knows where a file belongs and
where to look first. The authoritative routing table is the **AgenTeX block in the project's
`CLAUDE.md`** (between `<!-- agentex:begin project-layout … -->` and
`<!-- agentex:end project-layout -->`). It is loaded in every session, including parallel
executors. This page explains the parts of it that need more than one table row.

## 1. The layout

```
<project>/
├── CLAUDE.md            the user's own rules + ONE AgenTeX-managed block (the routing table)
├── config/ environments/ integration/    settings and catalogs (committed)
├── test/<suite>/ · test/test-data/       specs and test data (committed)
├── knowledge/           settled facts about the application under test (committed)
│   ├── INDEX.md         one line per file; read it first
│   ├── app-map.md       pages, flows, personas
│   ├── business-rules.md   settled business rules (confirmed BA/PO answers)
│   └── gotchas.md       recurring tool or environment problems, with their workaround
├── qa-watchlist/        open items with a trigger (paths from config/project.json → qaRecords)
├── .agentex/            plugin state (version stamp, test template)
│   ├── plugin-learnings.md   gaps in AgenTeX itself that this project worked around (committed)
│   ├── scratch/         every temp, probe, dump or intermediate file (gitignored)
│   └── cache/           tracker caches: field metadata, the Bug mirror (gitignored)
└── executions/          run output: reports, screenshots, logs
```

Nothing outside this layout is written by a plugin skill, command or agent. `/update-agentex`
lists files that sit outside it (paths only) and moves them only after one explicit yes.

## 2. knowledge/

`knowledge/` holds **settled** facts about the application under test: facts confirmed by a
decisive source (a BA or PO answer, the user, the application's own documentation), or
observed repeatedly and confirmed by the user. A one-off observation is not settled.

- **Read `knowledge/INDEX.md` first** (when it exists) before planning a run, designing tests,
  analysing a story or answering a question about the application, then open only the files
  it lists that matter for the task. A project with no `knowledge/` folder is normal: carry
  on, and never create empty files just to read them.
- **Created on first write.** A file appears the first time a fact of its kind is recorded.
  When you create a file, add its line to `INDEX.md` in the same step (create `INDEX.md` too
  if it is missing). Users may add files of their own.

  | File | `INDEX.md` line |
  |---|---|
  | `app-map.md` | `- [app-map.md](app-map.md) — Pages, flows and personas of the application under test` |
  | `business-rules.md` | `- [business-rules.md](business-rules.md) — Settled business rules: confirmed BA/PO answers` |
  | `gotchas.md` | `- [gotchas.md](gotchas.md) — Recurring tool and environment problems, with their workaround` |

  `INDEX.md` starts with `# Knowledge index`, a blank line, and the sentence "Settled facts
  about the application under test. Read this first; open only the files that matter for the
  task." Each knowledge file starts with `# <Title>` and one sentence saying what belongs in
  it.
- **Entry format.** A list item, then an indented `Source:` line naming who or what confirmed
  it and the confirmation date:

  ```markdown
  - The export includes all nine columns, including the two audit columns.
    Source: PO reply on story 1204 · 2026-10-10
  ```

  Continuation lines are indented two spaces. The source never carries a person's private
  data.
- **Append and announce; never rewrite.** Add entries freely and tell the user in one line
  what you recorded and where ("Recorded in `knowledge/business-rules.md`: the export
  includes all nine columns."). Never edit or remove an existing entry, yours or the user's,
  without the user's explicit yes for that change. A new fact that contradicts an old one is
  appended with its own source and date; point out the conflict and ask which one stands.
- **Committed.** `knowledge/` is never gitignored.
- **Not the plugin's own feedback.** A workaround for an AgenTeX defect is not an application
  fact and does not belong in `gotchas.md`. `knowledge/gotchas.md` holds problems with
  the app's tools or environment; a gap in AgenTeX itself goes to `.agentex/plugin-learnings.md`.

## 3. Lifecycle

- Settled facts go to `knowledge/`.
- Open items with a trigger (a question awaiting an answer, a retest, an environment blocker,
  a deferred condition) go to the QA watchlist, only through AgenTeX's `qa-records.js` helper.
  Each kind's file is set in `config/project.json` → `qaRecords`.
- **When a watchlist item closes with a settled answer**, resolve it through `qa-records.js`
  (its history is kept) and add the answer to the matching `knowledge/` file with its source
  and date. A closure with no lasting fact adds nothing:

  | Kind resolved | Carry to `knowledge/` when… | File |
  |---|---|---|
  | `pendingQuestions` | the reply decides a rule or expected behaviour | `business-rules.md` (a rule) or `app-map.md` (how a page or flow behaves) |
  | `envIssues` | the problem is **recurring** and has a known workaround; a one-off outage carries nothing | `gotchas.md` |
  | `pendingRechecks` | normally never (a passed retest is not a fact) | none |
  | `deferredConditions` | it was dropped by the owner's decision (a scope rule) | `business-rules.md` |

## 4. Scratch

- Every temp, probe, exploration, dump or intermediate file, including every `--out`,
  `--spec`, `--*-file` and `--data` argument and your own helper scripts, goes under
  `.agentex/scratch/<task>/` in the project root. Create the folder when it is missing.
  Never write such a file anywhere else: not the project root, not `.agentex/cache/`, not a
  system temp location.
- In a parallel run, add the session name to the subfolder
  (`.agentex/scratch/<task>/<session>/`), so two executors never share a file.
- The subfolders in use:

  | Subfolder | Written by |
  |---|---|
  | `tracker/` | tracker reads with `--out`, write specs, id lists, comment bodies |
  | `qa-records/` | the QA watchlist helper's `--text-file`, `--data`, `--resolution-file` and `--out` files |
  | `bugs/<run>/` | bug specs and annotation specs (the annotated copies land beside them) |
  | `swagger/` | a fetched API definition staged for the importer |
  | `login/` | the login script and its failure dumps |
  | `define-flow/` | the running draft of a flow definition |
  | `field-feedback/` | AgenTeX learnings exports, the absorption plan, retired forked skills |
  | `probes/` | any other probe or exploration script, and its output |

  Test design and estimation keep their flat files (`cases.json`, `tasks.json`,
  `estimation-proposal.json`) directly in `.agentex/scratch/`.
- **Tool-owned dumps are the tool's.** playwright-cli writes its snapshots and console logs to
  `.playwright-cli/` on its own; that folder is gitignored and cleaned at the end of a run.
  Never choose a file name inside it yourself.
- **Evidence is not scratch.** Screenshots, logs and reports of a run go under the run's
  `SESSION_DIR` in `executions/`.
- `.agentex/scratch/` is gitignored and safe to delete at any time.
