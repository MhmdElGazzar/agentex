# Jira & Confluence Integration

> Let an AgenTeX test run **do the Atlassian paperwork for you** — file defects with screenshots
> and video, build issue hierarchies, plan sprints, and publish the results as a Confluence page —
> all against your real Jira/Confluence cloud, with a human confirming every change.

**Status:** ✅ Verified end-to-end on a live Jira + Confluence tenant (Atlassian CLI `acli` 1.3.x).
Read-only by default; nothing is written without explicit confirmation.

---

## Why it matters (by stakeholder)

| You are a… | This gives you… |
|---|---|
| **QA engineer** | Failed test → a Jira bug filed automatically, with the screenshot and video attached and a link to the report — no manual copy-paste. |
| **Dev / tech lead** | Defects land in your board already linked to the story/epic, in the right sprint, with reproducible evidence attached. |
| **PM / manager** | A single Confluence page per run that embeds **live** Jira status (updates itself as issues move) — one link to share, always current. |
| **Teammate trying it** | Copy `.env.example` → your own `.env`, add your token, one login command (see *Fast start* below). |

---

## What it can do

**Jira** — check connectivity · read projects, issues, boards, sprints · search by JQL · build
linked hierarchies (**Epic → Story / Task / Feature / Bug → Subtask**) · create, edit, transition,
comment on, and link issues · create sprints and add issues to them · read fields, filters, and
dashboards · **attach evidence** (screenshots, video, logs) to issues.

**Confluence** — read and create spaces and blogs · author full page hierarchies with labels,
comments, and access restrictions. A **copy-paste, ready-to-run** page-create recipe is included,
so nobody has to hand-roll the boilerplate.

**Jira ↔ Confluence together** — embed live Jira issues/JQL tables inside a Confluence page, and
link Jira issues back to their Confluence pages. Both directions stay in sync automatically.

---

## Fast start (5 minutes)

1. **Install the CLI.** One binary, direct download — no package manager. See
   [`references/atlassian-cli.md`](references/atlassian-cli.md) for your OS.
2. **Make your own credentials file** — copy the shared template, then fill in *your* values.
   `.env.example` is the committed template (no secrets); `.env` is yours alone (gitignored,
   never shared or committed):
   ```bash
   cp .env.example .env        # then edit .env and set the JIRA_* lines:
   #   JIRA_SITE=your-site.atlassian.net
   #   JIRA_EMAIL=you@example.com
   #   JIRA_API_TOKEN=…        (create at id.atlassian.com → Security → API tokens)
   ```
3. **Log in** (the token is fed in securely — it never appears on the command line):
   ```bash
   set -a; . ./.env; set +a
   echo "$JIRA_API_TOKEN" | acli jira auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token
   acli jira auth status          # ✅ = you're connected
   ```
   Confluence is the same tool and the same credentials, with a separate one-time login
   (`acli confluence auth login …`) — it needs Confluence enabled on your site.

That's it — the agent follows the reference files from there.

---

## Safety, in plain terms

This talks to your **real** Jira and Confluence, so it's built to be cautious:

- 🔒 **Your API token stays secret.** Two files, one rule: **`.env.example`** is the shared,
  committed template (placeholders only — safe to push); **`.env`** is *yours*, gitignored, and
  holds the real token — never commit or share it. The token is never printed, logged, or put on a
  command line. If a token is ever pasted into a chat, treat it as compromised and rotate it.
- ✋ **Nothing is changed without your say-so.** Reading (view / search / list) is free; anything
  that creates, edits, moves, or deletes is stated first and waits for your confirmation.
- 🧪 **Every command is proven, not guessed.** Each one in the reference files was run against a
  live site; the tricky Atlassian quirks are written down so they don't bite you.
- ⚠️ **User administration is fenced off.** The CLI *can* deactivate/delete org user accounts, but
  that's opt-in only, uses a different credential, and is never touched by a normal test run
  (see *Scope* below).

---

## What's in this folder

| File | For whom | What it is |
|---|---|---|
| [`SKILL.md`](SKILL.md) | the agent | Operating instructions: connection check, hierarchy/sprint rules, guardrails |
| `README.md` | **people** | This guide |
| [`references/atlassian-cli.md`](references/atlassian-cli.md) | agent + humans | Jira commands: install, auth, issues, hierarchy, boards, sprints, attachments |
| [`references/confluence-cli.md`](references/confluence-cli.md) | agent + humans | Confluence: spaces, pages (REST), labels, comments, restrictions |
| [`references/admin-cli.md`](references/admin-cli.md) | agent + humans | ⚠️ Opt-in org-admin user management — separate auth, confirm every write |

It follows the same shape as the other AgenTeX integration skills (`azure-integration`): a
`SKILL.md` plus one reference per surface, no bundled scripts — the agent runs the CLI (and, for
the few things the CLI can't do, a documented REST call) directly.

---

## Scope — what's in and what's out

The Atlassian CLI covers several products; this skill deliberately covers the ones a test run uses:

- ✅ **Jira + Confluence** — the everyday QA surfaces. Fully covered and verified.
- ⚠️ **Org admin** (user activate/deactivate/delete) — documented but **opt-in only**: different
  credential, high blast radius, confirm-per-user, and never used by an automated run. Prefer
  deactivate over delete; delete is effectively permanent.
- ➖ **Atlassian Guard** and **Rovo Dev** — not things you'd drive from a test run; out of scope.

New capabilities are added only when there's a real need, always keeping the read-first,
confirm-before-write discipline.

---

<sub>Maturity note: validated across multiple live QA cycles (parallel + headed runs, with image
and video evidence upload). Earlier reviews flagged gaps around attachments and Confluence
authoring — all now closed and re-verified. Ready for the team to try.</sub>
