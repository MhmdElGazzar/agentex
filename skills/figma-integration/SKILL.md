---
name: figma-integration
description: Operate Figma from a QA/dev-handoff run through Figma's official CLI (`figma connect`, the `@figma/code-connect` package) and the Figma REST API. Covers installation and authentication diagnosis, file and node discovery, reading a design's text layers into user stories and test conditions, rendering frames as baseline images, scaffolding and previewing component↔code mappings, publishing to Dev Mode, and troubleshooting. Use when a task needs to turn a Figma screen into requirements or tests, verify a build against a design, or sync a component library with code. Do not use for editing Figma designs.
---

# Figma Integration

Use Figma's official CLI (`figma connect`, shipped as `@figma/code-connect`) and the Figma REST API
to read designs and sync component mappings. The CLI binary is named `figma`; there is no other
official Figma CLI, and the `connect` command tree is its only command family.

This skill has two paths, and picking the wrong one wastes a whole session:

- **Read a design (REST)** — the everyday path. Turns a screen into user stories and test
  conditions. Needs only a **File content: Read** token.
- **Sync design↔code (CLI)** — only when a real, published component library exists. Needs an
  Org/Enterprise plan and a two-scope token.

You never edit designs. Prefer reads; confirm before any `publish`/`unpublish`/`migrate`.

## Enforce the official-tool boundary

Perform every Code Connect authentication, scaffold, preview, publish, and unpublish through the
official `figma connect` commands. Perform every design read through the documented Figma REST
endpoints or the Figma MCP tools. Do not substitute browser automation, a scraped Figma page, or a
third-party Figma CLI when the official tool is missing a capability or returns an error. Stop and
report the limitation instead of silently changing tools.

`figma-cli` on npm is an unrelated third-party package from 2019, not Figma's tool. Never install it.

## Know these limits before scoping the work

These are hard gaps, verified against the official docs and the live CLI. Check them at **step 1**,
not after promising an outcome — each one silently breaks a common handoff workflow:

| You may be asked to… | Figma's tooling can? |
|---|---|
| Publish Code Connect on a Free or Professional plan | **No.** Code Connect is available only on a Dev or Full seat on **Organization** and **Enterprise** plans. Publish fails regardless of token or scopes. |
| Map a plain frame or section to code | **No.** The node must be a real Figma **Component** published to a team library. Most app-screen files have zero published Components — those are a REST job. |
| Read button labels or error copy via the Figma MCP | **No.** `get_metadata`/`get_screenshot` return structure and a picture, not TEXT-layer characters. Use the REST `/nodes` extraction for the actual words. |
| List every file the token can see | **No.** There is no "list all files" endpoint. You must name a team, project, or file key. |
| Edit or create design content | **Out of scope.** This skill reads designs and syncs mappings only. |

State the limitation plainly when you hit one. Never substitute a different tool, and never report a
step as done when the tool could not do it.

## Follow the operating workflow

### 1. Establish intent and scope

Classify the request before running commands:

- Treat REST GETs, `preview`, `parse`, and `--help` as read-only.
- Treat `create` as a read-then-write-file action — it fetches from Figma and writes a local file.
- Treat `publish`, `unpublish`, `migrate`, and posting a comment as mutations that change what
  teammates see in Figma Dev Mode.

Then pick the path with one question: **is the target a published Component, or a screen?**
A screen, frame, or section → REST read. A published Component with matching code → CLI.
When unsure, run the component check in step 2 before committing to the CLI path.

### 2. Preflight the tool and authentication

Credentials come from `.env` (gitignored): `FIGMA_ACCESS_TOKEN`, optionally `FIGMA_FILE_KEY`.
Confirm auth and that a real file read works:

```bash
set -a; . ./.env; set +a
[ -n "$FIGMA_ACCESS_TOKEN" ] || echo "BLOCKED: set FIGMA_ACCESS_TOKEN in .env"
curl -s -o /dev/null -w "me:%{http_code}\n"   -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" https://api.figma.com/v1/me
curl -s -o /dev/null -w "file:%{http_code}\n" -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>?depth=1"
```

`me:200` + `file:200` = ready to read designs. A `404` on the file read (not `403`) is the
signature of a missing **File content: Read** scope.

*(On Windows/PowerShell, use the `.env` loader in the reference's Windows note — the `set -a` form
is bash only.)*

**Only if you will publish Code Connect**, confirm the file actually has published Components
before spending time on the CLI:

```bash
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/components" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const n=((JSON.parse(d).meta||{}).components||[]).length;console.log(n?("Code Connect possible: "+n+" published components"):"REST-only: 0 published components — Code Connect N/A")})'
```

An empty result means the CLI path is unavailable — say so and stay on REST. The CLI also needs
Node 18+ and the token's **Code Connect: Write** scope; without Write, `figma connect` returns a
403 naming both required scopes.

### 3. Discover the live command contract

Run `--help` on the exact command before composing a non-trivial operation:

```bash
npx @figma/code-connect@latest --help
npx @figma/code-connect@latest connect --help
npx @figma/code-connect@latest connect publish --help
```

Use live help as the source of truth for command names and flags — they change between releases.
Use [figma-cli.md](references/figma-cli.md) for durable patterns, the config schema, the authoring
API, and official links, not as a substitute for installed-version help.

### 4. Read the design before deriving anything

Parse the Figma URL first: `figma.com/design/<FILE_KEY>/Name?node-id=<NODE-ID>`. The URL uses a
**dash** (`11073-1898`); the REST API keys its response by **colon** (`11073:1898`). `/nodes?ids=`
accepts either form — but the **response is always keyed by the colon form**, so index it with the
colon (or read `Object.values(...)[0]`) or you get `undefined` from a lookup that looks correct.

Ground every derived line in the design's actual **TEXT layers** — the on-screen words are the
requirements. Raw Dev Mode CSS is positions and shapes with no actions or labels; never derive a
story from it, or from a frame name alone. Use the bundled runner — it is the tested extractor:
```
node ${CLAUDE_PLUGIN_ROOT}/skills/figma-integration/scripts/extract_visible_text.js \
  --file <FILE_KEY> --node <NODE_ID> [--per-frame]
```
Equivalent inline `curl | node -e` snippets (for a bare shell) are in the reference under
"§Read designs via the Figma REST API".

**Only effectively-visible text is a requirement.** Figma files carry text that never renders —
deprecated states, alternate variants, layers parked at `opacity: 0`. The runner above handles this.
If you adapt the reference's snippets instead, keep their guard: check `visible` **and** inherited
`opacity` together — a layer can be `visible: true` while an
ancestor sets `opacity: 0`, so checking `visible` alone silently lets hidden text through. Hidden
text extracted as a requirement becomes a fabricated Test Case downstream — and, in a
design-vs-build run, a false "missing from the build" finding.

When the link points at a **SECTION** or any node holding several screens, iterate its top-level
children so each frame becomes its own story. Do not flatten a feature into one undifferentiated
dump — use the reference's "one story per frame" snippet.

### 5. Emit the handoff block

Read a screen, then emit this fixed shape so the next stage consumes it directly:

```
Description:      <one line — what the screen is / does>
User Story:       As a <role>, I want <goal>, so that <benefit>.
Test Conditions:  - <condition 1>   (each maps 1:1 to a test-design Test Case)
                  - <condition 2>
Design ref (opt): <PNG URL from /v1/images — a visual baseline for design-vs-build>
```

Emit one block **per frame** for a multi-screen node. Include the **Design ref** PNG
(`/v1/images`) when a design-vs-build baseline is wanted — the URL expires in **~30 minutes**, so
download it immediately rather than storing the link.

### 6. Design-vs-build comparison — the full cycle

**Trigger:** the user supplies a **Figma link + a site URL** ("compare this design to the build",
"does the page match the design?"). This orchestrates two skills — **this one reads the design
(REST)**, **`browser-testing` drives the page (`playwright-cli`)**. Neither does both: the Figma
CLI *cannot* read designs or render images, and Playwright cannot read Figma.

**A. Read the design side (this skill)**
1. Parse the Figma URL → `FILE_KEY` + `NODE_ID` (step 4).
2. `GET /files/<key>/nodes?ids=<node>` → walk **TEXT** layers per top-level section, so headers,
   controls, and nav are listed separately rather than as one dump.
3. `GET /images/<key>?ids=<node>&format=png` → the visual baseline. Download it **immediately**
   (~30-min URL).
4. Read the frame's `absoluteBoundingBox.width` — this is the viewport to match in step B.

**B. Capture the build side (`browser-testing` → read its reference first)**
5. Open the URL; if it redirects to a login, authenticate (`fill <ref> <text>` per field, using
   refs from a `snapshot`), then confirm you landed on the target page.
   **Once authenticated, stay in the session** — navigate to further pages with an in-session
   `page.goto()` via `run-code`, not a fresh `open`. Repeated `open` calls can drop the session and
   bounce you back to the login screen, which reads as an auth failure but is really a lost session.
   Comparing several routes behind one login (a multi-frame run) makes this the normal case.
6. **Set the viewport to the design frame's width** — `resize <w> <h>` — before screenshotting,
   or every layout difference is really just a scaling artifact.
7. Screenshot for the record, **and** extract structure from the DOM. A screenshot alone silently
   misses anything scrolled outside the viewport, which is exactly where wide tables hide columns:
   ```
   run-code "async (page) => { const cols = await page.locator('table thead th').allInnerTexts();
   const btns = await page.getByRole('button').allInnerTexts();
   const nav = await page.locator('nav a, aside a').allInnerTexts();
   return JSON.stringify({cols, btns, nav}); }"
   ```
   (one line in practice — see the `browser-testing` reference on `run-code` formatting).

   **Use role/structural locators, never a text regex, to decide a control is absent.** A regex over
   page text misses a control whose label is an `aria-label`, an icon, or split across elements —
   producing a false "missing from the build" defect. `getByRole('button')` and
   `table thead th` are the assertions; grepping innerText is not. If a control looks absent,
   confirm with a role query before classifying it as design-not-built.
8. Check the browser console: JS errors are defects even when the UI looks correct.

**C. Diff and classify**
9. Compare **structure and content, not pixels** — column *names*, control labels, nav entries,
   pagination. Never diff row values (see the placeholder rule below).
10. Classify every difference, and give each a severity:

   | Class | What it means | Severity |
   |---|---|---|
   | **design-not-built** | in the design, missing from the build | by feature criticality — a missing action is Critical, a missing decoration is Low |
   | **built-not-designed** | in the build, absent from the design | **not a bug** — file a design-update task instead |
   | **renamed / consolidated** | same concept, different label or merged cell | Low — wording decision |
   | **semantic change** | same slot, *different data* | needs a **product decision**, not a severity |

   Classes are **not mutually exclusive** — a control that was both renamed *and* merged (three
   dropdowns → one) is legitimately renamed + consolidated + arguably semantic. Assign a
   **primary** class and note the secondary rather than forcing one label.
11. A build **ahead** of the design is not a defect. Ask which artifact is the source of truth
    before filing anything, and say plainly when the recommendation is "update the Figma file".

**D. Report** — group by the four classes above, lead with semantic changes, and state the
console-error count. Attach the design PNG and the live screenshot as the visual pair, saved into
the run folder (never left in scratch, which is cleared):
`executions/execu_<ts>/design/figma-<node>.png` + `…/browser-sessions/<s>/screenshots/<page>.png`,
with the write-up at `executions/execu_<ts>/report.md`.

> **Orchestrator-only.** Run this cycle directly — do **not** delegate it to `qa-executor`, whose
> step contract covers `api:`/`db:`/`kb:` only. A `figma:` step in a spec is silently ignored, so a
> delegated comparison reports success while doing nothing.

**Multi-frame comparisons.** The cycle above is one frame ↔ one page. When the link points at a
**SECTION** holding several screens, pair each child frame with its route and run A–C per pair,
then report once with a per-screen section. Confirm the frame→route mapping with the user before
starting — frame names rarely match URL paths, and guessing silently compares the wrong pages.

**Never a defect:** placeholder row data (repeated dummy names, phone numbers, plate/ID strings),
lorem text, or avatar images — designs use filler copy. Typos *fixed* in the build are design
defects already resolved, not build defects; report them as such.

### 7. Execute CLI mutations safely

Follow these rules:

- Run read-only operations (`preview`, `parse`, REST GETs) directly.
- Publish under a **disposable `--label`** first so a mistake is invisible to the team and
  removable with one `unpublish`, then switch to the real label.
- Run `publish --dry-run` to validate before any real publish.
- Require explicit authorization naming the action and target before `publish`, `unpublish`, or
  `migrate`. State exactly what will be published or removed first.
- Treat `migrate` output as a **starting point, not finished** — commit first, write to `--outDir`
  to keep originals, review the conversions, and delete originals only once the new files parse.
- In CI or any non-interactive shell, use `--exit-on-unreadable-files` so unparseable files fail
  the run instead of being skipped silently.

### 8. Verify and report

Check the exit status and the CLI output. `publish` prints component names and node URLs — surface
those links to the user. After a publish, confirm the snippet actually appears in Dev Mode under
the expected label; a successful exit code alone is not evidence, because a wrong `--label` or an
unpublished Component both exit clean with nothing visible.

Report the file key and node IDs read, the frames turned into stories, the label published under,
and anything skipped with its reason. Do not claim success from command construction alone.

## Use the command families

Load [figma-cli.md](references/figma-cli.md) when selecting commands or troubleshooting.

- **REST reads** — `/v1/me`, `/files/<key>`, `/files/<key>/nodes?ids=`, `/components`, `/styles`,
  `/comments`, `/images`. The workhorse; the CLI cannot read a design.
- **`figma connect create|preview|parse`** — scaffold, render, and debug mappings (read-oriented).
- **`figma connect publish|unpublish|migrate`** — mutations; confirm first.
- **Figma MCP tools** — the template-based authoring path when an MCP server is connected; needs
  no token. Prefer templates over the parser API when MCP is available.

## Handle failures

On an error:

1. Capture the exit code and sanitized error text.
2. Recheck the token scopes, the plan tier, and the exact command's `--help`.
3. Distinguish scope errors (403 naming both scopes), permission errors (404 on file read), plan
   limits, glob misses, and property-name mismatches — the reference has a symptom table.
4. Retry only after correcting the identified cause; do not loop blindly.

**Never print or log the token.** Pass it via `FIGMA_ACCESS_TOKEN` from `.env` or the
`X-Figma-Token` header — never echo it or place it in argv, where `--token` leaks it into shell
history. Treat a token pasted into the conversation as compromised and advise rotating it.

## Handoff targets — who consumes this

This skill is the **producer at the front of the pipeline**; it does not itself write to any
tracker. The same output feeds different downstream skills — pick by where the work is tracked:

- **`test-design`** (Azure DevOps) — *User Story* + *Test Conditions* → one linked Test Case each.
  Primary tracked-work route on ADO.
- **`task-estimation`** — the scoped conditions/screens feed effort estimates and `[Testing]` tasks.
- **`browser-testing`** — *Description + Test Conditions* → a `test/suite/*.md` spec; the **Design
  ref** PNG is the visual baseline for the run.
