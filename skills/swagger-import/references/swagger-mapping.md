# Tool: Swagger/OpenAPI import — `import_swagger.js`

How a Swagger 2.0 / OpenAPI 3.x document maps onto the catalog (`<name>_api.json`) and suite
(`<name>_suite.json`) formats that `api-integration`/`endpoint-testing` already know how to
run. Both are written co-located under `integration/api_test_suites/<name>/`. Read before the
first `/import-swagger` invocation in a session.

## Input constraints

- **JSON only.** No YAML parser — this plugin has zero npm dependencies today and adding one
  for YAML isn't justified by this feature alone. If your doc is YAML, convert it first (most
  live Swagger UIs also serve a JSON variant — `/v2/api-docs`, `/v3/api-docs`, a `swagger.json`
  link, or Swagger Editor's export). A local file path or an `http(s)://` URL both work.
- **SwaggerHub-hosted specs** go through the **Swagger MCP connector**
  (`swagger_search_apis_and_domains` / `swagger_get_api_definition`) rather than a file/URL —
  the connector only fetches the spec JSON, it doesn't generate catalog/suite files. The
  fetched definition is staged to a temp file before `import_swagger.js` ever sees it, so as
  far as the importer is concerned it's just another local file (see the relative
  `servers[].url` note below for the one consequence of that).
- **Format detection**: `"swagger": "2.0"` or `"openapi": "3.x"` at the document root. Anything
  else is BLOCKED.
- **URL sources**: a spec URL answering a non-2xx status is BLOCKED with that status (the
  error page is never parsed as a spec).

## Everything generated is a best-effort skeleton

The importer never invents business-meaningful test data — param example values, generated
request bodies, and "not found" placeholder values are all flagged for review. Each flag is
written **into the generated file** as a `review: [...]` array on the request (catalog) or case
(suite) it concerns, and is also echoed in the command's `review` output. **Review the
generated files before trusting suite results.**

**Write operations are opt-in.** Every generated POST/PUT/PATCH/DELETE case is written with
`"skip": "review: write operation — remove this line to enable"`. `run_suite.js` never
executes a case carrying `skip` — it reports it BLOCKED with the reason quoted. A write case
is enabled one at a time: its `skip` line is removed only after the user has reviewed that
case (what it creates or changes, the values it sends, the environment), or by the user
through the editor's per-case Skip toggle (`/test-endpoints --edit`). A request to strip the
`skip` lines in bulk is declined, with an offer to walk through the write cases one by one.
`review` notes themselves don't block anything, so a generated case with review notes runs
as-is only if it is a GET.

## `$ref` resolution

Reusable schemas (`components.schemas` / OpenAPI 2.0 `definitions`) referenced via internal
`$ref` pointers (`"$ref": "#/components/schemas/Pet"`) are resolved before being read — request
bodies, response schemas (for `expect.fields`), and param schemas all deref first. Nested
`$ref`s (an object property that itself points at another schema, e.g. `Pet.category` →
`Category`) resolve recursively, and a chain of `$ref`s pointing at each other resolves to the
final concrete schema. Without this, every property behind a `$ref` — which in practice means
almost every non-trivial field in a real-world spec — degraded to the generic `'example'`
placeholder instead of a real value, and top-level request bodies degraded to the bare string
`"example"` instead of an object.

Boundaries, both flagged in `review` rather than guessed:
- **External refs** (anything not starting with `#/`, e.g. a separate file or URL) are left
  unresolved.
- **Circular `$ref` chains** resolve to `{}` rather than recursing forever.

## Field mapping

| Spec concept | OpenAPI 3.x | Swagger 2.0 | Catalog / suite field |
|---|---|---|---|
| Base URL | `servers[0].url` | `schemes[0]://host+basePath` | `baseUrl: "${<PREFIX>_BASE_URL}"` (placeholder, never the literal) |
| Target | — (always written) | — (always written) | `target: "catalog"` — the catalog's own `baseUrl` + `auth` are used; the active environment's `api` block never redirects an imported service |
| Auth | `components.securitySchemes` | `securityDefinitions` | `auth` (one scheme per catalog file — see below) |
| Path/method | `paths.<path>.<method>` | same | `requests[].path` / `.method` (path template syntax already matches — `{id}` copied as-is) |
| Path/query params | `parameters[].in: path\|query` | same | `requests[].params` (names only); `in: query` names also go in `requests[].query`, so the runner sends them in the query string |
| Request body | `requestBody.content['application/json'].schema` | body parameter's `.schema` | `requests[].body` (generated example — flagged for review) |
| 2xx response schema | `responses.<code>.content['application/json'].schema` | `responses.<code>.schema` | suite case `expect.fields` (schema's `required[]` properties only — see below) |
| 4xx response | any documented 4xx code | same | a second suite case, `expect.status` = that code |

## Auth scheme selection

The catalog format supports **one auth shape per file** — but a spec can declare several
security schemes. The importer picks by preference, **regardless of declaration order**:
`bearer` → `apiKey` (header only, and only when it declares a header `name` — one without is
flagged in `review` and skipped) → `basic`. If the spec declared more than one, the others are noted in
`review` — the catalog format has no per-request auth override, so multi-scheme APIs need a
manual second catalog file if you actually need both.

Unsupported schemes (`oauth2`, `openIdConnect`, `apiKey` with `in: query`) are **not**
auto-wired — the generated `auth` is left as `{"type":"none"}` and flagged in `review` rather
than silently guessing something wrong.

Generated env var names are prefixed with the service name in UPPER_SNAKE — the `--name`
value, or the spec's `info.title` when `--name` is omitted (`Pet Store` →
`PET_STORE_BASE_URL`, `PET_STORE_TOKEN`, …). The bare `API_` prefix is never used (a service
named `api` gets `API_SERVICE_`): it would collide with the project's own `API_BASE_URL` /
`API_TOKEN`. Every generated catalog also declares `"target": "catalog"`, so the active
environment's `api` block never redirects it (see `api-integration`'s `api-requests.md`).
Where the values go — the house rule from `docs/configuration.md`: **every value — the base URL
and any credential alike — goes in the project's `.env`**, never in the catalog/suite files and
never printed: the catalog holds only the names, and `envVarsToSet` lists them with
`<set in .env>` for credentials. `run_api.js` resolves the catalog's `${VAR}` names from the
process environment first, then `.env`. The `<NAME>_BASE_URL` value is not a secret: put it in
`.env` too, or replace the catalog's `baseUrl` with the literal URL. The importer itself never
writes `.env`.

## Request names

Request names come from `operationId` (slugged), else `<method>-<path>`. Two operations that
produce the same name are de-duplicated with a `-2`, `-3`, … suffix and flagged in that
request's `review` — rename them to something meaningful.

## Param example values

- An `example`/`default` on the param's schema is used first.
- Any value **not** taken from the spec's `example`/`default` (enum first value, type-based
  placeholder) is flagged in the happy-path case's `review` as inferred.
- An **enum** picks its first listed value (e.g. a `status` param with
  `enum: [available, pending, sold]` gets `"available"`) — far more likely to be accepted
  than a generic placeholder.
- **Array-typed params** get a single representative value (from `items`' example/default/
  enum, or a type-based placeholder) — not full OpenAPI array-serialization
  (`style`/`explode`: repeated keys vs. comma-joined). Always flagged in `review`, since a
  1-element value only coincidentally matches the common default (`style: form, explode:
  true`) case.
- **Format-aware string placeholders**: `format: date-time` / `format: date` get a real
  ISO-8601 value (`2024-01-01T00:00:00Z` / `2024-01-01`) instead of the literal `'example'`,
  since a strict server-side deserializer rejects a non-date string in a date field. Any other
  `format` (or none) still falls back to `'example'`.
- **Request-body arrays and objects are built recursively**, not flattened to a scalar the way
  param values are (a param's array collapses to one representative element; a JSON body's
  array/object must stay a real array/object or a strict server rejects the whole payload as a
  type mismatch).
- **Relative `servers[].url`** (e.g. `"/api/v3"`, common in real specs) is resolved against
  the spec's own host when the source was a URL; when the source is a local file, there's no
  origin to resolve against, so it's flagged in `review` instead of guessed. A SwaggerHub-
  fetched spec counts as a local file here (it's staged to a temp file before the importer
  runs) — SwaggerHub's own registry host isn't the API's real origin anyway, so this is the
  correct outcome, not a regression, but it does mean these specs always need a manual base
  URL check when `servers[].url` is relative.

## Response `expect.fields` — required properties only

A happy-path case only asserts fields listed in the response schema's own `required[]` — never
every documented property. A real server routinely omits optional/null fields, so asserting on
all of them would fail a perfectly correct response. If the schema declares no `required[]` (or
none of it maps to a known property), no `fields` assertion is generated at all — safer than
guessing "all of them" when nothing is actually guaranteed present.

## What's skipped, not guessed

- **Header/cookie params** (`in: header`, `in: cookie`) — the catalog format has no mechanism
  for custom per-request headers beyond auth. Skipped, and noted in `review`.
- **Non-JSON response/request bodies** (e.g. XML, form-encoded) — only JSON
  (`application/json`, `application/*+json`) is read. A request body offered only in another
  content type is dropped and flagged in that request's `review`; response schemas in other
  types are ignored.
- **No documented 2xx response** — the happy-path case still gets `expect.status: 200`, flagged
  in its `review` as a guess.
- **Array-typed 2xx responses** — `expect.fields` isn't generated for these (no top-level
  object properties to check); only `expect.status` is set.

## The wizard's generator (`/import-swagger --wizard`) vs this import

The direct import above keeps its own case set (one happy-path case, plus an error case when a
4xx is documented). The suite wizard shares the same spec model (`swagger_model.js`) but
generates the four basic checks, from the values collected in its step 3:

| Kind | When | Expect |
|---|---|---|
| `happy` | every selected operation | the first documented 2xx (else 200, flagged) + the response schema's `required[]` fields |
| `not-found` | an operation with a path param (the last one gets an Auto non-existent ID: `999999999`, a nil-style UUID, or `agentex-does-not-exist`) | 404, plus `equals` on the message when the spec documents a 404 example |
| `no-token` | an operation whose `security` (operation-level, else global) is non-empty | 401, case `auth: "none"` |
| `missing-field` | the first required query param, else the first required top-level body field | 400 with that param in `omit`, plus `contains` on the message when the spec documents a 400 example |

- **Messages come only from the spec's own examples**: OpenAPI 3 `content.<json>.example` /
  `examples.*.value` / schema `example`, or Swagger 2 `examples["application/json"]`. The
  message field is the first string among `message`, `error.message`, `detail`, `title`,
  `error`. Without an example the case checks the status only and carries a review note. An
  observed response is never copied in as the expectation.
- **Params are the operation's needs only**: path params, required query params, and required
  top-level body fields. A body field becomes a typed `{"$param": …}` node, so it is editable
  like any other value.
- **`sources`** records where each value came from (`ui`, `project`, `manual`, or `auto` for
  the not-found ID). A value nobody found or typed is `placeholder`: the case shows as "needs
  review" (unless it is skipped: a skipped case counts under Skipped only) and is BLOCKED at
  run time until it gets a real value.
- **Write operations** arrive with the same `skip` line. In step 2, a DELETE, an operation with
  `x-destructive: true`, or one whose summary / operationId uses a destructive verb (delete,
  remove, destroy, purge, erase, wipe, drop, truncate, terminate, revoke, reset, cancel) starts
  unselected.
- **Auth**: the catalog gets `auth.tokenStore: "<suite>"` when its auth is bearer or apiKey (or
  when a token was captured from the UI), so a captured token is used when `tokenEnv` is unset.
  A public operation (`security: []`) in a token catalog gets `auth: "none"` on its cases.

## Never overwrite

If the target catalog or suite file already exists
(`integration/api_test_suites/<name>/<name>_api.json` or
`.../<name>/<name>_suite.json`), the importer refuses rather than overwriting or picking an
alternate filename — a second file could otherwise declare the same internal catalog `name`,
which `run_api.js`'s recursive search-and-match-by-name lookup would then BLOCK as ambiguous
(it refuses to pick one when two catalogs share a `name`). Pick a different `--name`, or remove/rename the existing file first.
