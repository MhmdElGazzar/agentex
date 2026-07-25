# Tool: atlassian-cli (`acli`) — Organization Admin  ⚠️ HIGH BLAST RADIUS

**Same binary as Jira/Confluence**, but a fundamentally different surface: `acli admin` manages
**real user accounts in your Atlassian organization**. Every `admin user` subcommand *changes a
person's account state* — there is **no read/list command**. Treat this as a destructive tool.

> Scope note: this reference exists only because user-management automation was explicitly
> requested. It is **opt-in and confirm-before-every-write**. A routine test run must never call
> `admin user …`. If you're here by accident, stop — use the Jira/Confluence references instead.

## Separate auth — a different credential entirely
`admin` does **not** use the Jira/Confluence API token in `.env`. It needs an **organization API
key** tied to an **org-admin email**:
- Create at **https://admin.atlassian.com → Settings → API keys** (org-admin privilege required).
- Store as its own env var, e.g. `ATLASSIAN_ADMIN_EMAIL` and `ATLASSIAN_ADMIN_API_KEY` in `.env`
  (gitignored) — **do not** reuse `JIRA_API_TOKEN`; it will not work and must not be conflated.
- Login (key over STDIN, never argv):
  ```bash
  echo "$ATLASSIAN_ADMIN_API_KEY" | acli admin auth login --email "$ATLASSIAN_ADMIN_EMAIL" --token
  acli admin auth status     # confirm the admin session
  acli admin auth logout     # end it as soon as the task is done
  ```
- If not authenticated: `✗ unauthorized: use 'acli admin auth login'` — that's BLOCKED (missing
  org API key), not a bug. Do not attempt to substitute the Jira token.

## Commands — ALL destructive (confirm each, per user)
`acli admin user` has no list/view; the four verbs each mutate managed accounts:

| Command | Effect | Reversible? |
|---|---|---|
| `acli admin user deactivate --email <a,b>` \| `--id <id>` | Suspends the account(s) | Yes — via `activate` |
| `acli admin user activate --email <a,b>` \| `--id <id>` | Re-enables a deactivated account | — |
| `acli admin user delete --email <a>` \| `--id <id>` | **Deletes a managed account** | Only within the grace window via `cancel-delete` |
| `acli admin user cancel-delete --id <id>` | Cancels a pending deletion | — |

Inputs: `--email` (comma-separated), `--id` (account IDs), or `--from-file <list>`; `--json` for output.

## MANDATORY guardrails for this reference
- **Never run `admin user delete`/`deactivate` without explicit, specific per-user confirmation.**
  State the exact accounts (emails/IDs) and the exact action, and get a "yes" for *those users*
  before executing. Approval for one action never carries to another.
- **No bulk/`--from-file` deletes** without the user reviewing the full list first.
- **`delete` is effectively irreversible** (only cancellable inside Atlassian's grace window) —
  prefer `deactivate` unless permanent removal is explicitly intended.
- Never authenticate admin speculatively; log out (`admin auth logout`) when finished.
- Same secret rules: org API key via STDIN only, kept in `.env`, never printed/logged/echoed.
- This tool is **out of scope for automated/CI test runs** — interactive, human-confirmed use only.
