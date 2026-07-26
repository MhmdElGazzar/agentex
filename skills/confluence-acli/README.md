# Confluence ACLI Skill and Capability Report

This skill operates Confluence Cloud through a verified command surface. It
uses Atlassian's official `acli confluence` commands when available, and
falls back to the official Confluence Cloud REST API only when ACLI doesn't
expose the required operation.

## Professional audit task

**Objective:** Verify the complete installed Confluence ACLI surface, exercise
safe commands against the real Confluence site, assess whether the Test
Case-and-Bug workflow can be completed, and update the skill from observed
behavior.

**Audit date:** 2026-07-25
**Installed binary:** `acli version 1.3.22-stable`
**Site:** a live Atlassian Cloud tenant
**Safety constraint:** No Confluence content, space, permission, or attachment
was created, updated, archived, restored, or deleted.

The audit inspected `--help` for all 14 discovered leaf commands. Safe
authentication and read commands were executed live. Mutation commands were
validated through help only because no disposable target was authorized.

## Command coverage

| Family | Commands inspected | Commands executed safely | Result |
| --- | ---: | ---: | --- |
| Authentication | 4 | 4 | Login, status, switch, and logout passed |
| Spaces | 6 | 2 | List and view passed; four mutations not executed |
| Pages | 1 | 1 | View by ID, body, version, and children passed |
| Blogs | 3 | 1 | List passed with zero results; create/view not executed |
| **Total** | **14** | **8** | Full help inventory completed |

Discovered command tree:

```text
acli confluence auth <login|logout|status|switch>
acli confluence space <archive|create|list|restore|update|view>
acli confluence page view
acli confluence blog <create|list|view>
```

The installed binary does not expose page creation or update, CQL search,
attachments, comments, labels, restrictions, folders, analytics, export, or
bulk commands. Atlassian's published ACLI reference also does not currently
document this installed Confluence family, so live help is authoritative.

Official evidence:

- [Atlassian ACLI command reference](https://developer.atlassian.com/cloud/acli/reference/commands/)
- [Atlassian ACLI changelog](https://developer.atlassian.com/cloud/acli/changelog/)
- [Confluence REST v2 page operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)

## Real QA scenario

The live read found a project space (identified by its space key and
numeric ID) and a Sprint page with seven direct user-story child pages, each
representing one Story from the linked Jira project.

Requested output would require 14 structures: one Test Case and one Bug for
each story. The audit created zero and changed zero.

### Feasibility decision

| Required outcome | Official ACLI v1.3.22 |
| --- | --- |
| Discover the seven stories from a known Sprint page ID | Supported |
| Read each story and embedded Jira key | Supported |
| Create one Confluence Test Case child page per story | Unsupported (ACLI); use the REST fallback |
| Create one Confluence Bug child page per story | Unsupported (ACLI); use the REST fallback |
| Create native Jira Test Case or Bug work items | Not a Confluence capability |
| Create blog posts as placeholders | Technically supported, not recommended |

Confluence pages are documentation, not Jira work items. They do not provide a
Bug or Test Case issue type, workflow, assignee, priority, transition, or defect
lifecycle. Blog posts should not be used as issue-card substitutes.

## Best-practice implementation

Use Jira as the source of truth for real Test Case and Bug cards:

1. Read the Sprint and story scope with the Jira ACLI skill.
2. Create and link one Test Case and one Bug structure per story with the
   Jira ACLI skill.
3. Use Confluence for the test plan, coverage matrix, execution report, and
   defect dashboard.
4. Embed Jira keys or JQL macros in the corresponding Confluence story pages.
5. Coordinate both products through the `jira-confluence-integration` skill.

If the user explicitly wants documentation-only Confluence placeholders,
create child pages titled `TC - <story-key> - <summary>` and
`BUG - <story-key> - <summary>`. The official ACLI cannot perform that page
creation in v1.3.22 — use the bundled REST helper for the page-creation gap.

## Skill improvements applied

- Added an explicit official-ACLI-first boundary with a documented REST
  fallback for what ACLI doesn't expose (no MCP, browser, or third-party CLI
  fallback).
- Added complete command-tree discovery and safe audit rules.
- Added temporary `ACLI_CONFIG_DIR` handling for restricted environments.
- Added safe in-memory reuse guidance for an explicitly authorized Atlassian
  token.
- Added Test Case and Bug workflow guidance and the documentation-versus-work
  item distinction.
- Added a dated v1.3.22 command and limitation matrix to the official
  reference.

## Use the skill

Ask for what you need in plain language:

- "In strict ACLI-only mode, inspect a Sprint page and report whether one
  Test Case and one Bug structure can be created per story."
- "Create documentation-only QA child pages, allowing the official REST
  fallback when ACLI does not expose page creation."

## Files

- [SKILL.md](SKILL.md) - routing, workflows, safety, and verification.
- [Official Confluence reference](references/official-confluence.md) - live
  ACLI snapshot and official REST guidance.
- [REST helper](scripts/confluence_rest.ps1) - guarded official API wrapper.
