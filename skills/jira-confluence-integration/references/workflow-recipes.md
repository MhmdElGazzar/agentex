# Cross-Product Workflow Recipes

Use these recipes as orchestration patterns. Defer Jira commands and safeguards to the **jira-acli** skill; defer Confluence commands, REST calls, page versioning, and storage handling to the **confluence-acli** skill.

**Which recipes work ACLI-only** (verified live, acli 1.3.22 — see the reachability table in
`SKILL.md`): only the **audit** recipe runs end to end without a fallback. The three
publishing recipes below all create or update a Confluence page, which `acli confluence page`
cannot do (view-only), and the linking steps need the Jira remote-link REST resource that no
ACLI command exposes. On an ACLI-only run: do the read/reconcile half natively, then either
use the documented REST fallback or hand the prepared content back to the user — and say which
half was actually completed.

## Publish a Jira release or sprint report

1. Confirm the Jira site, project, release or sprint, JQL, fields, and Confluence destination.
2. Run the JQL read-only and capture the exact count and complete result set when required.
3. Sort results deterministically, normally by Jira key.
4. Resolve the Confluence page by a stored page ID or an unambiguous title-and-parent lookup.
5. Generate only the integration-owned report section.
6. Create or update the page while preserving unrelated content and the current version.
7. Read back the page ID, version, URL, and report section.
8. Add Jira remote links to the page only when requested and only after checking existing links.
9. Report the JQL, result count, page ID, new version, and link status.

Do not call a report live when it is a static snapshot. Add a generation timestamp and declared JQL when the user wants traceability.

## Turn a Confluence specification into Jira work items

1. Read the specification, page ID, version, headings, and acceptance criteria.
2. Ask for a project, work-item type, and parent only when they cannot be discovered from the request or approved conventions.
3. Present a proposed work-item breakdown before creating a large set.
4. Search Jira for existing work items linked to the page or carrying an approved deterministic marker.
5. Create or update only the authorized work items.
6. Read back keys, summaries, statuses, and URLs.
7. Update the Confluence page with verified Jira references without replacing unrelated content.
8. Add one remote link per requested work item using the page's canonical URL.
9. Verify both sides and report partial failures.

Never derive a bulk create from ambiguous headings without a preview.

## Maintain a project status page

1. Define which sections Jira owns and which sections humans own.
2. Read the declared JQL and required fields.
3. Fetch the current page and version.
4. Update only clearly delimited Jira-owned sections.
5. Preserve human commentary, macros, restrictions, labels, and layout outside those sections.
6. Read back the page and confirm rerunning produces an update or no-op.

Prefer a live Jira view for continuously changing lists when supported. Prefer a generated snapshot when the user needs editorial control, historical evidence, or custom aggregation.

## Create or update a postmortem

1. Resolve the incident Jira work items and the intended Confluence postmortem page.
2. Check destination visibility before publishing sensitive Jira fields or comments.
3. Create or update the postmortem with verified Jira references.
4. Create Jira follow-up work items only from explicitly approved actions.
5. Link follow-up items to the postmortem and, when requested, to the incident work item.
6. Read back all keys, page version, and relationships.

Do not copy restricted comments, security fields, customer data, or attachments into a broader Confluence audience.

## Audit Jira-Confluence relationships

1. Define scope with exact Jira keys, JQL, Confluence page IDs, space, or parent.
2. Read all in-scope Jira remote links and Confluence references.
3. Normalize hostnames and compare stable Jira keys and Confluence page IDs.
4. Classify relationships as valid, missing in Jira, missing in Confluence, stale, duplicate, inaccessible, or ambiguous.
5. Produce a read-only report first.
6. Repair only the explicitly approved categories and targets.
7. Re-run the audit to verify the repaired state.

Do not treat inaccessible content as deleted, and do not remove a link solely because a temporary read failed.
