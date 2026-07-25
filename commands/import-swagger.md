---
description: Generate an API catalog + suite of test cases from a Swagger 2.0 / OpenAPI 3.x JSON document (local file or URL).
---

Use the **swagger-import** skill to import endpoints from a spec.

Arguments: $ARGUMENTS

**Parse the arguments:**
- First token: the spec source — a local file path or an `http(s)://` URL.
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
- Report `envVarsToSet` verbatim: the base URL value to put in `.env`, and any token/
  credential env var names to export in their shell (never in `.env`).
- Report every `review` entry — these flag skipped params, generated request bodies,
  placeholder "not found" values, or unsupported auth schemes that need manual verification.
- Tell them to review the generated files, then try `/test-endpoints` once the env
  vars are set.
