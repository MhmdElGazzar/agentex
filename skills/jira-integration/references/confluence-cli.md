# Tool: atlassian-cli (`acli`) — Confluence

**Same binary as Jira.** `acli confluence …` is a command group of the *same* Atlassian CLI
documented in `atlassian-cli.md` — nothing extra to install. Read this when a task needs
Confluence (spaces, pages, blog posts). Verified against acli **1.3.x**.

## Prerequisite: a Confluence license on the site
Confluence auth is **separate from Jira** and requires Confluence to be provisioned on the site
for the account. If the site has Jira only (common on the free Atlassian Cloud tier), Confluence
auth fails even with a valid Jira token — this is a licensing gap, **not** a CLI/command error:
- `acli confluence auth login …` → `✗ Error: authentication failed`
- `curl .../wiki/rest/api/space` → `HTTP 401` + an HTML login page

To enable: add the Confluence product to the Atlassian Cloud site (admin.atlassian.com), then
authenticate. Do not treat this as a bug to work around — surface it as BLOCKED (prerequisite).

## Auth (once Confluence is licensed)
Separate login from Jira, but the **same** site + email + API token (token over STDIN, never argv):
```bash
echo "$JIRA_API_TOKEN" | acli confluence auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token
acli confluence auth status     # PASS = authenticated account/site shown
acli confluence auth logout     # sign out
```

## Read — spaces, pages, blogs
- **Pick a target space FIRST (mandatory before any page/blog write).** List spaces, then resolve
  the chosen key to the numeric id the REST page/blog calls need:
  ```bash
  acli confluence space list                                   # discover space keys
  curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    "https://$JIRA_SITE/wiki/rest/api/space/<KEY>" | \
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log("id:",s.id,"home:",s.homepageId||"?")})'
  ```
- `acli confluence space list [--type personal|global] [--keys A,B] [--expand description,homepage] [--json]`
  — list spaces.
- `acli confluence space view --id <spaceId> [--include-all] [--labels] [--json]` — one space's detail.
- `acli confluence page view --id <pageId> [--body-format storage|atlas_doc_format|view] [--json]`
  — one page (the `page` group is **read-only** in acli — only `view`).
- `acli confluence blog list` · `acli confluence blog view --id <id>` — blog posts.

## Write — spaces & blogs (confirm with the user first)
- `acli confluence space create --key <KEY> --name "…" [--description "…"] [--alias <slug>]`
- `acli confluence space update --key <KEY> …` · `space archive --key <KEY>` / `space restore --key <KEY>`
- **No `space delete` in acli** (archive only). To hard-delete, `DELETE /wiki/rest/api/space/<KEY>`
  — returns **HTTP 202** (async long-running task; the space disappears shortly after).
- Blog: `acli confluence blog create --space-id <numericId> --title "…" --body "<p>…</p>"` — note
  **`--space-id`** (the space's numeric id from `GET /space/<KEY>`), *not* `--space`/`--space-key`.
  Also `--status draft`, `--private`, `--from-file`, `--from-json`. `blog list` / `blog view --id`.
- **Pages have no create/update/delete in acli** (only `page view --id`). Author/edit page content
  via the Confluence REST API (`/wiki/rest/api`). See the operations below.

## Page operations via REST (`/wiki/rest/api`) — confirm before writing
acli's `page` group is view-only; do all page authoring through REST. Base path is
**`/wiki/rest/api/...`** (note the `/wiki` prefix), basic auth = email:token.

| Operation | Call |
|---|---|
| Get space numeric id / homepage | `GET /space/<KEY>` |
| List pages in a space | `GET /content?spaceKey=<KEY>&type=page&limit=25&expand=version` |
| Create a page | `POST /content` with `{type:"page",title,space:{key},body:{storage:{value:"<html>",representation:"storage"}}}` |
| **Nest under a parent** (hierarchy) | add `ancestors:[{id:"<parentId>"}]` to the create/update body |
| **Embed a live Jira issue/JQL** | put a `jira` macro in the storage body: `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">SCRUM-9</ac:parameter></ac:structured-macro>` (or `ac:name="jqlQuery"` for a table). Auto-creates a backlink on the Jira issue. |
| Update a page | `PUT /content/<id>` with a **bumped** `version:{number:N+1}` + new `body` (fetch current version first) |
| Delete (to trash) | `DELETE /content/<id>` |
| View content (rendered/storage) | `GET /content/<id>?expand=body.storage,version,ancestors` |
| List child pages | `GET /content/<id>/child/page?limit=25` |
| Labels | `POST /content/<id>/label` with `[{prefix:"global",name:"qa"}]` · `GET`/`DELETE` same path |
| Comment (footer) | `POST /content` with `{type:"comment",container:{id,type:"page"},body:{storage:{…}}}` |
| **Page restrictions** (Confluence's "assign / permission to people") | `PUT /content/<id>/restriction` with `[{operation:"update",restrictions:{user:[{type:"known",accountId:"<id>"}]}}]` · `DELETE` to clear |
| Current user accountId (for restrictions/mentions) | `GET /wiki/rest/api/user/current` |

Body format is **storage** (Confluence XHTML); Confluence macros are `<ac:structured-macro ac:name="info|status|…">…</ac:structured-macro>`.

### ⚠️ Windows UTF-8 gotcha (verified)
Passing page HTML with non-ASCII chars (em-dash `—`, emoji, curly quotes) through
`bash → -d '…'` on Windows corrupts the bytes → Confluence rejects it with
`JsonParseException: Invalid UTF-8 start byte 0x97`. **Fix:** build the JSON and POST it from a
single **Node script** using `Buffer.from(JSON.stringify(payload),"utf8")` and node's `https`
(don't hand the content to curl `-d`, and don't rely on `/tmp` — node on Windows resolves it to
`C:\tmp`). ASCII-only bodies are fine either way.

### Runnable page-create (UTF-8-safe, copy-paste)
Write the storage-format HTML to a file, then run this — it encapsulates the Node HTTPS +
UTF-8 pattern so you don't reinvent it each time. Args: `<SPACE_KEY> <TITLE> <BODY_FILE> [PARENT_ID]`.
Reads `JIRA_SITE`/`JIRA_EMAIL`/`JIRA_API_TOKEN` from the env (load `.env` first).
```bash
node -e '
const https=require("https"),fs=require("fs");
const [key,title,bodyFile,parent]=process.argv.slice(1);
const site=process.env.JIRA_SITE, auth="Basic "+Buffer.from(process.env.JIRA_EMAIL+":"+process.env.JIRA_API_TOKEN).toString("base64");
const o={type:"page",title,space:{key},body:{storage:{value:fs.readFileSync(bodyFile,"utf8"),representation:"storage"}}};
if(parent) o.ancestors=[{id:parent}];
const data=Buffer.from(JSON.stringify(o),"utf8");
const r=https.request({host:site,path:"/wiki/rest/api/content",method:"POST",headers:{Authorization:auth,"Content-Type":"application/json","Content-Length":data.length}},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>{const j=JSON.parse(b);console.log(x.statusCode===200?("OK "+j.id+" :: "+j.title):("ERR "+x.statusCode+" "+(j.message||b).slice(0,160)));});});
r.write(data); r.end();
' "SD" "My Report" "./body.html" "720898"
```
Update a page the same way with `method:"PUT"`, path `/wiki/rest/api/content/<id>`, and a bumped
`version:{number:N+1}` (fetch the current version first).

## Notes
- **Windows paths with spaces / cwd persistence:** the working directory is not guaranteed to
  persist between Bash tool calls, and a repo path containing a space (e.g. `agentex-main (1)`)
  breaks a bare `cd` — commands fail with "No such file or directory." Re-issue `cd` with the
  **absolute, quoted** path on every call that needs it (this is separate from the UTF-8 gotcha above).
- Confluence REST base path is `/wiki/rest/api/...` (note the `/wiki` prefix), unlike Jira's `/rest/api/...`.
- "Assign a page to a team/person" in Confluence = **page restrictions** (view/update permissions),
  not a Jira-style single assignee. There is no per-page "assignee" field.
- Same secret rules as Jira: token from `.env` (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_API_TOKEN`), over
  stdin (acli) or basic-auth env interpolation (curl/node) — never echoed or placed in argv.
- Default to read-only (`list`, `view`); confirm before any create / update / archive / delete /
  restrict.
