# Tool: atlassian-cli (`acli`)

Atlassian command-line tool. Read this when a task needs Jira (view/search issues, build an
issue hierarchy, file a defect, manage sprints) or when `acli` is missing.
Official docs: https://developer.atlassian.com/cloud/acli/  ·  Verified against acli **1.3.x**.

## Preflight & install
- Preflight: `acli --help` (verify it's installed) and `acli jira auth status` (check auth).
- If missing, install (there is **no** winget package — download the binary directly):
  - **Windows (per https://developer.atlassian.com/cloud/acli/guides/install-windows/):**
    - x86-64: `Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_amd64/acli.exe -OutFile acli.exe`
    - ARM64:  `Invoke-WebRequest -Uri https://acli.atlassian.com/windows/latest/acli_windows_arm64/acli.exe -OutFile acli.exe`
    - Move `acli.exe` into a folder on your PATH (e.g. a personal `bin`), then open a new shell.
  - **macOS / Linux:** download the matching binary from https://developer.atlassian.com/cloud/acli/guides/ , `chmod +x acli`, move to `/usr/local/bin`.
- Verify after install: `acli --help`.  CLI versions are supported ~6 months after release — update periodically.

## Auth
- `acli jira auth login --site <your-site>.atlassian.net --web` — interactive browser login.
- API token (non-interactive) — the token is read from **STDIN**, never passed in argv:
  `echo "$JIRA_API_TOKEN" | acli jira auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token`
  - Flags: `-s/--site`, `-e/--email`, `--token` (read token from stdin), `-w/--web`.
  - Create a token at https://id.atlassian.com/manage-profile/security/api-tokens
  - Keep values in `.env` (gitignored): `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Load with
    `set -a; . ./.env; set +a`. Do NOT echo the token or place it on the command line.
- `acli jira auth status` — show the active site/account (PASS = an authenticated account is shown).
- `acli jira auth logout` — sign out · `acli jira auth switch` — switch between accounts.

## Read — projects & issues
- **Don't know the project key yet?** Start here: `acli jira project list --limit 100`
  (or `--recent`) to discover keys, then use the key in every command below.
- `acli jira project list --limit 100` — list projects. **A flag is required** — one of
  `--limit <n>` (default 30), `--recent`, or `--paginate`; bare `project list` errors out.
- `acli jira project view --key <KEY>` — one project's detail (flag is **`--key`**, not positional).
- `acli jira workitem view <ISSUE-KEY>` — show one issue (table view is the most reliable).
- `acli jira workitem search --jql "<JQL>" --limit 200` — JQL search. Useful queries:
  - `project = SCRUM ORDER BY created ASC` — everything in a project
  - `parent = SCRUM-5` — children of an epic/issue (verify a hierarchy)
  - `issuetype = Epic AND summary ~ "Login"` — find an epic by name
- **`--json` gotcha:** acli's JSON nests fields under `versionedRepresentations`, not a flat
  `fields` object, so naive `.fields.status` parsing yields `undefined`. Prefer the default
  **table output** for reliable field values; use `--json` only when you handle that shape.

## Write — issues (confirm with the user first)
- Create (prints the new key + URL, e.g. `✓ Work item SCRUM-5 created: …/browse/SCRUM-5`):
  `acli jira workitem create --project <KEY> --type <Type> --summary "…" --description "…"`
  - `--type` accepts the project's configured types (e.g. Epic, Story, Task, Feature, Bug, Subtask).
  - `-a/--assignee <email|@me|default>`, `-l/--label a,b`, `--description-file <f>`, `--json`.
- Edit: `acli jira workitem edit --key "KEY-1,KEY-2" --summary "…"` (also `-a`, `-d`, `-l`, `-y`).
- Transition: `acli jira workitem transition --key "<KEY>" --status "In Progress"` — note the
  **`--key` flag** (not a positional key); accepts a comma-separated list or `--jql`.
- Comment: `acli jira workitem comment create --key "<KEY>" --body "…"` (`comment` is a command
  group: `create` / `list` / `update` / `delete` / `visibility`; `--body-file` / `--editor` also work).
- Link: `acli jira workitem link create --out <KEY> --in <KEY> --type <Type>` — `link` is a group
  (`create` / `list` / `delete` / `type`). Link types on this site: **Blocks, Cloners, Duplicate,
  Relates** (`acli jira workitem link type` lists them). `--out` = outward issue, `--in` = inward.
- Assign: `acli jira workitem assign --key "<KEY>" --assignee <email|@me|default>`.
- Clone: `acli jira workitem clone --key "<KEY>" --to-project "<KEY>"` — **`--to-project` is
  required** (clone always targets a project; `clone --key` alone errors).
- Watchers: `acli jira workitem watcher remove --key "<KEY>" …` · `workitem list-watchers --key "<KEY>"`
  (uses **`--key`**, not positional; there is no `watcher add` — `watcher list` is deprecated).
- Attachments: `acli jira workitem attachment list --key "<KEY>"` / `attachment delete`. **acli
  cannot UPLOAD** — see "Attach evidence" below for the REST recipe (screenshots, videos, logs).
- Also available: `archive` / `unarchive` (`--key`), `delete --key "<KEY>" --yes`, `create-bulk`.

## Attach evidence to an issue (screenshots, video, logs)
acli has **no attachment-upload** command — use the REST API. The `X-Atlassian-Token: no-check`
header is **mandatory** (without it the upload is rejected/blocked as XSRF), and the form field
**must** be named `file`. Verified live (returns a JSON array with the new attachment id):
```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@path/to/evidence.png" \
  "https://$JIRA_SITE/rest/api/3/issue/<KEY>/attachments"
```
- Works for any binary — `.png`, `.webm` video, `.zip`, `.log`. Repeat `-F "file=@…"` to upload
  several in one call. Verify with `acli jira workitem attachment list --key "<KEY>"`.
- **Size limit:** Jira Cloud defaults to **10 MB per file**. Check first (`ls -l`) and zip large
  evidence sets; a long regression video can exceed the cap.

## Build a linked hierarchy (`--parent`)
Jira's hierarchy is fixed: **Epic → (Story | Task | Feature | Bug) → Subtask**. Create top-down
and pass `--parent` the key returned by the previous create:

```bash
# 1) Epic (top — no parent)
acli jira workitem create --project SCRUM --type Epic --summary "Login"          # -> SCRUM-5
# 2) Standard issues parented to the epic
acli jira workitem create --project SCRUM --type Story   --parent SCRUM-5 --summary "…"   # -> SCRUM-6
acli jira workitem create --project SCRUM --type Bug     --parent SCRUM-5 --summary "…"   # -> SCRUM-9
# 3) Subtask parented to a STANDARD issue (NOT directly to an epic)
acli jira workitem create --project SCRUM --type Subtask --parent SCRUM-9 --summary "…"   # -> SCRUM-10
```
- A **Subtask must attach to a standard issue** (Story/Task/Bug), never directly to an Epic.
- Verify links with `acli jira workitem search --jql "parent = <KEY>"`.

## Boards & sprints
Mind the flag names — they are inconsistent across these commands (verified against acli 1.3.x):
- `acli jira board search [--name <n>] [--project <KEY>] [--limit <n>]` — find a board and its **Id**.
  (`board list` is a command *group*, not a lister — use `board search`.)
- `acli jira board list-sprints --id <boardId> [--state active,closed,future]` — all sprints on a board
  (flag is **`--id`**, the board id — not `--board`, not positional).
- `acli jira board list-projects --id <boardId>` — projects mapped to a board.
- `acli jira sprint create --board <id> --name "…" [--goal "…"] [--start YYYY-MM-DD] [--end YYYY-MM-DD]`
  — creates a sprint (starts in state `future`; prints the sprint URL/id). Here the flag **is** `--board`.
- `acli jira sprint view --id <sprintId>` — sprint detail (flag is `--id`).
- `acli jira sprint list-workitems --board <id> --sprint <id>` — list a sprint's issues (both required).
- `acli jira sprint update …` — start/close or re-date a sprint · `acli jira sprint delete`.
- **Adding existing issues to a sprint:** acli has **no** `sprint add` command. Use Jira's Agile
  REST API (basic auth = email:token from `.env`; token never echoed). Standard issues only —
  subtasks inherit their parent's sprint automatically and the API rejects them:
  ```bash
  curl -s -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
    -X POST "https://${JIRA_SITE}/rest/agile/1.0/sprint/<SPRINT_ID>/issue" \
    -H "Content-Type: application/json" \
    -d '{"issues": ["SCRUM-5","SCRUM-6"]}'      # HTTP 204 = success (no body)
  ```

## Fields, filters & dashboards
- **Fields:** `acli jira field` exposes only `create` / `update` / `delete` (custom fields) —
  there is **no list/search**, so you cannot enumerate a project's fields via acli. To read the
  field catalog, use the REST API: `curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://$JIRA_SITE/rest/api/3/field"`.
- **Filters:** `acli jira filter list --my` or `--favourite` (one is **required**) ·
  `acli jira filter search --name "…"` · `filter view --id <id>` · `filter update` ·
  `filter list-columns` / `reset-columns` · `filter add-favourite` · `filter change-owner`.
- **Dashboards:** `acli jira dashboard search [--name <n>] [--owner <email>] [--limit <n>]` —
  the only dashboard subcommand (read-only).

## Jira ↔ Confluence integration (same-tenant)
When Jira and Confluence share one cloud site (same accountId on both `/rest/api/3/myself` and
`/wiki/rest/api/user/current`), they integrate natively — no legacy application links
(`/rest/applinks/...` returns 404 on cloud, which is expected):
- **Confluence page → live Jira:** embed the `jira` macro in storage-format page body —
  single issue: `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">SCRUM-9</ac:parameter></ac:structured-macro>`;
  live table: same macro with `<ac:parameter ac:name="jqlQuery">sprint = 36</ac:parameter>`.
  Embedding it makes Confluence **auto-create a remote link back on the Jira issue**.
- **Jira issue → Confluence page:** add a remote link —
  `POST /rest/api/3/issue/<KEY>/remotelink` with `{object:{url,title}}`; list via `GET` on the same path.

## Notes
- `acli` is a standalone binary — **not** an npm package; install by direct download, not `npm install`.
- Treat the API token, full email, and auth headers as sensitive — never print or log them.
  Pass the token via `JIRA_API_TOKEN` over stdin (acli) or basic-auth env interpolation (curl) only.
- Default to read-only (`view`, `search`, `list`); confirm before any create / edit / transition /
  comment / delete, or any sprint/board write.
