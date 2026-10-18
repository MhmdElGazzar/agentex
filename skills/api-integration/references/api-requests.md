# Tool: API requests — executing `*_api.json` entries

How to execute a cataloged API request. Read before the first `api:` step in a session.

## Primary path: the runner script

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/api-integration/scripts/run_api.js" \
  --entry sample-api.get-todo --param id=1 \
  --expect-status 200 --expect-field title \
  --log "$SESSION_DIR/logs/s1-get-todo.log"
```

- Only needs Node (already required by the plugin). Recursively reads every `*_api.json` under
  `./integration/` (flat or nested, e.g. `integration/api_test_suites/<service>/`), enforces
  catalog-only execution, validates params, resolves env vars, writes the evidence log, checks
  expectations, and prints one JSON line (`PASS`/`FAIL`/`BLOCKED`; exit 0/1/2).
- Assertion flags: `--expect-status <code>`, `--expect-field <dot.path>` (exists),
  `--expect-equals <dot.path>=<value>`. Non-default catalog dir: `--catalog <dir>`.
- A `BLOCKED` result tells you exactly what's missing (entry, param, or env var) — surface it
  to the user; do not work around it.
- **Params**: a declared param whose name matches a `{name}` placeholder in `path` is
  substituted into the path; any other declared param is sent as a URL query string param
  instead (e.g. `params: ["userId"]` with a path of `/todos` and no `{userId}` placeholder
  becomes `?userId=<value>`).
- **`auth.type`**: `bearer`, `basic`, `apiKey` (custom header — e.g.
  `{"type":"apiKey","headerName":"X-Api-Key","tokenEnv":"API_TOKEN"}`), or `none`. Same
  missing-env-var → BLOCKED behavior for all three.

## Where the target comes from — the catalog's `target` field

A catalog's optional top-level `"target"` decides who owns its base URL and auth:

- **`"environment"` — the default, same as leaving the field out.** The active environment's
  `api` block (`environments/<env>.json`; `--env <name>`, omitted = the project's
  `defaultEnvironment`) supplies `baseUrl`, and its `token` is sent as `Authorization: Bearer`,
  replacing the catalog's `${API_BASE_URL}` refs and `auth` block. With no `api` block, the
  catalog's own refs and `auth` apply. Use it for **the project's own API**: one API, a
  different host per environment, switched with `--env`.
- **`"catalog"`** — the catalog's own `baseUrl` (`${ENV_VAR}` refs resolved from the process
  environment, then `.env`) and its own `auth` are used; the environment's `api` block is
  ignored for this catalog — base URL and token both. Use it for **a different service** than
  the project's API: `swagger-import` writes it into every catalog it generates. An unset ref
  is BLOCKED naming the variable — it never falls back to the environment's host. `--env` must
  still name an environment that exists.

```json
{
  "name": "petstore",
  "target": "catalog",
  "baseUrl": "${PETSTORE_BASE_URL}",
  "auth": { "type": "apiKey", "headerName": "api_key", "tokenEnv": "PETSTORE_TOKEN" },
  "requests": [ { "name": "getinventory", "method": "GET", "path": "/store/inventory", "params": [] } ]
}
```

Any other `target` value is BLOCKED (exit 2) naming the catalog, the field and the allowed
values, before any request is sent. Values for every `${…}` ref and `tokenEnv`/`userEnv`/
`passEnv` name live in the project's `.env` — the catalog holds only the names.

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
  `tokenEnv`) — the values live in the project's `.env`, so load it in the same command
  (`set -a; . ./.env; set +a; curl …`) and pass them as shell variables; **never echo their values** and never write the
  Authorization header value into the report (the raw log keeps headers you *send* out of it —
  log response status/headers/body only; if you must log the command, redact the token).
- When the project defines `environments/<env>.json` with an `api` block, its
  `baseUrl`/`token` override the catalog's env refs — unless the catalog declares
  `"target": "catalog"`, which keeps its own `baseUrl` and `auth` (see above); `--env <name>`
  selects the environment.
- URL-encode parameter values that go into the path/query (`--data-urlencode` for query params).
- `auth.type` values: `bearer` (header shown above), `basic` (`-u "$USER:$PASS"`), `apiKey`
  (`-H "<headerName>: $<tokenEnv>"`), `none`.
- Timeout every call: `--max-time 30`.
- Transient failure (timeout, 5xx on a read): retry once, then report.

## Asserting the expectation
- Status: grep the log for `HTTP_STATUS:<code>`.
- Body fields: parse with `node -e` (JSON) — e.g.
  `node -e "const r=require('fs').readFileSync(process.argv[1],'utf8').split('HTTP_STATUS:')[0]; const j=JSON.parse(r); process.exit(j.title? 0:1)" "$SESSION_DIR/logs/s4-get-todo.log"`
- Mismatch = FAIL defect; the log file is the evidence.
