---
name: swagger-import
description: >
  Generate an API catalog (integration/*_api.json) and a suite of test cases
  (integration/suites/*.json) from a Swagger 2.0 or OpenAPI 3.x JSON document. Use for
  /import-swagger, or requests like "import this swagger doc", "generate endpoint tests from
  this OpenAPI spec". Output feeds directly into the endpoint-testing and api-integration
  skills — this skill only generates config, it never executes requests itself.
---

# Swagger Import — generate catalog + suite files from a spec

Turns a Swagger/OpenAPI document into the same catalog/suite files a user would otherwise
hand-write. Read
**`${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/references/swagger-mapping.md`** before the
first import in a session — it covers the exact field mapping, what's skipped, and how auth
scheme selection works.

## Scope

- **JSON only** — no YAML parser. Point at a local file or an `http(s)://` URL serving JSON.
  If the user only has YAML, tell them to convert it or use their spec host's JSON variant
  (e.g. `/v3/api-docs`, `/swagger.json`) — never guess at parsing YAML by hand.
- Both **Swagger 2.0** and **OpenAPI 3.x** are supported (detected from the doc itself).
- Postman collections are **not** supported by this skill (separate, not-yet-built work) —
  if asked, say so rather than attempting to reinterpret a Postman export as a Swagger doc.

## Running an import

```
node "${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/scripts/import_swagger.js" \
  <path-or-url> [--name <service>] \
  [--catalog ./integration] [--suites ./integration/suites]
```

Prints one JSON line: `{"result":"OK|BLOCKED", "catalogPath", "suitePath",
"operationsImported", "casesGenerated", "envVarsToSet", "review": [...]}` (exit 0 OK, 2
BLOCKED). **Never overwrites** an existing catalog/suite file — a BLOCKED result telling the
user to pick a different `--name` or remove/rename the existing file is expected behavior,
not a bug.

## After a successful import

1. Report `envVarsToSet` to the user verbatim — the base URL literal to put in `.env`, and
   any token/credential env var names to export in their shell (never in `.env` — same rule
   as everywhere else in this project).
2. Report every entry in `review` — these are real gaps (skipped header params, generated
   request bodies, placeholder "not found" values, unsupported auth schemes) that need human
   verification before the generated suite means anything.
3. Tell the user to open the generated files and adjust anything flagged, then try
   `/test-endpoints`.

## What this does NOT do

- Does not validate responses against the spec's schema (no contract/schema-conformance
  checking — that was explicitly scoped out; suite cases only check `status`/`fields`/
  `equals`, same as any hand-written case).
- Does not execute anything itself — running the generated suite is `endpoint-testing`'s job
  (dispatch `api-executor`, per that skill's own rules).
