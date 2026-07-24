# Figma Integration

> Let an AgenTeX run **use your Figma designs** — read a screen's real content to write user
> stories and test conditions, verify the built UI matches the design, render frames as evidence
> images, and (for a component library) keep design ↔ code in sync in Dev Mode.

**Status:** ✅ Verified live against a real Figma tenant — all REST read endpoints and the
`@figma/code-connect` CLI. Read-only by default; nothing is written without confirmation.

---

## Why it matters (by stakeholder)

| You are a… | This gives you… |
|---|---|
| **QA engineer** | Read a Figma screen's real labels/actions → derive test conditions the AC text missed; render the frame as a reference image for a design-vs-build check. |
| **Business analyst / PO** | Turn a design frame straight into user stories grounded in the actual screen content, not guesswork. |
| **Dev / design-system owner** | Publish `component ↔ code` mappings so devs see your real code snippet inside Figma Dev Mode. |
| **Teammate trying it** | Copy `.env.example` → your own `.env`, add a Figma token, done (see *Fast start*). |

---

## Two ways it works

**1. Read designs (REST API) — the everyday workhorse.** Pull a frame's text, specs, components,
styles, comments, or a rendered PNG. Needs only a **File-Read** token. This is what powers
"design → user stories / test conditions" and design-vs-build QA.

**2. Sync design ↔ code (Code Connect) — `@figma/code-connect`.** Publish mappings that link a
Figma **Component** to your code component, shown in Dev Mode. Two authoring modes: parser
`.figma.tsx` via the CLI (`figma connect publish`), or template `.figma.ts` via the Figma MCP tools
— the reference explains which to use. Needs an Org/Enterprise plan, published Components, and (for
the CLI path) a token with **both** File-Read *and* Code-Connect-Write scopes.

> **Which do I use?** Reading a design (stories, specs, QA, images) → **REST**. Keeping a component
> library in sync with code → **CLI**. App-screen files (plain frames, no published Components) are
> a REST job, not a Code Connect job.

---

## Fast start (5 minutes)

1. **Node 18+** — the CLI runs via `npx @figma/code-connect@latest` (no global install needed).
2. **Make your own credentials file** — copy the shared template, then fill in *your* token.
   `.env.example` is committed (placeholders only); `.env` is yours alone (gitignored):
   ```bash
   cp .env.example .env        # then edit .env:
   #   FIGMA_ACCESS_TOKEN=figd_…   (Figma → Settings → Security → Personal access tokens)
   #   FIGMA_FILE_KEY=…            (optional; the …/design/<FILE_KEY>/… segment of a Figma URL)
   ```
   Scopes: **File content → Read** for design reads; add **Code Connect → Write** only if you'll
   publish mappings. The CLI needs **both**.
3. **Check the connection:**
   ```bash
   set -a; . ./.env; set +a
   curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" https://api.figma.com/v1/me   # 200 = connected
   ```
   *(On Windows/PowerShell, see the "Windows note" in the reference for the `.env` load equivalent.)*

---

## Read a screen → user stories (paste this)
Grab a Figma frame URL, convert the node-id (`11073-1898` → `11073:1898`), and pull its text —
those words are your requirements:
```bash
set -a; . ./.env; set +a
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/<FILE_KEY>/nodes?ids=<NODE:ID>" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const doc=Object.values(JSON.parse(d).nodes)[0].document,out=[];
  (function w(n){if(n.type==="TEXT"&&n.characters)out.push(n.characters.replace(/\s+/g," ").trim());(n.children||[]).forEach(w)})(doc);
  console.log(doc.name+" — "+out.length+" text layers");out.forEach(t=>t&&console.log("  • "+t));
});'
```
Then shape the output into `Description → User Story → Test Conditions` (the handoff format in
`SKILL.md`) and hand it to `test-design`. Full endpoint list + the MCP Code Connect path are in
[`references/figma-cli.md`](references/figma-cli.md).

---

## Safety, in plain terms

- 🔒 **Your token stays secret.** Kept in `.env` only (gitignored), sent in the `X-Figma-Token`
  header or `FIGMA_ACCESS_TOKEN` — never printed, logged, or placed on a command line. A token
  pasted into a chat is compromised — rotate it.
- ✋ **Reads are free; writes are confirmed.** REST GETs and `preview`/`parse` are read-only.
  Anything that changes Figma — `publish` / `unpublish` / `migrate`, or posting a comment — is
  stated first and waits for your OK.
- 🧪 **Verified, not assumed.** Every REST endpoint and CLI command in the reference was run
  against a live Figma tenant; the real gotchas (the two-scope 403, node-id dash-vs-colon, the
  ~30-min image-URL expiry, Windows path traps) are documented inline.

---

## What's in this folder

| File | For whom | What it is |
|---|---|---|
| [`SKILL.md`](SKILL.md) | the agent | Operating instructions: when to use REST vs CLI, connection check, guardrails |
| `README.md` | **people** | This guide |
| [`references/figma-cli.md`](references/figma-cli.md) | agent + humans | The full reference — CLI (install/auth/commands/authoring) **and** the REST read toolkit |

Follows the same shape as the other AgenTeX integration skills (e.g. `azure-integration`): a
`SKILL.md` plus a reference, no bundled scripts — the agent runs the CLI (via `npx`) and REST
calls directly.

---

## Scope — what's in and what's out

- ✅ **Read designs (REST)** — text/specs, components, styles, comments, image renders. Fully
  verified; the primary everyday use.
- ✅ **Code Connect (CLI)** — component↔code mappings for Dev Mode. Real, but only applies when you
  have published **Components** and matching **code components**, plus a both-scopes token.
- ➖ **Editing designs** — out of scope. This skill reads designs and syncs mappings; it does not
  create or modify Figma content.

Pairs with **`test-design`**: when a story carries a Figma link, that skill can hand off to this
one to read the frame and enrich the test conditions.
