# Demo shop QA

- Run the smoke suite before any regression.

- `executions/` holds generated test-run artifacts (reports, screenshots, logs).
  Never read or search it when gathering context — only when explicitly asked
  about a specific run.

<!-- agentex:begin project-layout v1 hash=66b714fbfa13 -->
## AgenTeX: where things go in this project

Maintained by the AgenTeX plugin; `/update-agentex` refreshes it. Keep your own rules
outside this block: if you edit inside it, AgenTeX stops refreshing it and tells you so.

**Read `knowledge/INDEX.md` first** (when it exists) before planning a run, designing tests,
analysing a story or answering a question about the application, then open only the files it
lists that matter for the task. No `knowledge/` folder is normal: carry on, and never create
empty files just to read them.

| If you are about to write… | …put it here |
|---|---|
| A settled fact about the application, confirmed by a BA/PO answer, by the user, or by the application's own documentation | `knowledge/`: `app-map.md` (pages, flows, personas), `business-rules.md` (settled business rules), `gotchas.md` (recurring tool or environment problems and their workaround) |
| An open item with a trigger: a question awaiting an answer, a retest, an environment blocker, a deferred condition | The QA watchlist, only through AgenTeX's `qa-records.js` helper; each kind's file is set in `config/project.json` → `qaRecords` |
| A test spec or test data | `test/<suite>/`, `test/test-data/` |
| Project settings, environments, API/DB catalog entries | `config/`, `environments/`, `integration/`, through the AgenTeX flows that own them |
| Run output: reports, screenshots, logs | `executions/` |
| Any temp, probe, exploration, dump or intermediate file, including every `--out`, `--spec` and `--*-file` argument and your own helper scripts | `.agentex/scratch/`, one subfolder per task, and nowhere else |
| A rule about how you should work in this project | `CLAUDE.md`, outside this block |
| Anything about this project or its application you want to remember next session | The matching row above (usually `knowledge/`), never your personal memory: no teammate ever sees it. Personal memory is only for the user's own preferences |

1. Settled facts go to `knowledge/`; open items with a trigger go to the QA watchlist. A
   one-off observation is not settled.
2. Every `knowledge/` entry is a list item followed by a `Source: <who or what confirmed it>
   · <YYYY-MM-DD>` line. Add entries freely and tell the user in one line what you recorded
   and where. Never rewrite or remove an existing entry without the user's explicit yes for
   that change. When you create a `knowledge/` file, add its one-line description to
   `knowledge/INDEX.md` in the same step.
3. When a watchlist item closes with a settled answer, resolve it through `qa-records.js`
   (its history is kept) and add the answer to the matching `knowledge/` file with its
   source and date. A closure with no lasting fact, such as a retest that passed or a
   blocker that simply cleared, adds nothing.
<!-- agentex:end project-layout -->
