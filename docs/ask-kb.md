# Ask the Knowledge Base

If your project has a knowledge base, you can ask it questions in plain language mid-test — or
any time, standalone — instead of digging through docs yourself. The answer is **advisory
only**: it helps you understand a flow, but it never counts as pass/fail proof. The call is explicit — Claude never queries the KB on its own initiative.

## Walkthrough

Standalone, any time:

```
/ask-kb how does the checkout flow work?
```

Claude sends your question to the project's KB Ask API and shows you the answer along with its
sources. If the KB doesn't cover it, you're told plainly rather than given a guessed answer.

During a test run, add a `kb:` line to a scenario:

```markdown
## Scenarios
1. kb: how is a returning customer's discount applied at checkout?
2. **Verify** — apply the flow described above and confirm the discounted total in the UI.
```

A scenario step beginning with `kb:` (or "ask the KB", "what does the knowledge base say") triggers it. Claude asks the KB first (informing how it approaches scenario 2), then goes and verifies the
actual behavior in the browser — the KB answer is context, not the check itself.

To target a specific project's KB: `/ask-kb acme-store: what fields are required at checkout?`
or `kb:acme-store: <question>` inside a spec.

## Quick reference

| Variable | Purpose |
|----------|---------|
| `KB_ASK_BASE_URL` | KB Ask API host (host only, e.g. `http://localhost:3000`); fallback when not in `config/project.json` `kb.baseUrl`. |
| `KB_PROJECT` | Default project id (e.g. `acme-store`); fallback when not in `config/project.json` `kb.project`; a `kb:<project>:` step overrides it. |
| `KB_ASK_API_KEY` | Shared secret sent as `x-api-key` (required when the server has it set). |

**Behind the scenes** (the runner, `skills/ask-kb/scripts/ask_kb.js`):
- Sends `x-api-key` from `KB_ASK_API_KEY` when set (never logged).
- A `401` is reported as `BLOCKED` (not retried); `429` responses honor `Retry-After`
  automatically.
- The response's `cached` flag is surfaced; the API's default model is `sonnet`.

**Reference:**
- Skill: `skills/ask-kb/SKILL.md`
- Command: `commands/ask-kb.md`
- API contract & curl fallback: `skills/ask-kb/references/kb-ask-api.md`
