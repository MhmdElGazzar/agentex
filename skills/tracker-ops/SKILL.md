---
name: tracker-ops
description: >
  Ad-hoc work-item operations on the configured tracker — Azure DevOps or Jira Cloud — behind
  one approval per write batch. Use this skill whenever the user asks for a one-off board read
  or write outside the shipped flows: "move PROJ-12 to In Progress", "comment on bug 4711",
  "reply on the story and mention the PO", "link X to Y", "update the story's title", "show me
  work item 42", "show me the comments on story 42", "list the [Testing] tasks under this
  story", "what's in next sprint", "pull these 300 items' fields", "search the board for …".
  Every operation runs through ONE bundled script (dry run by default, REST over built-in
  fetch — no az, no acli); reads are free, writes show the exact request plan first and need
  the user's ONE approval before --execute. Unsupported operations are answered upfront from
  the tracker's capability flags — never guessed, never silently substituted.
---

# Tracker Ops — ad-hoc work-item operations (one gate per write batch)

## Role
You carry out one-off work-item asks on the configured tracker (Azure DevOps or Jira Cloud):
read items, threads, relations and sprints; search; create, update, transition, comment and
link. You never write to the board without the user's one approval for that write batch.

For one-off board asks that no shipped flow covers. Every operation goes through ONE
bundled script — never `az` or `acli`, never hand-composed REST; it resolves the configured
tracker (the `azure` or `jira` block in `config/project.json`) and reads credentials from
`.env` itself, Authorization-header-only:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/tracker.js <subcommand> …
```

| Subcommand | What it does | Kind |
|---|---|---|
| `show --id <id> [--expand all] [--fields f1,f2] [--out <file>]` | Provider-neutral work-item summary (id, type, title, state, url, fields); `--fields` reads only those fields | read |
| `search --query "<jql\|wiql>" [--fields f1,f2] [--top n] [--out <file>]` | Runs the query in the **configured provider's** language (`capabilities.query`). On ADO a WIQL that names no project is scoped to the configured one. `truncated: true` = at the cap, more may exist | read |
| `batch (--ids a,b,… \| --ids-file <file>) --fields f1,f2 [--out <file>]` | Many items at once, only the asked fields, in input order; ids the tracker does not return are listed under `missing` | read |
| `comments --id <id> [--out <file>]` | The item's comment thread, oldest first, as `{author, date, text}` (plain text) | read |
| `relations --id <id>[,<id>…] [--kind parent\|child\|tested-by\|related\|link\|all] [--fields f1,f2] [--out <file>]` | Neutral relations — e.g. a story's `[Testing]` tasks with `--kind child` — at a request cost that does not grow per child | read |
| `iterations [--team <name> \| --board <id\|name>] [--timeframe current\|future\|past\|all] [--out <file>]` | ADO team iterations / Jira board sprints; no team (ADO) or board (Jira) configured or passed → exit 2 naming the setting | read |
| `create --type <type> --spec <file.json>` | Creates a work item — spec: `{ fields, relations? }`, provider-level field ids | write |
| `update --id <id> [--spec <file.json>] [--discussion "<text>" \| --discussion-file <file>] [--mention <who>]` | Updates fields — spec: `{ fields, addRelations? }` — and/or posts a discussion reply; both together run as one ledgered plan | write |
| `transition --id <id> --to <name-or-id>` | Jira: resolves against the issue's REAL transitions (no match fails closed listing them). ADO: **routes to the honest equivalent — a `System.State` field update — and says so** in the plan; never dressed up as a workflow transition | write |
| `comment --id <id> (--body "<text>" \| --body-file <file>) [--mention <who>]` | Adds a comment. The script renders the provider's exact body (HTML-encoded on ADO, ADF on Jira) | write |
| `link --id <id> --type <linkType> --target <id> [--direction inward]` | Links two items — Jira: an issue link with that type name (acting item outward by default); ADO: the relation reference name | write |

`--mention` takes `createdBy`, `assignedTo`, an email, or a display name. The script turns it
into the tracker's real mention (an ADO mention anchor, a Jira mention node) or refuses with
exit 2 and the candidates — it never posts a bare `@name`.

One JSON line out, exit 0/1/2. Every file argument (`--out`, `--spec`, `--ids-file`,
`--body-file`, `--discussion-file`) is a path under `.agentex/scratch/tracker/` in the project
root, for example `--out .agentex/scratch/tracker/1204-comments.json`. Create the folder if it
is missing; it is gitignored agent scratch. Never write such a file anywhere else in the
project, and never in a system temp location
(`${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`).

## The one gate

1. **Reads run freely** (`show`, `search`, `batch`, `comments`, `relations`, `iterations`) —
   no approval needed.
2. **Every write is a dry run first** (no `--execute`): the script returns the exact
   request plan (`plan` + the nothing-written note) and sends **nothing**. Render that
   plan for the user — route, body, and for a transition the resolved target state.
3. **A mention is shown rendered.** For a comment or discussion reply, show the user the
   exact body from the plan — the mention in its rendered form and the person it resolved
   to (`mention`) — not your paraphrase of it.
4. **ONE approval per write batch**: collect every write the ask implies, show the plans
   together on one screen, and get one explicit approval — then re-run each with
   `--execute`, in the approved order. Anything other than an approval → stop, zero writes.
5. Report results exactly (ids + URLs, or the error, or the ledger); a partial batch is a
   **failure** — name what landed. No retries, no cleanup writes — remediation is the
   user's call.

## Rules

- **Text you will analyse goes through `--out .agentex/scratch/tracker/<name>.json` and Read — never
  through a pipe.**
  Piping a description, acceptance criteria or a comment thread through another command can
  drop non-ASCII characters; the file holds the exact UTF-8 bytes the tracker sent.
- **Remaining work is refused on ADO** (the server rejects it — TF401320; the script refuses
  before any request). Say why and offer completed work
  (`Microsoft.VSTS.Scheduling.CompletedWork`, the hours the user confirms) through the same
  one gate. Never try to work around the refusal.
- **A mention that does not resolve stops the write.** Show the candidates the script lists
  and ask who was meant.
- Never run `az`/`acli` or compose REST calls for board operations — the script owns
  transport, auth, and validation.
- Never read `.env*` or place a credential anywhere — the script reads them itself.
- Field values and link/transition names come from the user or the tracker's real data
  (the script's fail-closed errors list the real options) — never invented.
- The consumer's config is never rewritten; corrections are for the run only.

## Honest gaps (capability flags)

Answer unsupported asks upfront from the flags — never improvise. The full operation ×
provider matrix is `${CLAUDE_PLUGIN_ROOT}/references/tracker/capabilities.md`.

- **Delete** is never offered on either provider from this surface; on Jira the only
  delete is permanent and the plugin never performs permanent destroys.
- **Tested-by relations and test plans/runs on Jira**: don't exist
  (`relations.testedBy`, `testPlans`, `testRuns: false`) — the script refuses with the flag
  named.
- In CI (`AGENTEX_CI=1`) every write is mechanically refused (exit 2, `ci-mode`); reads
  and dry-run plans still work.

Provider knowledge (field ids, link semantics, WIQL/JQL gotchas) lives in
`${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md` and
`${CLAUDE_PLUGIN_ROOT}/references/tracker/jira-boards.md` — read the configured provider's
before composing specs or interpreting results.
