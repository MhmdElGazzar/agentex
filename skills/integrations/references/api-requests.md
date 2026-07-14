# Tool: API requests (curl) — executing `*_api.json` entries

How to execute a cataloged API request. Read before the first `api:` step in a session.

## Preflight & install
- Preflight: `curl --version`.
- Usually preinstalled (Windows 10+, macOS, most Linux; also ships with Git Bash). If missing:
  - **Windows:** `winget install -e --id cURL.cURL` (or use the Git Bash bundled curl)
  - **macOS:** `brew install curl`
  - **Linux (Debian/Ubuntu):** `sudo apt-get install -y curl`

## Catalog entry → command

Given an `integrations/<service>_api.json`:

```json
{
  "name": "sample-api",
  "baseUrl": "${API_BASE_URL}",
  "auth": { "type": "bearer", "tokenEnv": "API_TOKEN" },
  "requests": [
    { "name": "get-todo", "method": "GET", "path": "/todos/{id}", "params": ["id"] },
    { "name": "create-todo", "method": "POST", "path": "/todos", "params": ["title"],
      "body": { "title": "{title}", "completed": false } }
  ]
}
```

Build the command (Bash tool):

```bash
# GET — always capture status + headers + body into the evidence log
curl -sS -w "\nHTTP_STATUS:%{http_code}\n" \
  -H "Authorization: Bearer $API_TOKEN" \
  "$API_BASE_URL/todos/1" > "$SESSION_DIR/logs/s4-get-todo.log" 2>&1

# POST with a JSON body (substituted into declared placeholders only)
curl -sS -w "\nHTTP_STATUS:%{http_code}\n" \
  -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"title":"qa-test-item","completed":false}' \
  "$API_BASE_URL/todos" > "$SESSION_DIR/logs/s5-create-todo.log" 2>&1
```

Rules:
- Resolve `baseUrl` / auth from the env-var **names** in the file (`${API_BASE_URL}`,
  `tokenEnv`) — pass them as shell variables; **never echo their values** and never write the
  Authorization header value into the report (the raw log keeps headers you *send* out of it —
  log response status/headers/body only; if you must log the command, redact the token).
- URL-encode parameter values that go into the path/query (`--data-urlencode` for query params).
- `auth.type` values: `bearer` (header shown above), `basic` (`-u "$USER:$PASS"`), `none`.
- Timeout every call: `--max-time 30`.
- Transient failure (timeout, 5xx on a read): retry once, then report.

## Asserting the expectation
- Status: grep the log for `HTTP_STATUS:<code>`.
- Body fields: parse with `node -e` (JSON) — e.g.
  `node -e "const r=require('fs').readFileSync(process.argv[1],'utf8').split('HTTP_STATUS:')[0]; const j=JSON.parse(r); process.exit(j.title? 0:1)" "$SESSION_DIR/logs/s4-get-todo.log"`
- Mismatch = FAIL defect; the log file is the evidence.
