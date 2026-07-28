# Identity and Authentication

Treat Jira and Confluence access as separate authenticated capabilities, even when both products use the same Atlassian Cloud hostname.

## Verify the environment

For each product:

1. Check the installed CLI version.
2. Inspect the exact command's live `--help`.
3. Check authentication or profile status.
4. Record the active site hostname and account identity without exposing secrets.
5. Run a narrow read to confirm access to the intended Jira project or Confluence space.

Confirm that a shared-site workflow points to the same normalized hostname. If the user intentionally integrates different sites, state both sites and require explicit target selection before writing.

Do not infer identity or permission equivalence from matching email addresses, browser sessions, Jira access, or Confluence access.

## Keep authentication surfaces separate

- Let the **jira-acli** skill determine Jira ACLI authentication and account/site selection.
- Let the **confluence-acli** skill determine Confluence ACLI or REST-fallback authentication.
- Do not copy a token from one profile, configuration file, environment, command, or log into another.
- Never ask the user to paste a token into chat.
- Prefer interactive OAuth where the official CLI supports it.
- For approved local REST scripts, read secrets from the documented environment variables and construct authorization headers only in memory.

For long-lived integrations, prefer OAuth 2.0 authorization code grants or an Atlassian app with minimal scopes. Use API-token basic authentication only for personal or ad-hoc scripts when appropriate.

Official references:

- [Jira Cloud REST API v3 introduction and authentication](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
- [Jira Cloud basic authentication for REST APIs](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)

## Check permissions before mutation

Verify the permissions required by the exact operation:

- Jira project browse and work-item edit permissions
- Jira issue linking enabled plus Browse Projects and Link Issues permissions when remote backlinks are requested
- Jira issue-level security access when the source work item is restricted
- Confluence space access and page create or edit permission
- Confluence page restrictions that may narrow readership
- Permission to view every Jira field selected for publication

Use least privilege. Do not publish Jira fields to a Confluence page whose audience is broader than the source data's intended audience. When visibility cannot be compared reliably, stop and ask the user to confirm the destination audience.

## Handle site or account mismatch

Stop before mutation when:

- The active Jira or Confluence site differs from the requested site.
- The authenticated account cannot read the intended source.
- Jira and Confluence are unexpectedly on different sites.
- Multiple CLI profiles match and none was selected.
- A browser OAuth session and terminal profile refer to different accounts.

Report the mismatch with sanitized site and account information. Let the user complete login or choose a profile locally, then repeat all read-only preflight checks.
