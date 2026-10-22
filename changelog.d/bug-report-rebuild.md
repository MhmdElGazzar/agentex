### Added
- **Bug filing checks the whole project for duplicates, not only the selected story.**
  `bug-report-azure` keeps a local copy of the project's recent Bugs
  (`.agentex/cache/bugs/tracker-bugs-ado.json`, which stays out of git even with the
  `!.agentex/cache/` opt-in) and ranks the defect against it
  together with the parent story's Bugs. Each filing refreshes the copy with one read of
  the Bugs changed since the last sync, so a Bug filed a minute ago counts. A match under
  another story is marked `source: "project"` with its `parentId`. Scope: the project
  (under `azure.areaPath` when set), Bugs changed in the last `azure.bugCacheDays` days
  (default 365; `0` turns it off). A sync that cannot complete blocks the filing, like any
  duplicate-check failure. `--refresh-bugs` on `context`/`prepare` forces a full rebuild.
- **Bug filing shows matching QA watchlist entries.** Open `qa-watchlist/` entries (a fix
  awaiting retest, a question awaiting an answer, an environment blocker, a deferred
  condition) that match the defect or sit on the same story appear as `watchlistMatches`
  on the approval screen, so a parked item is not filed as a new Bug by mistake. A
  watchlist file that cannot be read blocks the filing.

### Changed
- **`bug-report-azure` rebuilt around one agent-facing operation
  (`skills/bug-report-azure/scripts/bug-report.js context/prepare/execute`).** The agent no
  longer composes Azure requests or reads raw templates directly: `context` returns a
  compact bootstrap (validated parent/template summary, resolved defaults, real allowed
  picklist values, and an `intentTemplate` scaffold) and, once a semantic intent exists,
  a deterministic duplicate-review shortlist; `prepare` re-validates against fresh runtime
  data and writes a local, integrity-checked plan artifact with zero board writes; `execute`
  accepts only that exact plan and performs the writes behind one consolidated approval.
  The intent, annotation and plan files live under `.agentex/scratch/bugs/<run-folder>/`.
  Duplicate presentation now goes through a new deterministic lexical/IDF ranking module
  (`skills/bug-report-azure/scripts/duplicate-ranking.js`) that orders candidates and
  explains matches without making any duplicate verdict itself — that judgment call stays
  with the agent. Covered by new `.test.js` files for both scripts and
  by new discipline evals (`discipline-bug-filing-deferred-bundle`,
  `discipline-bug-filing-early-bundle`, `discipline-bug-filing-efficient-flow`,
  `discipline-bug-filing-fallback-trigger`, `discipline-bug-filing-cross-story-watchlist`)
  alongside updated fixtures/prompts for the existing `discipline-bug-filing-*` cases.
  The rebuilt flow is community **PR #19** by @Hager-Helmy, carried in with her
  authorship; its batch read was folded into the shared `getWorkItems`, and the
  project-wide Bug mirror and QA watchlist matches were added on top of her ranking.
- **On Jira, bug filing keeps the 0.23.0 flow.** The rebuilt `bug-report.js` files Azure
  DevOps Bugs only and refuses a Jira config before any request (`unsupported-tracker`);
  the Jira path in `create-bug.js` keeps its behaviour and is documented in
  `skills/bug-report-azure/references/jira-filing.md`. Annotated screenshots (attach the
  annotated copy followed by the raw one) carry over to the rebuilt flow. Candidate
  discovery reads through the shared `getWorkItems` batch read, and every candidate now
  carries its web URL.
