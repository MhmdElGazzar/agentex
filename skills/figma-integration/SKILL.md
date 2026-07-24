---
name: figma-integration
description: Reach Figma from a QA/dev-handoff run — read a design via the Figma REST API to derive user stories, test conditions, and design-vs-build baselines (primary), or sync design↔code via the official `@figma/code-connect` CLI (secondary). Use whenever a task needs to turn a Figma screen into requirements/tests, verify a build against the design, render a frame as an image, or publish component↔code mappings for Dev Mode.
---

# Figma Integration

## Role
In the AgenTeX QA pipeline (read requirements → design tests → execute → report), this skill is a
**producer**: you **read a Figma design and turn it into user stories + test conditions** that feed
`test-design` and `browser-testing`. The design's real text layers — labels, states, actions,
error messages — are requirements the AC prose often omits. This is the primary, everyday use, and
it needs only a **File-content: Read** token (a simple REST read).

Secondary — **only when a real component library exists** — this skill can also **sync design↔code**
via Figma's official CLI `@figma/code-connect` (map a Figma Component to your code component so it
shows in Dev Mode). That path needs published Components *and* a token with both scopes; it does not
feed the test pipeline. App-screen designs (plain frames) are a read job, not a Code Connect job.

You never edit designs. Prefer reads; confirm before any `publish`/`unpublish`.

## Handoff — what this skill outputs
Read a screen, then emit this fixed shape so the next stage consumes it directly:

```
Description:      <one line — what the screen is / does>
User Story:       As a <role>, I want <goal>, so that <benefit>.
Test Conditions:  - <condition 1>   (each maps 1:1 to a test-design Test Case)
                  - <condition 2>
Design ref (opt): <PNG URL from /v1/images — a visual baseline for design-vs-build>
```
- Ground every line in the design's actual TEXT layers (see the reference's extraction snippet) —
  never invent from a frame name or from Dev Mode CSS (CSS has no actions/labels).
- For a **section/feature** (many screens), emit one such block **per frame** (see the reference's
  "one story per frame" recipe).
- Include the **Design ref** PNG (`/v1/images`, ~30-min URL) when a design-vs-build baseline is
  wanted — attach it to the executor's evidence or the tracked work item.

### Handoff targets — who consumes this
The same output feeds different downstream skills; pick by where the work is tracked:
- **`test-design`** (Azure DevOps) — *User Story* + *Test Conditions* → Step 2 → one linked Test
  Case each. Primary tracked-work route on ADO.
- **`jira-integration`** (Jira/Confluence) — *User Story* → a Story (or Epic→Story hierarchy);
  *Test Conditions* → the story's ACs; optionally publish the set to a Confluence page.
- **`task-estimation`** — the scoped conditions/screens feed effort estimates and `[Testing]` tasks.
- **`browser-testing`** — *Description + Test Conditions* → a `test/suite/*.md` spec (*Description*
  → intro, *Test Conditions* → **Acceptance criteria** / **Scenarios**); the **Design ref** PNG is
  the visual baseline for the run.

This skill is the **producer at the front of the pipeline** — it reads the design and emits the
block; the consumer skills above turn it into tracked work. It does not itself write to Jira/ADO.

## Tool
Setup, install, auth, and all commands live in this skill's `references/` folder. **Read the
reference file BEFORE the first `figma connect` command in a session**, and again whenever a
command behaves unexpectedly:
- **`${CLAUDE_PLUGIN_ROOT}/skills/figma-integration/references/figma-cli.md`** — has both halves:
  **(read, primary)** the Figma REST recipes — discovery (teams→projects→files), file/node reads,
  the TEXT-layer extraction snippet for stories/conditions, images, styles, comments; and
  **(sync, secondary)** the `@figma/code-connect` CLI — install, auth, `figma.config.json`,
  commands, and `.figma.ts` authoring. For the read path, jump to "§Read designs via the Figma
  REST API".

## Verify the connection first
The common path is a **read**, which needs only the File-Read scope. Confirm auth and that a file
read works (matches the `azure-integration` connection-check pattern):

```bash
set -a; . ./.env; set +a
[ -n "$FIGMA_ACCESS_TOKEN" ] || echo "BLOCKED: set FIGMA_ACCESS_TOKEN in .env"
curl -s -o /dev/null -w "me:%{http_code}\n" -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" https://api.figma.com/v1/me
# and a real file read should be 200 (404/403 = no access or missing File-Read scope):
curl -s -o /dev/null -w "file:%{http_code}\n" -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>?depth=1"
```
`me:200` + `file:200` = ready to read designs. Credentials come from `.env` (gitignored):
`FIGMA_ACCESS_TOKEN`, optionally `FIGMA_FILE_KEY`.

**Only if you will `publish`/`unpublish` Code Connect** (the secondary path): first check the file
actually has **published Components** — no components means Code Connect can't run *at all* (most
app-screen files are this case), so don't spend time on the CLI:
```bash
# empty "meta.components" [] → REST-only, skip Code Connect entirely:
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/components" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const n=((JSON.parse(d).meta||{}).components||[]).length;console.log(n?("Code Connect possible: "+n+" published components"):"REST-only: 0 published components — Code Connect N/A")})'
```
The CLI path also needs the token's **Code Connect: Write** scope + Node 18+
(`npx @figma/code-connect@latest --version`); without Write, `figma connect` 403s "Invalid scope(s)".

## Rules
- Preflight `figma connect --help` (via `npx`) before use; it's an **npm** CLI (Node 18+), not a
  standalone binary and not installed by default — install per the reference if missing.
- **Never print or log the token** — pass it via `FIGMA_ACCESS_TOKEN` from `.env` (or the
  `X-Figma-Token` header for REST); never echo it or place it in argv.
- Default to read-only (`preview`, `parse`, REST GETs). **Confirm with the user before any write** —
  `publish`, `unpublish`, or `migrate` change what teammates see in Figma Dev Mode — and state
  exactly what will be published/removed first.
- In CI/non-interactive shells, use `--exit-on-unreadable-files` and the `FIGMA_ACCESS_TOKEN` env
  var — never hardcode the token.
