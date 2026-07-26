---
name: ask-kb
description: >
  Ask a project's knowledge base a natural-language question during a test run, via the
  KB Ask API, and read the answer as advisory context. Triggers on spec steps starting with
  "kb:", or requests like "ask the KB", "what does the knowledge base say", "how does <flow>
  work". Explicit only — the agent never calls the KB on its own initiative. Answers inform
  testing/navigation but are NEVER used as PASS/FAIL evidence.
---

# Ask KB — knowledge-base lookup

Answers a natural-language question from a project's KB. The bundled runner is the ONLY thing
that makes the call (deterministic, enforces timeout/retry/mapping in code):

    node ${CLAUDE_PLUGIN_ROOT}/skills/ask-kb/scripts/ask_kb.js \
      --question "<text>" [--project <id>] [--org <slug>] [--model opus|sonnet|haiku] \
      --log <SESSION_DIR>/logs/<scenario>-kb.log

It resolves config, performs the request, writes the evidence log, and prints ONE JSON line:
`{"result":"OK|NOT_COVERED|BLOCKED", ...}` (exit 0 OK/NOT_COVERED, 2 BLOCKED).

## Step syntax in test specs

    kb: <question>              # uses the default project from agentex.config.json
    kb:<project>: <question>    # inline project override

Examples:

    kb: How does the checkout payment flow work?
    kb:acme-store: How is the order total calculated?

## Configuration (consumer project)

`.env` holds the connection, default project, and the API key:

| `.env` key | Example | Notes |
|---|---|---|
| `KB_ASK_BASE_URL` | `http://localhost:3000` | endpoint host (host only) |
| `KB_PROJECT` | `acme-store` | default project id; `kb:<project>:` overrides per step |
| `KB_ORG` | `acme` | org slug sent with each request; `--org` overrides. Blank ⇒ config `kb.org` ⇒ generic default |
| `KB_ASK_API_KEY` | `<secret>` | shared secret; sent as the `x-api-key` header. Required when the server has it set (else `401`). Leave blank only for an unauthenticated dev server. Never logged/printed. |

`agentex.config.json` → `kb` block tunes the rest (missing key = documented default):

| Key | Default | Notes |
|---|---|---|
| `org` | `acme` | API default |
| `model` | `opus` | `opus` / `sonnet` / `haiku` (the API's own default is `sonnet`) |
| `timeout_ms` | `120000` | client timeout (guide requires ≥120s) |
| `retries` | `2` | 429/5xx + network/timeout; `429` honors `Retry-After`, else exponential backoff |

Project precedence: `--project` flag → `KB_PROJECT` (`.env`) → `kb.project` in `agentex.config.json`.

## Result handling

- `OK` → render `answer` as markdown; `sources` lists the KB modules used. `cached:true` means
  the answer was served from the API's cache (no freshness guarantee).
- `NOT_COVERED` (`hasContext=false` or `isNoAnswer=true`) → say "not covered in the knowledge
  base." Do NOT present the model's guess as an answer.
- `BLOCKED` → `400`/`401`/`404` are config/usage problems — surface to the user, never retried.
  `401` specifically means a missing/wrong `KB_ASK_API_KEY`. `429`/`5xx` responses and
  network/timeout errors are transient (already retried) — report and move on.

## Guardrails

- **Advisory, not evidence.** A KB answer must never become a PASS/FAIL verdict or feed the
  execution skill's `VerifyEvidence`. It informs understanding only.
- **No improvised requests.** The runner only ever hits the one KB Ask endpoint with the
  documented body. It composes nothing else.
- **Secrets stay in env.** Only `KB_ASK_BASE_URL`, `KB_PROJECT`, and `KB_ASK_API_KEY` are
  referenced; `KB_ASK_API_KEY` is sent as `x-api-key` and never logged or printed.

## Preflight

Needs only Node (already required by the plugin). For the curl fallback and full
endpoint contract, read `references/kb-ask-api.md`.
