---
name: confluence-acli
description: Operate Confluence Cloud safely from the terminal using Atlassian's official `acli confluence` command family, falling back to the bundled official-REST helper only for operations ACLI does not expose. Use when the user asks to list or manage spaces, read pages or blog posts, walk a page tree, extract embedded Jira keys from page bodies, or publish documentation to Confluence. Note that ACLI itself is read-only for pages (no page create/update) and has no CQL command — those go through the REST helper. Do not use for Confluence Server/Data Center, and do not substitute a third-party or community Confluence CLI.
---

# Confluence ACLI

Drive Confluence Cloud from the terminal using Atlassian's official `acli confluence` command family, without inventing commands it doesn't have.

If the requested outcome also reads or changes Jira, use the **jira-confluence-integration** skill (`${CLAUDE_PLUGIN_ROOT}/skills/jira-confluence-integration/SKILL.md`) to orchestrate both product skills instead of embedding Jira behavior here.

## Enforce the official-ACLI-first boundary

Perform every Confluence authentication, discovery, read, and mutation
through Atlassian's official `acli confluence` commands first. Atlassian's
published ACLI reference does not currently document a Confluence command
family at all — treat the installed binary's live `--help` as authoritative,
and treat its Confluence commands as version-sensitive rather than a stable
contract.

When live help does not expose the required operation, use the bundled
[REST helper](scripts/confluence_rest.ps1) against the official Confluence
Cloud REST API instead. Do not substitute a Jira MCP connector, browser
automation, or any third-party/community Confluence CLI — this skill depends
on Atlassian's own tooling only (`acli`, and the official REST API as its
documented fallback).

Inventory the installed surface before a broad capability audit:

```text
acli --version
acli --help
acli confluence --help
acli confluence auth --help
acli confluence blog --help
acli confluence page --help
acli confluence space --help
```

Inspect every discovered leaf command with `--help`. Exercise read-only commands live, but do not execute create, update, archive, restore, delete, purge, permission, or restriction commands merely to prove that they exist. See [official-confluence.md](references/official-confluence.md) for the dated v1.3.22 capability snapshot and re-discover the surface on every installed version.

## Establish the target

Identify before making a change:

- Cloud site hostname, such as `example.atlassian.net`
- Space key and, when required, numeric space ID
- Page, blog post, comment, attachment, or parent ID
- Exact requested action and content
- Whether the operation affects one item or a result set

Resolve names to IDs with a read operation. Do not guess IDs or silently switch spaces.

## Authenticate safely

Inspect the live auth interface:

```text
acli confluence auth --help
acli confluence auth status
```

If token login is supported, pass the token through standard input. Never place a literal token in command arguments, source files, generated artifacts, or chat output.

If ACLI cannot write its default configuration directory, set `ACLI_CONFIG_DIR` to a narrowly scoped writable temporary directory. Authenticate there, perform the task, log out, and remove only that exact verified temporary directory. Do not weaken filesystem permissions or copy the token into a file.

An Atlassian API token may authenticate both Jira and Confluence for the same account and site, but Jira access does not prove Confluence access. When the user has explicitly authorized reuse of existing `JIRA_SITE`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` values, map them to the Confluence login in process memory instead of duplicating the secret. Confirm access with `acli confluence auth status` and a Confluence read.

For the REST helper, have the user set these variables in their local environment:

```text
CONFLUENCE_SITE
CONFLUENCE_EMAIL
CONFLUENCE_API_TOKEN
```

Do not request that the user paste a token into chat. The helper constructs the authorization header in memory and never prints it. Confirm that Confluence is provisioned on the selected Atlassian Cloud site; valid Jira access alone does not guarantee Confluence access.

## Read before writing

Use read operations to validate:

- Active site and account
- Space key and ID
- Page or blog post ID, current status, parent, and current version
- Existing title to avoid accidental duplicates
- CQL result count or complete target list for a bulk action

Follow cursor pagination through `_links.next` or the documented `Link` header when complete results are required. State when output is sampled or limited.

## Use the REST helper

Resolve the helper path relative to this `SKILL.md`. Run it with PowerShell 7:

```text
pwsh -NoProfile -File ${CLAUDE_PLUGIN_ROOT}/skills/confluence-acli/scripts/confluence_rest.ps1 -Method GET -Path '/wiki/api/v2/spaces?limit=25'
```

On Windows PowerShell, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` when local execution policy blocks the trusted skill script.

For POST or PUT, write a UTF-8 JSON body file and pass `-BodyFile`:

```text
pwsh -NoProfile -File ${CLAUDE_PLUGIN_ROOT}/skills/confluence-acli/scripts/confluence_rest.ps1 -Method POST -Path '/wiki/api/v2/pages' -BodyFile './page.json'
```

The helper:

- Accepts only `GET`, `POST`, `PUT`, and `DELETE`
- Restricts requests to `/wiki/api/v2/` or `/wiki/rest/api/`
- Reads credentials from environment variables
- Validates JSON before a write
- Emits the response body, or a small JSON status object for an empty response
- Surfaces the HTTP status and available `Retry-After` or rate-limit reason without printing credentials

Use [official-confluence.md](references/official-confluence.md) for endpoint selection and body patterns.

## Handle pages and blog posts

For a create:

1. Resolve the numeric `spaceId`.
2. Resolve `parentId` when nesting a page.
3. Prepare the body in a file using a documented representation, normally `storage`.
4. Check for an existing page with the same intended title and parent.
5. Create, then read back the returned ID and web link.

For an update:

1. Fetch the current item with its body and version.
2. Preserve fields the user did not ask to change.
3. Increment the version exactly once in the update payload.
4. Submit the update.
5. Read back the new version and content.

Do not replace a page body when the user requested only a title or label change. Preserve macros and storage-format markup unless the user explicitly asks to rewrite them.

`acli confluence page` is read-only in the verified version (`view` only) —
page create/update goes through the REST helper (see
[official-confluence.md](references/official-confluence.md) for the exact
gap and current command inventory).

## Handle Markdown and storage format

Confluence storage bodies are XHTML, not Markdown. Convert Markdown before sending it as a storage body:

```text
pandoc README.md -f markdown -t html -o body.html
```

Prefer a body-file argument (`-BodyFile` on the REST helper) instead of shell substitution such as `--body "$(cat body.html)"`. File input avoids command-length, quoting, and UTF-8 problems. Preview complex tables, raw HTML, macros, panels, and layouts because generic Pandoc HTML is not guaranteed to be valid Confluence-specific storage markup.

For repository publishing:

1. Derive a stable title and target parent.
2. Search the target space for an existing page.
3. Resolve and persist the page ID.
4. Create only when no unambiguous match exists; otherwise update by ID.
5. Read back the body and version after publishing.

Never use title-only upserts when duplicate titles or multiple parents make the target ambiguous.

## Handle QA test-case and defect structures

Distinguish documentation structures from work items:

- Confluence pages, blog posts, tables, and Jira macros are documentation. They do not become native Test Case or Bug work items and do not gain Jira workflows, assignees, priorities, transitions, or defect lifecycle fields.
- Read a Sprint parent with `page view --include-direct-children --json` when its page ID is known. Read each child page body to resolve any embedded Jira key; do not infer the key from the title.
- When the user wants real Test Case or Bug work items, use the **jira-confluence-integration** skill and delegate creation to **jira-acli**. Keep Confluence as the test-plan, coverage, execution-report, and defect-dashboard layer.
- When the user wants Confluence-only structural placeholders, prefer child pages with stable titles such as `TC - <story-key> - <summary>` and `BUG - <story-key> - <summary>`. Do not misuse blog posts as issue cards.
- Report the workflow as unsupported by ACLI when `acli confluence page --help` lacks `create` or `update` (it does, in the verified version) — use the REST page workflow only after resolving the exact space and parent IDs and previewing the complete title-to-parent mapping.

For a structure-only request with no description, keep the page body empty only when the selected interface permits it; otherwise use the smallest valid placeholder body and disclose that requirement before writing.

## Search with CQL

Use the documented CQL search endpoint since ACLI has no CQL command:

```text
GET /wiki/rest/api/search?cql=<URL-ENCODED-CQL>&limit=25
```

Build the CQL separately, URL-encode it, then execute the request via the REST helper. Preview all CQL-selected targets before a mutation. Do not broaden a rejected query without telling the user.

## Apply mutation safeguards

- Run list, view, search, auth status, and `--help` directly.
- For a request to "test all commands," execute safe reads and authentication operations, and validate mutations through live help unless the user separately authorizes exact disposable targets.
- Execute a requested targeted create or update after validating the site and IDs.
- Require explicit authorization naming the target and action before trashing, purging, archiving, changing restrictions, or performing a bulk mutation.
- Treat purge and draft deletion as potentially permanent.
- Never turn a failed update into a create without user authorization.
- Never retry a version conflict blindly; refetch, compare, and ask when concurrent edits would be overwritten.
- On HTTP `429` or a transient `5xx` with `Retry-After`, retry only an idempotent operation, honor the server delay, apply bounded exponential backoff with jitter, and cap attempts.
- Treat an uncertain page, blog, comment, folder, or attachment create as unknown. Search or read for the intended result before retrying to avoid duplicates.
- Never use an undocumented endpoint when an official endpoint exists.

## Verify and report

After a mutation, perform a narrow read-back and report:

- Site and space
- Affected content IDs and titles
- New version or status
- Web URL when returned
- Any failures, skipped items, or partial completion

Do not claim success solely because a command was constructed or returned a zero exit code.

## Troubleshoot

1. Check the installed ACLI version, exact `--help`, and auth status.
2. Distinguish unsupported commands from authentication, licensing, permission, validation, and version-conflict failures.
3. For REST failures, capture the HTTP status and sanitized response body.
4. Recheck the `/wiki` prefix; Confluence Cloud endpoints require it.
5. On rate limiting, capture `Retry-After` and the rate-limit reason, lower concurrency, and avoid retrying an operation that is not safe to repeat.
6. Consult Atlassian's current REST documentation and the ACLI changelog.

Redact tokens, authorization headers, cookies, private page bodies, and sensitive attachments from diagnostics.
