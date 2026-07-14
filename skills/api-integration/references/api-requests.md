# Tool: API requests — executing `*_api.json` entries

How to execute a cataloged API request. Read before the first `api:` step in a session.

## Primary path: the runner script

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/api-integration/scripts/run_api.js" \
  --entry sample-api.get-todo --param id=1 \
  --expect-status 200 --expect-field title \
  --log "$SESSION_DIR/logs/s1-get-todo.log"
```

- Only needs Node (already required by the plugin). Reads `./integration/*_api.json`, enforces
  catalog-only execution, validates params, resolves env vars, writes the evidence log, checks
  expectations, and prints one JSON line (`PASS`/`FAIL`/`BLOCKED`; exit 0/1/2).
- Assertion flags: `--expect-status <code>`, `--expect-field <dot.path>` (exists),
  `--expect-equals <dot.path>=<value>`. Non-default catalog dir: `--catalog <dir>`.
- A `BLOCKED` result tells you exactly what's missing (entry, param, or env var) — surface it
  to the user; do not work around it.

## Fallback: manual curl (only if node/the runner fails)

Preflight: `curl --version` (usually preinstalled; Windows: `winget install -e --id cURL.cURL`,
macOS: `brew install curl`, Debian/Ubuntu: `sudo apt-get install -y curl`).

Given an `integration/<service>_api.json`:

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
