# Tool: Swagger/OpenAPI import — `import_swagger.js`

How a Swagger 2.0 / OpenAPI 3.x document maps onto the catalog (`integration/*_api.json`) and
suite (`integration/suites/*.json`) formats that `api-integration`/`endpoint-testing` already
know how to run. Read before the first `/import-swagger` invocation in a session.

## Input constraints

- **JSON only.** No YAML parser — this plugin has zero npm dependencies today and adding one
  for YAML isn't justified by this feature alone. If your doc is YAML, convert it first (most
  live Swagger UIs also serve a JSON variant — `/v2/api-docs`, `/v3/api-docs`, a `swagger.json`
  link, or Swagger Editor's export). A local file path or an `http(s)://` URL both work.
- **Format detection**: `"swagger": "2.0"` or `"openapi": "3.x"` at the document root. Anything
  else is BLOCKED.

## Everything generated is a best-effort skeleton

The importer never invents business-meaningful test data — param example values, generated
request bodies, and "not found" placeholder values are all flagged in the command's `review`
list. **Review the generated files before trusting suite results.**

## Field mapping

| Spec concept | OpenAPI 3.x | Swagger 2.0 | Catalog / suite field |
|---|---|---|---|
| Base URL | `servers[0].url` | `schemes[0]://host+basePath` | `baseUrl: "${<PREFIX>_BASE_URL}"` (placeholder, never the literal) |
| Auth | `components.securitySchemes` | `securityDefinitions` | `auth` (one scheme per catalog file — see below) |
| Path/method | `paths.<path>.<method>` | same | `requests[].path` / `.method` (path template syntax already matches — `{id}` copied as-is) |
| Path/query params | `parameters[].in: path\|query` | same | `requests[].params` (names only) |
| Request body | `requestBody.content['application/json'].schema` | body parameter's `.schema` | `requests[].body` (generated example — flagged for review) |
| 2xx response schema | `responses.<code>.content['application/json'].schema` | `responses.<code>.schema` | suite case `expect.fields` (top-level property names only) |
| 4xx response | any documented 4xx code | same | a second suite case, `expect.status` = that code |

## Auth scheme selection

The catalog format supports **one auth shape per file** — but a spec can declare several
security schemes. The importer picks the first it recognizes, in this order: `bearer` →
`apiKey` (header only) → `basic`. If the spec declared more than one, the others are noted in
`review` — the catalog format has no per-request auth override, so multi-scheme APIs need a
manual second catalog file if you actually need both.

Unsupported schemes (`oauth2`, `openIdConnect`, `apiKey` with `in: query`) are **not**
auto-wired — the generated `auth` is left as `{"type":"none"}` and flagged in `review` rather
than silently guessing something wrong.

Generated env var names default to `API_BASE_URL`/`API_TOKEN` (matching the project's
existing single-service convention) unless `--name` is passed, in which case they're
namespaced (`<NAME>_BASE_URL`, `<NAME>_TOKEN`, etc.) to avoid collisions across multiple
imported services. Token/credential env vars are never written to `.env` — same shell-export
rule as everywhere else in this project (see the root `.env.example`).

## Param example values

- An `example`/`default` on the param's schema is used first.
- An **enum** picks its first listed value (e.g. a `status` param with
  `enum: [available, pending, sold]` gets `"available"`) — far more likely to be accepted
  than a generic placeholder.
- **Array-typed params** get a single representative value (from `items`' example/default/
  enum, or a type-based placeholder) — not full OpenAPI array-serialization
  (`style`/`explode`: repeated keys vs. comma-joined). Always flagged in `review`, since a
  1-element value only coincidentally matches the common default (`style: form, explode:
  true`) case.
- **Relative `servers[].url`** (e.g. `"/api/v3"`, common in real specs) is resolved against
  the spec's own host when the source was a URL; when the source is a local file, there's no
  origin to resolve against, so it's flagged in `review` instead of guessed.

## What's skipped, not guessed

- **Header/cookie params** (`in: header`, `in: cookie`) — the catalog format has no mechanism
  for custom per-request headers beyond auth. Skipped, and noted in `review`.
- **Non-JSON response/request bodies** (e.g. XML, form-encoded) — only `application/json` is
  read; other content types are ignored for that operation's body/response schema.
- **Array-typed 2xx responses** — `expect.fields` isn't generated for these (no top-level
  object properties to check); only `expect.status` is set.

## Never overwrite

If the target catalog or suite file already exists (`integration/<name>_api.json` or
`integration/suites/<name>_suite.json`), the importer refuses rather than overwriting or
picking an alternate filename — a second file could otherwise declare the same internal
catalog `name`, which `run_api.js`'s glob-and-match-by-name lookup resolves ambiguously (first
match wins). Pick a different `--name`, or remove/rename the existing file first.
