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

    kb: <question>              # uses the default project from config/project.json (legacy agentex.config.json is a fallback)
    kb:<project>: <question>    # inline project override

Examples:

    kb: How does the checkout payment flow work?
    kb:acme-store: How is the order total calculated?

## Configuration (consumer project)

Settings live in `config/project.json`'s `kb` block (`baseUrl`, `project`, `org`); the
matching `KB_*` variables in `.env` are the fallback when a key is missing there. Only
`KB_ASK_API_KEY` is a real secret and lives in `.env` alone:

| `.env` key | Example | Notes |
|---|---|---|
| `KB_ASK_BASE_URL` | `http://localhost:3000` | endpoint host (host only); fallback when not in `config/project.json` `kb.baseUrl` |
| `KB_PROJECT` | `acme-store` | fallback project id; overridden by `config/project.json` `kb.project`; `kb:<project>:` overrides per step |
| `KB_ORG` | `acme` | fallback org slug; overridden by `config/project.json` `kb.org`; `--org` flag takes precedence. Blank ⇒ config ⇒ generic default |
| `KB_ASK_API_KEY` | `<secret>` | shared secret; sent as the `x-api-key` header. Required when the server has it set (else `401`). Leave blank only for an unauthenticated dev server. Never logged/printed. |

`config/project.json` → `kb` block tunes the rest (legacy `agentex.config.json` still honored; missing key = documented default):

| Key | Default | Notes |
|---|---|---|
| `org` | `acme` | API default |
| `model` | `opus` | `opus` / `sonnet` / `haiku` (the API's own default is `sonnet`) |
| `timeout_ms` | `120000` | client timeout (guide requires ≥120s) |
| `retries` | `2` | 429/5xx + network/timeout; `429` honors `Retry-After`, else exponential backoff |

Project precedence: `--project` flag → `kb.project` in `config/project.json` → `KB_PROJECT` (`.env`) → legacy `agentex.config.json`.

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
- **The API key is the only real secret.** The runner also reads `kb.baseUrl` /
  `kb.project` / `kb.org` from `config/project.json` (or their `KB_*` fallbacks in
  `.env`) — those aren't secret. `KB_ASK_API_KEY` stays env-only, sent as `x-api-key`,
  and is never logged or printed.

## Preflight

Needs only Node (already required by the plugin). For the curl fallback and full
endpoint contract, read `references/kb-ask-api.md`.
