---
name: jira-confluence-integration
description: Coordinate safe, idempotent workflows that span Jira Cloud and Confluence Cloud while delegating product-specific operations to the Jira ACLI and Confluence ACLI skills. Use when a request needs both products, such as auditing Jira-to-Confluence relationships, reconciling a page's embedded Jira keys against the tracker, publishing Jira sprint or release reports to Confluence, or turning a Confluence specification into linked Jira work items. Reading and reconciling both sides is fully ACLI-native; the writes that close a loop are not — ACLI cannot create a Confluence page or a Jira remote link, so those steps need the documented REST fallback and a relationship built ACLI-only is one-directional. Do not use for Jira-only or Confluence-only work, or for Server/Data Center deployments.
---

# Jira-Confluence Integration

Orchestrate cross-product Cloud workflows without duplicating the product-specific command guidance. Treat Jira work items and Confluence content as separate systems with separate permissions, versioning, and failure modes.

## What is reachable with ACLI alone (verified live, acli 1.3.22)

Most of this skill's value is in **reading and reconciling both sides** — that part is fully
ACLI-native. The **writes that close a cross-product loop are not.** Establish which half a
request needs before promising an outcome:

| Capability | ACLI-only? |
|---|---|
| Read Jira work items, JQL, links between work items | **Yes** |
| Read Confluence spaces/pages, walk the tree, read storage bodies | **Yes** |
| Parse Jira keys/JQL out of a page's macros and reconcile against Jira | **Yes** |
| Audit relationships and classify valid / missing / stale / duplicate | **Yes** |
| Create or update a **Confluence page** (publish a report, sync a section) | **No** — `page` is view-only; no `create`/`update`. Only `blog create` writes content. |
| Create or read a **Jira remote link** (the Confluence backlink) | **No** — `acli jira workitem link` handles Jira↔Jira links only; `workitem view --fields remotelinks` returns `null`. |

Consequences to state plainly rather than work around:

- A **Jira → Confluence publication** (release report, status page, postmortem) cannot be
  completed ACLI-only. Use the REST fallback in `confluence-acli`, or produce the content and
  tell the user the page needs creating.
- **Bidirectional linking cannot be completed ACLI-only.** The Confluence→Jira direction works
  via a `jira` macro in the page body; the Jira→Confluence direction needs
  `POST /rest/api/3/issue/{key}/remotelink`, which no ACLI command exposes. A relationship
  built ACLI-only is **one-directional by construction** — report it as such, never as
  bidirectional.

  Note the boundary this crosses: `jira-acli` forbids direct Jira REST calls, and this skill's
  own rule is to follow the stricter safeguard when the two product skills differ. That rule
  still holds — **the remote-link REST call is the one documented exception, it belongs to this
  skill rather than `jira-acli`, and it requires the user to ask for the backlink explicitly.**
  Do not make the call as a silent side effect of "publish this report"; name it, say it steps
  outside the ACLI-only boundary, and get a yes first.
- The **relationship audit** recipe is fully achievable and is the highest-value ACLI-only
  workflow here.

## Route to the product skills

Read the applicable instructions before interacting with either product:

- `${CLAUDE_PLUGIN_ROOT}/skills/jira-acli/SKILL.md` for Jira discovery, JQL, work-item changes, links, attachments, bulk safeguards, and ACLI troubleshooting.
- `${CLAUDE_PLUGIN_ROOT}/skills/confluence-acli/SKILL.md` for Confluence command routing, REST fallback, content IDs, page versions, storage format, pagination, and mutation safeguards.

Use only the **jira-acli** skill for a Jira-only request and only the **confluence-acli** skill for a Confluence-only request. Continue with this orchestration workflow only when the requested outcome genuinely crosses both products.

## Follow the integration workflow

### 1. Define the relationship

Identify:

- Source product and source object
- Destination product and destination object
- Direction: Jira to Confluence, Confluence to Jira, or bidirectional
- Stable identifiers: Jira work-item key or ID, Confluence page ID, site hostname, and space ID or key
- Source of truth for each field or content section
- Whether the operation is a one-time publication, repeatable synchronization, or relationship audit

Do not use a Confluence title, Jira summary, JQL result order, or URL text as the only identity. Read [linking-patterns.md](references/linking-patterns.md) before creating or repairing links.

### 2. Verify tenancy, identity, and authorization

Check each tool's installed version, live command help, active profile, authenticated account, and site before reading private content or making a change. Do not assume that Jira authentication grants Confluence access.

Confirm whether both products intentionally belong to the same Atlassian Cloud site. Stop on an unexpected site or account mismatch. Read [identity-and-auth.md](references/identity-and-auth.md) when multiple sites, accounts, API tokens, OAuth sessions, or REST fallbacks are involved.

Never request, echo, copy, or persist credentials. Keep the authentication mechanism selected by each underlying skill.

### 3. Build a read-only execution plan

Resolve and read every existing object before writing:

1. Query Jira for the exact work-item keys and fields required by the output.
2. Resolve the Confluence space, parent, page ID, current body, status, and version.
3. Inspect existing Jira remote links and the current Confluence references to Jira.
4. Decide whether each intended operation is `create`, `update`, `link`, `skip`, or `conflict`.
5. Show counts and representative targets before any bulk or filter-driven operation.

Prefer deterministic ordering, such as Jira key ascending, so repeated reports produce stable output. State when a query or page listing is sampled, limited, or incomplete.

### 4. Apply idempotency and concurrency controls

For a repeatable workflow:

- Reuse the Confluence page ID after the first successful create.
- Use a deterministic Jira remote-link global ID when the selected Jira interface supports one.
- Check for an existing relationship before creating another.
- Update by stable ID rather than title or summary.
- Fetch the current Confluence version immediately before an update and increment it exactly once.
- Recompute Jira-derived content from the same declared JQL and field set.
- Preserve page sections, macros, labels, and metadata that are outside the requested integration-owned region.

Do not turn a failed lookup or update into a new object automatically. Treat duplicate matches, version conflicts, changed Jira scope, and ownership ambiguity as conflicts that require resolution.

### 5. Execute in dependency order

For a Jira-to-Confluence publication:

1. Read and normalize the Jira result set.
2. Create or update the intended Confluence content.
3. Read back the Confluence ID, URL, version, and relevant body.
4. Create or update Jira remote links only after the Confluence URL is verified.
5. Verify the relationship from both sides when bidirectional linking was requested.

For a Confluence-to-Jira workflow:

1. Read the Confluence source and record its immutable page ID and current version.
2. Create or update the requested Jira work items.
3. Read back the Jira keys, URLs, and requested fields.
4. Update the Confluence page with verified Jira references without replacing unrelated content.
5. Add or update Jira backlinks when requested.

For multi-stage workflows, checkpoint the created IDs after each verified stage. If a later stage fails, report the resumable checkpoint. Do not delete or roll back successfully created objects unless the user explicitly authorizes that compensating action.

Read [workflow-recipes.md](references/workflow-recipes.md) for release reports, specification breakdowns, status pages, and postmortems.

### 6. Verify the final state

After each mutation:

- Read back the Jira work item or narrow JQL result.
- Read back the Confluence page, version, status, and web URL.
- Confirm that links resolve to the intended site and stable object.
- Confirm that rerunning the workflow would update or skip rather than duplicate.

Report the Jira keys, Confluence page IDs and titles, sites and spaces, created versus updated objects, verified links, skipped items, conflicts, and partial failures. Do not claim end-to-end success when only one product was updated.

## Apply cross-product safeguards

- Follow the stricter safeguard when the two underlying skills differ.
- Require explicit authorization before deletes, purges, broad JQL-driven changes, permission changes, restriction changes, or destructive compensation.
- Never broaden JQL, silently switch spaces, or substitute a similarly named page.
- Never overwrite concurrent Confluence edits; refetch and compare after a version conflict.
- Never handcraft undocumented Confluence macro storage markup. Prefer supported CLI or REST representations, Smart Links, or a verified existing macro structure.
- Never put private Jira fields or restricted Confluence content into a destination with broader visibility.
- On HTTP `429` or a transient `5xx` with `Retry-After`, honor the delay and retry only an idempotent stage with bounded exponential backoff and jitter. Re-read state before retrying any stage whose mutation result is uncertain.
- Redact tokens, authorization headers, cookies, private page bodies, and sensitive work-item fields from logs and reports.

## Handle partial failure

Classify the completed and pending stages explicitly. Preserve verified IDs and versions needed to resume, then retry only the failed stage after correcting its cause. Re-read both products before resuming because Jira fields, workflow state, Confluence content, permissions, or page versions may have changed.
