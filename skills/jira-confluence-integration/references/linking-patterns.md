# Jira-Confluence Linking Patterns

Use stable object identity and verify both ends of every requested relationship.

## Choose the relationship

### Link a Confluence page from Jira

Prefer a Jira remote issue link when ACLI or the Jira Cloud REST API supports it.

Do not confuse Jira work-item links with remote links. `acli jira workitem link` connects two Jira work items; a Confluence backlink uses the Jira Cloud remote-link REST resource unless the installed CLI explicitly exposes an equivalent command.

> **ACLI cannot do this half (verified live on 1.3.22).** `acli jira workitem link` exposes only
> `create`, `delete`, `list`, `type` — all Jira↔Jira — and `workitem view --fields remotelinks`
> returns `null`. Every step below therefore needs the REST resource, not ACLI. If the run is
> ACLI-only, stop here and report the Jira→Confluence direction as **not created**; do not
> substitute a `workitem link` (it links work items, not pages) and do not describe the result
> as bidirectional.

1. Resolve the Jira work-item key and Confluence page ID.
2. Read the page and obtain its canonical web URL and title.
3. List the work item's existing remote links.
4. Match by deterministic global ID when available; otherwise match by normalized canonical URL.
5. Create, update, or skip the remote link.
6. Read the remote link back and verify its URL.

The Jira Cloud REST API v3 remote-link resource is:

```text
/rest/api/3/issue/{issueIdOrKey}/remotelink
```

Official reference: [Jira Cloud issue remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/)

Confirm that Jira issue linking is enabled and that the acting account has Browse Projects and Link Issues permissions, plus access through any issue-level security.

Use a deterministic global ID whose components identify the system, site, and immutable page ID. For example:

```text
system=confluence&site=<site-host>&pageId=<page-id>
```

Treat the global ID as an opaque integration key after choosing it. URL-encode it when used as a query parameter. Do not include titles because titles can change.

The remote-link POST operation is an upsert when `globalId` is present, but omitted fields are cleared. Read the current link and send the complete intended representation when updating; do not submit a partial payload.

### Link Jira work items from Confluence

Choose the simplest representation that meets the request:

- Use a Smart Link for one or a few work items when a visible, resilient link is sufficient.
- Use Jira work-item content or a JQL-backed view when the user needs a live list or count and the Jira-Confluence connection is configured.
- Use a static generated table when the user explicitly wants a point-in-time report.

Official guidance:

- [Display Jira work items in Confluence](https://support.atlassian.com/confluence-cloud/docs/insert-the-jira-issues-macro/)
- [Use Jira and Confluence together](https://support.atlassian.com/confluence-cloud/docs/use-jira-and-confluence-together/)

Do not invent storage-format macro XML. When updating an existing page programmatically, fetch and preserve a verified existing macro representation or use a supported editor, CLI, or API representation. If a live macro cannot be created safely, use canonical Jira links and report the limitation.

### Build a bidirectional relationship

Use both patterns:

1. Put the verified Jira link, Smart Link, or supported Jira view on the Confluence page.
2. Put a remote link to the canonical Confluence page on each requested Jira work item.
3. Read both objects back.
4. Verify the work-item keys, page ID, site hostname, and URLs.

Bidirectional linking is not a distributed transaction. Record partial completion and resume only the missing side.

## Maintain a mapping

Prefer relationships discoverable from Jira remote links and Confluence content. When a repeatable workflow needs an external mapping, use a user-approved configuration or repository file with non-secret data:

```json
{
  "schemaVersion": 1,
  "jiraSite": "example.atlassian.net",
  "confluenceSite": "example.atlassian.net",
  "relationships": [
    {
      "jiraKey": "PROJ-123",
      "confluencePageId": "987654321",
      "relationship": "specification"
    }
  ]
}
```

Validate that mapped objects still exist before using the mapping. Never store access tokens, cookies, authorization headers, page bodies, Jira descriptions, or user credentials in it.

## Avoid duplicates

Before creating a relationship:

- Normalize the site hostname.
- Compare immutable page IDs and Jira keys.
- Compare the chosen remote-link global ID.
- Treat multiple matches as a conflict.
- Update a single unambiguous existing relationship.
- Never create a second object merely because the title or summary changed.
