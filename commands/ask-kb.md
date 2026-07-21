---
description: Ask the project's Knowledge Base a natural-language question via the KB Ask API and show the answer with its sources. Usage: /ask-kb <question>, or /ask-kb <project>: <question> to target a specific project.
---

Answer the user's question from the project's Knowledge Base using the **ask-kb** skill's
runner. This is a read-only lookup — the answer is advisory context, never a PASS/FAIL verdict.

Question / arguments: $ARGUMENTS

Do this:

1. **Parse the arguments:**
   - If they begin with `<project>:` (e.g. `dwi: how does the Musaned flow work?`), use that as
     the project and the rest as the question.
   - Otherwise the whole string is the question and the default project is resolved from
     `.env` (`KB_PROJECT`) → `agentex.config.json` (`kb.project`).
   - If `$ARGUMENTS` is empty, ask the user what they want to ask the KB, then stop.

2. **Run the bundled runner** (it reads `KB_ASK_BASE_URL` / `KB_PROJECT` / `KB_ASK_API_KEY`
   from `.env`, sends the `x-api-key` header when the key is set, and never composes any other
   request). Create `./executions/ask-kb/` first if missing:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/ask-kb/scripts/ask_kb.js \
     --question "<question>" [--project <id>] --log ./executions/ask-kb/last.log
   ```

3. **Read the one-line JSON result and present it:**
   - `OK` → render the `answer` as markdown, then list the `sources`. If `cached` is `true`,
     note the answer came from cache.
   - `NOT_COVERED` → tell the user it is not covered in the knowledge base. Do NOT invent an
     answer.
   - `BLOCKED` → report the `reason` verbatim and stop (do not retry). Common cases:
     `KB_ASK_BASE_URL` not set → tell them to add it to `.env` (or run `/init-test`);
     `404` unknown/empty project → the project has no KB on the server;
     `401` → set/fix `KB_ASK_API_KEY` in `.env`.

Never print or log the API key. For the full endpoint contract, see
`${CLAUDE_PLUGIN_ROOT}/skills/ask-kb/references/kb-ask-api.md`.
