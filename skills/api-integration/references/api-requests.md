# Tool: API requests — executing `*_api.json` entries

How to execute a cataloged API request. Read before the first `api:` step in a session.

## Primary path: the runner script

```bash
node "<agentex-root>/skills/api-integration/scripts/run_api.js" \
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
- **Params** — placement, in order:
  1. a `{name}` placeholder in `path` → substituted into the path;
  2. listed in the request's optional `"query": ["name", ...]` → sent in the query string
     (`swagger-import` writes this for every `in: query` param);
  3. a `{name}` placeholder in `body` → stays in the body only (never added to the URL);
  4. referenced nowhere in the request → query string (backward-compatible fallback, e.g.
     `params: ["userId"]` with a path of `/todos` and no placeholder becomes `?userId=<value>`).
  A `query` entry that isn't in `params` is BLOCKED.
- **`auth.type`**: `bearer`, `basic`, `apiKey` (custom header — e.g.
  `{"type":"apiKey","headerName":"X-Api-Key","tokenEnv":"API_TOKEN"}`), or `none`. Same
  missing-env-var → BLOCKED behavior for all three.
- **`--expect-contains <dot.path>=<text>`** passes when the field's text includes `<text>`
  (a non-string value is compared as its JSON text). It needs a JSON response, like
  `--expect-equals`.
- **`--no-auth`** sends the request with no credential at all: the environment's `api` token
  and the catalog's `auth` are both ignored, and an unset token variable is not BLOCKED. Use
  it for "401 without a token" checks.
- **`--omit <param>`** (repeatable) sends the request without that declared param: a query
  param is left out of the URL; a typed body node's key (or array element) is removed. A path
  param (`cannot omit "<p>": it is a path parameter`), an undeclared name, or a param used
  inside a legacy `"{p}"` body string (`cannot omit "<p>": it is used inside a body string
  template`) is BLOCKED.
- PASS and FAIL results carry `ms` (the request's duration). Every credential value the runner
  sends (token, API key, basic password) is replaced by `[redacted]` in the evidence log and
  in the printed JSON, even when the API echoes it back.

## Typed body nodes — `$param`

Anywhere in a request's `body`, `{"$param": "<name>", "type": "string|integer|number|boolean|json"}`
takes the value of the declared param `<name>`, converted to that type (`json` parses the text
as JSON). A value that does not convert is BLOCKED: `param "<n>" = "<v>" is not a valid <type>`.
A param used this way is body-only: it never falls back to the query string. Omitting it
(`--omit`) removes the key holding the node. Legacy `"{name}"` string templates work as
before.

```json
{ "name": "create-order", "method": "POST", "path": "/orders", "params": ["qty", "item"],
  "body": { "qty": { "$param": "qty", "type": "integer" }, "item": { "$param": "item", "type": "json" } } }
```

## A captured token — `auth.tokenStore`

`auth.tokenStore` (a suite slug, with `bearer` or `apiKey` auth only — any other type is
BLOCKED, `reasonCode: "bad-auth-field"`) lets a catalog use a token the suite wizard captured
from the application's UI. Resolution:
1. The catalog's `tokenEnv` set in the environment or `.env` → used; it always wins.
2. Otherwise `test/.auth/api-tokens/<tokenStore>-<env>.json` for the resolved environment
   (`--env`, else `defaultEnvironment`). No environment → BLOCKED (`… uses a captured token,
   which needs an environment — pass --env or set defaultEnvironment`).
3. The file is missing → BLOCKED, `reasonCode: "token-missing"`.
4. Past its `expiresAt` (or the JWT `exp`, decoded locally) → BLOCKED,
   `reasonCode: "token-expired"`, never a 401 FAIL.

The token file is gitignored, mode 0600, and the only place the value is kept. To capture it
again, ask the agent in chat.

## Where the target comes from — the catalog's `target` field

A catalog's optional top-level `"target"` decides who owns its base URL and auth. The active
environment's `api` block (`environments/<env>.json`; `--env <name>`, omitted = the project's
`defaultEnvironment`) is **the project's own API**: when it applies, it supplies `baseUrl`, and
its `token` is sent as `Authorization: Bearer`, replacing the catalog's refs and `auth` block.

- **`"catalog"`** — the catalog's own `baseUrl` (`${ENV_VAR}` refs resolved from the process
  environment, then `.env`) and its own `auth` are used; the environment's `api` block is
  ignored for this catalog — base URL and token both. Use it for **a different service** than
  the project's API: `swagger-import` writes it into every catalog it generates.
- **`"environment"`** — the environment's `api` block applies, whatever the catalog's `baseUrl`
  says. Use it on a hand-written catalog whose `baseUrl` uses another variable (e.g.
  `${ORDERS_BASE_URL}`) but should still switch host with `--env`.
- **No `target`** — the environment's `api` block applies only when the catalog's `baseUrl` is
  absent/empty or exactly `"${API_BASE_URL}"` (the project default — one API, a different host
  per environment, switched with `--env`). A catalog declaring any other `baseUrl` — another
  variable such as `"${PETSTORE_BASE_URL}"`, or a literal URL — keeps its own `baseUrl` and its
  own `auth`, and the environment token is never sent to it.

When the rule picks the environment but the environment has no `api` block, the catalog's own
refs and `auth` are used (legacy fallback). In every case an unset `${…}` ref the catalog itself needs is BLOCKED naming
the variable — it never falls back to the environment's host — and `--env` must name an
environment that exists (an unknown name is BLOCKED, listing the ones that do).

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
  `tokenEnv`). Use only variables that are **already set in the shell** (the user's own, or CI's).
  Never read, `cat` or source `.env`: the runner reads it for you, and that is the path to fix.
  Check that a variable is set without printing it (`[ -n "$API_TOKEN" ]`); if any needed variable
  (token or base URL) is empty, make no request: stop with BLOCKED naming it and say the runner failed. **Never echo their values** and never write the
  Authorization header value into the report (the raw log keeps headers you *send* out of it —
  log response status/headers/body only; if you must log the command, redact the token).
- **Which target a catalog uses** follows "Where the target comes from" above (`--env <name>`
  selects the environment): when the environment's `api` block applies to the catalog, use its
  `baseUrl` and token in place of the catalog's refs and `auth`; otherwise use the catalog's own
  `baseUrl` and `auth` — the environment token is never sent to a catalog that owns its target.
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
