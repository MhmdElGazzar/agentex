# Official Confluence CLI and REST reference

Read this file when selecting a command, endpoint, request body, or troubleshooting path. Verify the installed ACLI surface with `--help` and the current REST contract with Atlassian's documentation.

## Contents

- Official sources
- ACLI discovery
- REST endpoint map
- Page payload patterns
- CQL patterns
- Content rules

## Official sources

- ACLI command root: <https://developer.atlassian.com/cloud/acli/reference/commands/>
- ACLI installation: <https://developer.atlassian.com/cloud/acli/guides/install-acli/>
- ACLI changelog: <https://developer.atlassian.com/cloud/acli/changelog/>
- Confluence Cloud REST API v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/intro/>
- Spaces: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/>
- Pages: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/>
- Blog posts: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-blog-post/>
- Folders: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-folder/>
- Attachments: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/>
- CQL search: <https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/>
- CQL language: <https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/>
- REST authentication: <https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/>
- Confluence Cloud changelog: <https://developer.atlassian.com/cloud/confluence/changelog/>
- Rate limiting: <https://developer.atlassian.com/cloud/confluence/rate-limiting/>

## ACLI discovery

The published ACLI command root currently does not list Confluence. Some installed ACLI versions may expose an undocumented `confluence` family. Discover it instead of assuming:

```text
acli --version
acli --help
acli confluence --help
acli confluence auth --help
acli confluence space --help
acli confluence page --help
acli confluence blog --help
```

If a family or action is absent, use the official REST API. Never translate Jira flags directly to Confluence commands.

Potential version-dependent families include `auth`, `space`, `page`, and `blog`. Confirm every action and flag with live help before execution.

### Live v1.3.22 snapshot

This snapshot was verified against `acli version 1.3.22-stable` on 2026-07-25. It is evidence for that binary, not a substitute for live help on another installation.

| Family | Discovered commands | Capability |
| --- | --- | --- |
| `auth` | `login`, `logout`, `status`, `switch` | API-token or web login and local account selection |
| `space` | `archive`, `create`, `list`, `restore`, `update`, `view` | Read and mutate spaces; list filters by key, type, and status |
| `page` | `view` | Read a known page ID, body, version, and direct children |
| `blog` | `create`, `list`, `view` | Create and read blog posts; no update or delete command |

Important gaps in this version:

- No page list, search, create, update, archive, restore, or delete command.
- No CQL command.
- No attachment, label, comment, restriction, permission, folder, analytics, export, or bulk command family.
- No native Confluence Test Case or Bug entity.
- `space archive`, `restore`, and `update` target a space key, while `space view` targets a numeric ID.
- `blog create --from-file` accepts plain text or HTML, but `--body` is documented as Confluence storage-format XHTML.

For a strict official-ACLI request, stop at these gaps and use the REST helper instead. Do not silently switch to an MCP tool or browser automation.

For a complete audit:

1. Run `--help` on all four command families.
2. Run `--help` on every discovered leaf command.
3. Exercise authentication and read-only commands against a verified site.
4. Inspect mutation commands through help unless exact disposable targets are explicitly authorized.
5. Record the binary version and date with the result.

### QA workflow result

The v1.3.22 page reader can enumerate user-story child pages when the Sprint parent ID is known:

```text
acli confluence page view --id <sprint-page-id> --include-direct-children --json
```

Read each child page with `--body-format storage` to resolve embedded Jira macros and keys. The command can inventory coverage, but it cannot create one Test Case page and one Bug page per story because page creation is absent. `blog create` is technically writable but is not an appropriate substitute for typed Jira work items or hierarchical QA pages.

When real Jira Test Case and Bug cards are required, route through the Jira-Confluence integration skill. When documentation-only child pages are acceptable, the REST v2 page endpoint fills the page-creation gap.

### Discovering pages without a search command (verified 2026-07-26)

There is no `page list` and no CQL command, so page discovery has exactly one ACLI entry
point: the space homepage, then walk down. Confirmed live on a real tenant:

```text
# 1. resolve the space id (space view takes --id, NOT --key)
acli confluence space list --json

# 2. the space object exposes homepageId — this is the tree root
acli confluence space view --id <spaceId> --include-all --json

# 3. walk down one level at a time
acli confluence page view --id <homepageId> --include-direct-children --json
acli confluence page view --id <childId> --include-direct-children --json

# 4. read a leaf page's content
acli confluence page view --id <pageId> --body-format storage --include-labels --json
```

Notes confirmed on this run:

- **`space view` takes `--id` (numeric), not `--key`.** Its `--help` lists only `--id`.
  (`space archive`/`restore`/`update` do take a key — the asymmetry is real.)
- `homepageId` is only present on the space object when you can read it; there is no other
  documented way to find the tree root through ACLI.
- `--include-direct-children` returns one level; recurse manually for a deeper tree.
- **Jira macros in the storage body use `key`-only form**, e.g.
  `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">SCRUM-26</ac:parameter></ac:structured-macro>`
  — no `server`/`serverId` parameters on a same-tenant Cloud site. Live JQL tables use
  `<ac:parameter ac:name="jqlQuery">parent = SCRUM-26 ORDER BY key ASC</ac:parameter>`.
  Parse the tracker key out of the storage body rather than inferring it from the page title.
- A read-only coverage audit (walk the tree → parse each page's macros → cross-check the keys
  against the tracker) is fully ACLI-native and needs no fallback. Publishing the audit *back*
  to Confluence does not — `page` has no `create`/`update`.

## REST endpoint map

Use `https://<site>.atlassian.net` plus one of these paths:

| Task | Method and path |
| --- | --- |
| List spaces | `GET /wiki/api/v2/spaces?limit=25` |
| Resolve spaces by key | `GET /wiki/api/v2/spaces?keys=KEY` |
| Get a space | `GET /wiki/api/v2/spaces/{spaceId}` |
| Create a space | `POST /wiki/api/v2/spaces` |
| List pages | `GET /wiki/api/v2/pages?limit=25` |
| List pages in a space | `GET /wiki/api/v2/spaces/{spaceId}/pages?limit=25` |
| Get a page | `GET /wiki/api/v2/pages/{pageId}?body-format=storage` |
| Create a page | `POST /wiki/api/v2/pages` |
| Update a page | `PUT /wiki/api/v2/pages/{pageId}` |
| Trash a page | `DELETE /wiki/api/v2/pages/{pageId}` |
| List blog posts | `GET /wiki/api/v2/blogposts?limit=25` |
| List blog posts in a space | `GET /wiki/api/v2/spaces/{spaceId}/blogposts?limit=25` |
| Get a blog post | `GET /wiki/api/v2/blogposts/{id}?body-format=storage` |
| Create a blog post | `POST /wiki/api/v2/blogposts` |
| Update a blog post | `PUT /wiki/api/v2/blogposts/{id}` |
| Trash a blog post | `DELETE /wiki/api/v2/blogposts/{id}` |
| Get a folder | `GET /wiki/api/v2/folders/{id}` |
| Create a folder | `POST /wiki/api/v2/folders` |
| Trash a folder | `DELETE /wiki/api/v2/folders/{id}` |
| Search with CQL | `GET /wiki/rest/api/search?cql={encodedCql}&limit=25` |

Check the endpoint page for permissions, query parameters, representations, and current response codes before writing.

## Page payload patterns

Create a published page:

```json
{
  "spaceId": "123456",
  "status": "current",
  "title": "Release notes",
  "parentId": "234567",
  "body": {
    "representation": "storage",
    "value": "<p>Release details.</p>"
  }
}
```

Omit `parentId` only when a root-level page is intended.

Update a page after fetching its current version:

```json
{
  "id": "345678",
  "status": "current",
  "title": "Release notes",
  "body": {
    "representation": "storage",
    "value": "<p>Updated release details.</p>"
  },
  "version": {
    "number": 8,
    "message": "Update release details"
  }
}
```

Set `version.number` to the current version plus one. Refetch after a conflict; never increment repeatedly without reconciling concurrent changes.

Create a blog post:

```json
{
  "spaceId": "123456",
  "status": "current",
  "title": "Weekly update",
  "body": {
    "representation": "storage",
    "value": "<p>This week's progress.</p>"
  }
}
```

Confirm the current API schema before using optional fields or draft/private behavior.

## CQL patterns

Examples:

```text
space = "DEV" AND type = page
space = "DEV" AND title ~ "\"release notes\""
ancestor = 123456 AND type = page
type IN (page, blogpost) AND lastmodified > now("-7d")
```

URL-encode the complete CQL expression. Follow `_links.next` when present. When expanding body representations, honor documented result limits rather than assuming the requested limit was returned.

## Content rules

- Confluence Cloud REST paths begin with `/wiki`.
- Space keys and numeric space IDs are not interchangeable.
- Page and blog update bodies require the current version to be incremented.
- Storage representation is Confluence XHTML, not Markdown.
- Page "assignment" usually means restrictions or task mentions; pages have no Jira-style assignee field.
- Deleting current content moves it to trash; purging trashed content and discarding drafts can be permanent.
- REST permissions mirror the authenticated user's Confluence permissions.
- Use API tokens, not Atlassian account passwords, for basic-auth scripts.
- On HTTP `429`, honor `Retry-After` and the rate-limit reason. Retry with bounded exponential backoff and jitter only when the operation is idempotent and safe to repeat.
- Treat a transient response after a create as an unknown outcome; resolve the intended object before attempting another create.
