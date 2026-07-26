# Ask the Knowledge Base

Query your project's **KB Ask API** for natural-language, advisory context — during a test run via
a `kb:` step, or standalone via the `/ask-kb` command.

## How it works

The agent sends your question to the KB Ask API and reads the answer back as **advisory context
only**. It informs testing and navigation (e.g. "how does the checkout flow work?") but is **never**
used as PASS/FAIL evidence. The call is explicit — the agent never queries the KB on its own initiative.

The runner (`skills/ask-kb/scripts/ask_kb.js`):

- Sends the `x-api-key` header from `KB_ASK_API_KEY` when set (never logged).
- Maps `401` to a non-retryable `BLOCKED`; honors `Retry-After` on `429`.
- Surfaces the API's `cached` flag and documents the `sonnet` model default.

## During a test run

A scenario step beginning with `kb:` (or "ask the KB", "what does the knowledge base say") triggers it:

```markdown
## Scenarios
1. kb: how is a returning customer's discount applied at checkout?
2. **Verify** — apply the flow described above and confirm the discounted total in the UI.
```

Target a specific KB project inline: `kb:acme-store: <question>`.

## Standalone

```
/ask-kb how does the checkout flow work?
/ask-kb acme-store: what fields are required at checkout?
```

## Configuration

| Variable | Purpose |
|----------|---------|
| `KB_ASK_BASE_URL` | KB Ask API host (host only, e.g. `http://localhost:3000`). |
| `KB_PROJECT` | Default project id (e.g. `acme-store`); a `kb:<project>:` step overrides it. |
| `KB_ASK_API_KEY` | Shared secret sent as `x-api-key` (required when the server has it set). |

## Reference

- Skill: `skills/ask-kb/SKILL.md`
- Command: `commands/ask-kb.md`
- API contract & curl fallback: `skills/ask-kb/references/kb-ask-api.md`
