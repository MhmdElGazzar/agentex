# Jira-Confluence Integration Skill

A thin orchestration skill for safe, repeatable workflows that span Jira Cloud
and Confluence Cloud. It coordinates the two product skills without
duplicating their command guidance.

## Use the skill

Ask for what you need when the outcome genuinely crosses both products:

- "Publish a Jira release report to Confluence and add verified backlinks to
  the related work items."
- "Create Jira work items from this Confluence specification and link both
  sides."
- "Update a status page from a fixed JQL query without creating duplicates."
- "Audit broken or missing Jira-to-Confluence relationships."

## Capabilities

- Publish Jira sprint, release, or status data to Confluence.
- Turn Confluence specifications or postmortems into linked Jira work items.
- Maintain verified bidirectional relationships between work items and pages.
- Synchronize integration-owned page regions while preserving unrelated
  content.
- Audit links, detect conflicts and duplicates, and resume after partial
  failures.

## How it works

The integration skill delegates product-specific work to:

- [`jira-acli`](../jira-acli/README.md) for Jira discovery, JQL, work-item
  changes, and Jira-side verification.
- [`confluence-acli`](../confluence-acli/README.md) for Confluence command
  routing, content versions, REST fallback, and Confluence-side verification.

It identifies stable Jira keys or IDs and Confluence page IDs, verifies the
active identity and site in each product, builds a read-only execution plan,
then applies changes in dependency order. Repeatable workflows update or skip
existing objects rather than silently creating duplicates.

## Requirements

- Jira Cloud and Confluence Cloud.
- Both sibling skills (`jira-acli`, `confluence-acli`) installed alongside
  this skill.
- Authenticated access to the intended Jira and Confluence sites.
- Permission to read every source field and destination page involved.

Jira and Confluence authentication are checked independently; access to one
product does not prove access to the other.

## Safety model

The workflow protects page versions, preserves stable identifiers, checks
destination visibility before moving data, and verifies both sides after every
mutation. It does not silently broaden JQL, switch spaces, overwrite concurrent
edits, roll back successful stages, or retry uncertain mutations without first
reading the remote state.

Deletes, permission changes, restriction changes, broad updates, and
destructive compensation require explicit authorization.

## Files

- [SKILL.md](SKILL.md) — orchestration workflow and cross-product safeguards.
- [Identity and authentication](references/identity-and-auth.md) — multi-site
  and credential-boundary guidance.
- [Linking patterns](references/linking-patterns.md) — stable relationship and
  backlink patterns.
- [Workflow recipes](references/workflow-recipes.md) — release report,
  specification, status page, and postmortem recipes.

## Boundaries

Use this skill only for cross-product workflows. Use `jira-acli` for
Jira-only requests and `confluence-acli` for Confluence-only requests. Jira
or Confluence Server/Data Center deployments are outside this skill's scope.
