---
name: ask-kb-command
description: "Ask the project's Knowledge Base a natural-language question via the KB Ask API and show the answer with its sources. Usage: /agentex:ask-kb-command <question>, or /agentex:ask-kb-command <project>: <question> to target a specific project."
disable-model-invocation: true
---

> **AgenTeX on Devin.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), start it as a subagent; ask the user anything you need before dispatching, because subagents cannot ask.

Answer the user's question from the project's Knowledge Base using the **ask-kb** skill's
runner. This is a read-only lookup — the answer is advisory context, never a PASS/FAIL verdict.

Question / arguments: (the argument text the user typed after the command's name)

Do this:

1. **Parse the arguments:**
   - If they begin with `<project>:` (e.g. `acme-store: how does the checkout flow work?`), use that as
     the project and the rest as the question.
   - Otherwise the whole string is the question; pass no `--project` and the runner resolves the
     default itself: `config/project.json` (`kb.project`) → `KB_PROJECT` (environment or `.env`,
     read by the runner) → `agentex.config.json` (`kb.project`). Never read `.env`.
   - If the argument text is empty, ask the user what they want to ask the KB, then stop.

2. **Run the bundled runner** (it reads `baseUrl` / `project` / `org` from `config/project.json`'s
   `kb` block first, falling back to `KB_ASK_BASE_URL` / `KB_PROJECT` / `KB_ORG` in `.env`; the
   API key always comes from `KB_ASK_API_KEY` in `.env`. Sends the `x-api-key` header when the
   key is set, and never composes any other request). Create `./executions/ask-kb/` first if
   missing:

   ```
   node <agentex-root>/skills/ask-kb/scripts/ask_kb.js \
     --question "<question>" [--project <id>] --log ./executions/ask-kb/last.log
   ```

3. **Read the one-line JSON result and present it:**
   - `OK` → render the `answer` as markdown, then list the `sources`. If `cached` is `true`,
     note the answer came from cache.
   - `NOT_COVERED` → tell the user it is not covered in the knowledge base. Do NOT invent an
     answer.
   - `BLOCKED` → report the `reason` verbatim and stop (do not retry). Common cases:
     `KB_ASK_BASE_URL` not set → tell them to set `kb.baseUrl` in `config/project.json` or `KB_ASK_BASE_URL` in `.env`;
     `404` unknown/empty project → the project has no KB on the server;
     `401` → set/fix `KB_ASK_API_KEY` in `.env`.

Never print or log the API key. For the full endpoint contract, see
`<agentex-root>/skills/ask-kb/references/kb-ask-api.md`.
