---
name: tracker-ops
description: >
  Ad-hoc work-item operations on the configured tracker — Azure DevOps or Jira Cloud —
  behind one approval per write batch. Use this skill whenever the user asks for a one-off
  board operation outside the shipped flows: "move PROJ-12 to In Progress", "transition
  this issue to Done", "comment on bug 4711", "link X to Y", "update the story's title",
  "create a quick task on the board", "show me work item 42", "search the board for …".
  Every operation runs through ONE bundled script (dry run by default, REST over built-in
  fetch — no az, no acli); reads are free, writes show the exact request plan first and
  need the user's ONE approval before --execute. Unsupported operations are answered
  upfront from the tracker's capability flags — never guessed, never silently substituted.
---

# Tracker Ops — ad-hoc work-item operations (one gate per write batch)

## Role
You carry out one-off work-item asks on the configured tracker (Azure DevOps or Jira Cloud):
show, search, create, update, transition, comment, link. You never write to the board without
the user's one approval for that write batch.

For one-off board asks that no shipped flow covers. Every operation goes through ONE
bundled script — never `az` or `acli`, never hand-composed REST; it resolves the configured
tracker (the `azure` or `jira` block in `config/project.json`) and reads credentials from
`.env` itself, Authorization-header-only:

```
node ${CLAUDE_PLUGIN_ROOT}/skills/tracker-ops/scripts/workitem.js <subcommand> …
```

| Subcommand | What it does | Kind |
|---|---|---|
| `show --id <id> [--expand all]` | Provider-neutral work-item summary (id, type, title, state, url, fields) | read |
| `search --query "<jql\|wiql>"` | Runs the query in the **configured provider's** query language (`capabilities.query` says which); returns ids/titles | read |
| `create --type <type> --spec <file.json>` | Creates a work item — spec: `{ fields, relations? }`, provider-level field ids | write |
| `update --id <id> --spec <file.json>` | Updates fields — spec: `{ fields, addRelations? }` | write |
| `transition --id <id> --to <name-or-id>` | Jira: resolves against the issue's REAL transitions (no match fails closed listing them). ADO: **routes to the honest equivalent — a `System.State` field update — and says so** in the plan; never dressed up as a workflow transition | write |
| `comment --id <id> --body "<text>"` | Adds a comment (plain text; the script owns the ADF wrapping on Jira). Unsupported on the configured tracker → answered upfront (exit 2, the capability flag named) | write |
| `link --id <id> --type <linkType> --target <id> [--direction inward]` | Links two items — Jira: an issue link with that type name (acting item outward by default); ADO: the relation reference name | write |

One JSON line out, exit 0/1/2. Spec files go to the OS temp dir, never committed.

## The one gate

1. **Reads run freely** (`show`, `search`) — no approval needed.
2. **Every write is a dry run first** (no `--execute`): the script returns the exact
   request plan (`plan` + the nothing-written note) and sends **nothing**. Render that
   plan for the user — route, body, and for a transition the resolved target state.
3. **ONE approval per write batch**: collect every write the ask implies, show the plans
   together on one screen, and get one explicit approval — then re-run each with
   `--execute`, in the approved order. Anything other than an approval → stop, zero writes.
4. Report results exactly (ids + URLs, or the error); a partial batch is a **failure** —
   name what landed. No retries, no cleanup writes — remediation is the user's call.

## Honest gaps (capability flags)

Answer unsupported asks upfront from the flags — never improvise:

- **Delete** is never offered on either provider from this surface; on Jira the only
  delete is permanent and the plugin never performs permanent destroys.
- **Comments on ADO**: not wired (`capabilities.comments` unset) — the script refuses with
  the flag named; tell the user honestly.
- **Test plans/runs on Jira**: don't exist (`testPlans`/`testRuns: false`).
- In CI (`AGENTEX_CI=1`) every write is mechanically refused (exit 2, `ci-mode`); reads
  and dry-run plans still work.

Provider knowledge (field ids, link semantics, JQL/WIQL gotchas) lives in
`${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md` and
`${CLAUDE_PLUGIN_ROOT}/references/tracker/jira-boards.md` — read the configured provider's
before composing specs or interpreting results.

## Rules

- Never run `az`/`acli` or compose REST calls for board operations — the script owns
  transport, auth, and validation.
- Never read `.env*` or place a credential anywhere — the script reads them itself.
- Field values and link/transition names come from the user or the tracker's real data
  (the script's fail-closed errors list the real options) — never invented.
- The consumer's config is never rewritten; corrections are for the run only.
