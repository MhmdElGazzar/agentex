# Jira ACLI Skill

Operate Jira Cloud safely through Atlassian's official `acli jira` command family.

## Use the skill

Ask for what you need in plain language — the skill triggers on the intent, not a specific invocation phrase:

- "Find my assigned open Jira work items."
- "Inspect TEAM-123 and show its available transitions."
- "List Stories in each active sprint without changing Jira."
- "Preview one test structure per Story, but do not create it."
- "Preview a bulk label update, but do not apply it."

## Capabilities

- Diagnose ACLI installation, authentication, accounts, and Jira sites.
- Discover projects, boards, sprints, work-item types, and transition IDs.
- Search with JQL and return human-readable, JSON, or CSV output.
- Read Story descriptions and acceptance criteria for fixed or dynamic planning.
- View, create, edit, assign, clone, transition, archive, or delete work items.
- Create guarded single or bulk work-item structures from generated templates.
- Manage comments, Jira work-item links, attachments, and watchers.
- Verify counts, fields, relationships, and omitted descriptions after changes.

## Verified capability and limitation report

This snapshot was verified on July 25, 2026 with ACLI `1.3.22-stable` against
the team-managed Jira Cloud project `SCRUM` ("QA Testing"). Reconfirm every
version-specific behavior with the installed binary's live `--help`.

### Observed scenario

- The project contained 17 Stories.
- Ten Stories were assigned across three non-empty sprints.
- Seven detailed Dynamic Request Stories were not assigned to the similarly
  named future sprint, which was empty.
- The project exposed Epic, Subtask, Task, Story, Feature, Request, and Bug.
- The project did not expose a native Test Case work-item type.
- Seventeen Task-based test placeholders and sixteen Bug placeholders existed.
- All 33 structures had empty descriptions and no sprint assignment.

### What ACLI can handle

| Requirement | ACLI capability |
|---|---|
| Discover Stories project-wide | Use JQL with `workitem search` |
| Discover Stories by sprint | Use `board search`, `board list-sprints`, and `sprint list-workitems` |
| Read Story logic | Use `workitem view --json` with selected fields |
| Create one or many structures | Use `workitem create` or `create-bulk` |
| Keep descriptions empty | Omit the description property and verify null |
| Create native Bugs | Use the project's Bug type |
| Make a test structure a Story child | Use Subtask with the Story ID as `parentIssueId` |
| Relate a top-level Bug to a Story | Use `workitem link create` with a verified link type |
| Prevent duplicate bulk creation | Search stable role and source labels first |
| Verify results | Read back exact keys or narrow JQL results |

### What ACLI cannot directly or safely guarantee

- ACLI cannot create a native Test Case when the Jira project does not expose
  that work-item type. A Task or Subtask is only an explicitly declared
  placeholder.
- ACLI does not design test coverage by itself. An agent can analyze Story
  descriptions and acceptance criteria, but fixed and dynamic generation must
  be treated as different scopes.
- In the verified ACLI version, the sprint command tree had no add-workitems
  or move-to-sprint command, and work-item create/edit exposed no sprint flag.
  Do not promise sprint placement from these commands.
- The single-create template exposed generic `additionalAttributes`, but this
  did not verify an undocumented Sprint custom-field payload. Do not guess one
  in a live project.
- Only a Subtask can use `parentIssueId`. A top-level Task or Bug cannot be
  presented as a child of a Story.
- A generated structure cannot compensate for missing Story detail. A Story
  without acceptance criteria supports only a placeholder or a clarification
  request, not reliable dynamic coverage.
- A failed post-delete lookup can mean either "not found" or "no permission."
  Deletion is verified only by correlating the pre-delete view, successful
  delete JSON, and failed post-delete view.

The skill must stop and report an ACLI limitation. It must not switch to Jira
MCP, direct REST, `curl`, browser automation, or another Jira CLI.

## Best practice for Story-derived QA structures

1. Decide whether scope means all project Stories or only Stories in named
   sprints.
2. List the boards, sprints, and exact Story keys before generating anything.
3. Read Story descriptions and acceptance criteria.
4. Decide between a fixed count and dynamic, branch-driven coverage.
5. Inspect the project's actual work-item types.
6. Prefer Subtask for a test placeholder that must belong to a Story.
7. Keep Bug as the native Bug type and link it to the Story with `Relates`.
8. Use deterministic labels such as `test-case-structure`,
   `bug-structure`, and `source-team-123`.
9. Generate single-create and bulk-create JSON templates separately.
10. Preview counts and validate input before applying any bulk operation.
11. Omit `description` entirely when an empty structure is required.
12. Read back every generated group and verify type, source, relationship,
    description, and sprint membership.

Pre-created Bug placeholders can distort defect metrics. Prefer creating Bugs
only for observed defects. When placeholders are explicitly required, label
and exclude them from real defect reporting.

## Requirements

- Jira Cloud. Jira Server and Data Center are outside this skill's scope.
- Atlassian ACLI must be installed for live terminal operations.
- The intended Jira account and site must be authenticated.
- Live `acli jira ... --help` output is authoritative when it differs from
  remembered syntax or examples.

The skill never needs a password or token pasted into a prompt. Prefer the
interactive web login supported by ACLI.

## Safety model

The workflow reads before it writes, targets stable work-item keys or IDs, and
verifies every mutation. Destructive, broad, or filter-driven actions require
an exact target preview and explicit authorization. Secrets and sensitive
fields must not be echoed into logs or reports.

## Files

- [SKILL.md](SKILL.md) - complete routing, command, safety, and verification
  instructions.
- [Official ACLI reference](references/official-acli.md) - sourced command and
  installed-version guidance.

## Boundaries

This skill handles Jira-only workflows through official `acli jira` commands.
For a workflow that also reads or changes Confluence, use
[`jira-confluence-integration`](../jira-confluence-integration/README.md).
A Jira work-item link connects Jira items; it is not a Confluence backlink.
