---
description: Generate an API catalog + suite of test cases from a Swagger 2.0 / OpenAPI 3.x JSON document (local file or URL). --wizard opens the guided page that collects real test data first.
---

Use the **swagger-import** skill to import endpoints from a spec.

Arguments: $ARGUMENTS

**Wizard form — `--wizard [source] [--lang=ar|en]`:** open the "New suite from Swagger"
page instead of importing directly. Follow
`${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/references/suite-wizard.md` (launch the studio,
stay attached through its channel, collect test data in step 3). A given source is only
pre-filled on the page. Everything below is the direct import and is unchanged.

**Parse the arguments:**
- First token: the spec source.
  - A local file path or an `http(s)://` URL — pass straight through to the script below.
  - Anything else (a search phrase, or an `owner/api/version` reference) — treat it as a
    SwaggerHub lookup via the **Swagger MCP connector**: `swagger_search_apis_and_domains`
    (or `swagger_list_organizations` first, if the owner is ambiguous) to find the API, then
    `swagger_get_api_definition(owner, api, version, resolved: true)` to fetch its JSON. Write
    the result to `.agentex/scratch/swagger/<api>.json` (agent scratch, see
    `${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`) and use that path as the source below.
- Optional `--name <service>`: slug for the generated files and env-var prefix. If omitted,
  derive it from the spec's `info.title`.
- If no source is given, ask the user for one rather than guessing.

**Run the import:**
```
node "${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/scripts/import_swagger.js" <source> [--name <name>]
```
- A `BLOCKED` result (non-JSON content, unrecognized spec, target file already exists, no
  operations found) is expected behavior in some cases — report the reason verbatim, don't
  work around it. If it's the "file already exists" case, suggest a different `--name`.

**On success:**
- Tell the user exactly which files were written (`catalogPath`, `suitePath`) and how many
  operations/cases were generated.
- Report `envVarsToSet` (and `envVarsNote`) verbatim: every listed name goes in the project's
  `.env` — secrets (tokens, user/pass) live there, never in the catalog/suite files, never
  printed back; `run_api.js` resolves catalog `${VAR}` names from the environment, then `.env`.
  The base URL is not a secret and may instead be written as a literal `baseUrl` in the catalog.
- The catalog carries `"target": "catalog"`, so it calls the imported service at its own base
  URL with its own auth even when the active environment has an `api` block.
- Report every `review` entry — these flag skipped params, generated request bodies,
  placeholder "not found" values, or unsupported auth schemes that need manual verification.
  The same notes are written into the generated files (`review: [...]` per request/case).
- Tell them every generated write-method case (POST/PUT/PATCH/DELETE) carries a `skip` line
  and is reported BLOCKED, not run, until it is enabled — one case at a time, after that case
  is reviewed, or through the editor's per-case Skip toggle. Decline a bulk strip of the
  `skip` lines and offer to walk through the write cases one by one.
- Tell them to review the generated files, then try `/test-endpoints` once the env
  vars are set.
