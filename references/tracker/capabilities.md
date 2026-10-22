# Tracker capability matrix

Which tracker operation works on which provider, and the capability flag that decides it.
The bundled scripts check these flags **upfront**: an operation whose flag is false on the
configured tracker is refused with exit 2 and the flag named, before any request — never
attempted, never silently replaced by something else. When the user asks for a refused
operation, say so, name the flag, and ask what they want instead (policy Q11).

A unit test (`scripts/lib/tracker/capabilities.test.js`) compares every cell below with the
flags the adapters declare, so this table cannot drift from the code.

- **supported** — the operation runs on that tracker.
- **refused** — the flag is false there; the script refuses upfront (exit 2, flag named).
- **routed** — the tracker has no native API for it; the script performs the honest
  equivalent and states it in the plan.

| Operation | Flag | ADO | Jira |
|---|---|---|---|
| `tracker.js search` (query text, `--fields`, `--top`) | `query` | supported (wiql) | supported (jql) |
| `tracker.js show --fields --out` | — | supported | supported |
| `tracker.js batch` (many ids, chosen fields) | `batchRead` | supported | supported |
| `tracker.js comments` (read the thread) | `comments` | supported | supported |
| `tracker.js comment` / `update --discussion` (post) | `comments` | supported | supported |
| `--mention` on a discussion post | `mentions` | supported | supported |
| `tracker.js relations --kind parent` | `relations.parent` | supported | supported |
| `tracker.js relations --kind child` | `relations.child` | supported | supported |
| `tracker.js relations --kind related` | `relations.related` | supported | supported |
| `tracker.js relations --kind tested-by` | `relations.testedBy` | supported | refused (`relations.testedBy: false`) |
| `tracker.js iterations` (team iterations / board sprints) | `sprints` | supported | supported |
| `tracker.js transition` | `transitions` | routed (a State-field update, stated in the plan) | supported |
| `tracker.js update` / `create` / `link` | — | supported | supported |
| `testplan.js ensure-plan` | `testPlans` | supported | refused (`testPlans: false`) |
| `testplan.js ensure-suite` | `testPlans` | supported | refused (`testPlans: false`) |
| `testplan.js record --outcome` (and `fail`) | `testPlans`, `testRuns` | supported | refused (`testPlans: false`, `testRuns: false`) |
| Remove a case from a suite (release gate only) | `testPlans` | supported | refused (`testPlans: false`) |

Notes:

- **Remaining work on ADO.** `tracker.js update` refuses a spec that sets
  `Microsoft.VSTS.Scheduling.RemainingWork` (ADO rejects it server-side, TF401320) — exit 2
  before any request. On Jira a remaining-estimate update is legitimate and is not refused.
- **Text you will analyse** goes through `--out .agentex/scratch/<name>.json` (UTF-8) and is
  read from the file — never through a pipe, which can drop non-ASCII characters.
- **Truncation.** `truncated: true` on a search means "at the cap; more may exist" — narrow
  the query, never read it as "that's all".
- Provider details live in `ado-boards.md` and `jira-boards.md` beside this file.
