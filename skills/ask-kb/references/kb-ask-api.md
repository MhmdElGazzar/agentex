# KB Ask API — reference (v1)

`POST {BASE_URL}/api/kb/ask` · `Content-Type: application/json` · not streaming · stateless ·
latency a few seconds, one AI call (use client timeout ≥120s).

## Auth

`x-api-key: {KB_ASK_API_KEY}` — required when the server has the key configured (else `401`).
One shared secret per calling app; no PAT/cookie/login. The runner sends it automatically from
`KB_ASK_API_KEY` in `.env` and never logs it. Leave the key blank only for an unauthenticated
dev server.

## Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | the natural-language question |
| `project` | string | yes | project id (see list) |
| `org` | string | no | org slug, default `tameeni` |
| `model` | string | no | `sonnet` (API default) / `opus` / `haiku` |

Valid `project` values: `dwi`, `travel-insurance`, `mmp`, `tameeniportal`, `health-sme`,
`leasing`, `marine`, `health-individual`, `civil-liability`, `home-insurance`,
`Tameeni SME Motor`, `VAS`. A project answers only if its KB exists on disk (else 404).

## Success — 200

    { "success": true, "answer": "## …markdown…", "sources": ["mod-x"],
      "hasContext": true, "isNoAnswer": false, "cached": false }

- `hasContext === false` → KB had nothing relevant; treat as low-confidence / not covered.
- `isNoAnswer === true` → model said the info isn't documented; treat as not covered.
- `cached === true` → served from the API's cache (with `cachedAt` ISO timestamp); no freshness
  guarantee within a session.
- Off-topic questions short-circuit instantly with `hasContext:false` and don't call the AI.

## Errors

| Status | When | Body |
|---|---|---|
| 400 | invalid JSON, missing question/project, or server has no ANTHROPIC_API_KEY | `{ "error": "…" }` |
| 401 | missing/wrong `x-api-key` | `{ "error": "Unauthorized" }` |
| 404 | unknown project / no KB on disk | `{ "error": "Unknown or empty project" }` |
| 429 | server busy (`Retry-After` header) or upstream AI rate limit | `{ "error": "Server busy, retry shortly" }` |
| 500 | unexpected server error | `{ "error": "<message>" }` |

Retry policy: `429` honors the `Retry-After` header (seconds; default 2s) grown exponentially;
`5xx` and network/timeout errors use exponential backoff. `400`/`401`/`404` are never retried.

## Curl fallback (if Node is unavailable)

    curl -X POST "$KB_ASK_BASE_URL/api/kb/ask" \
      -H "Content-Type: application/json" \
      -H "x-api-key: $KB_ASK_API_KEY" \
      -d '{"project":"travel-insurance","question":"How is the premium calculated?"}'

Then apply the same result handling: `hasContext=false` or `isNoAnswer=true` ⇒ not covered.
