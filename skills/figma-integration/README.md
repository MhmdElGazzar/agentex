# Figma Integration Skill

Read Figma designs and sync design↔code safely through Figma's official CLI (`figma connect`) and
the Figma REST API.

## Use the skill

Ask for what you need in plain language — the skill triggers on the intent, not a specific
invocation phrase:

- "Turn this Figma screen into user stories and test conditions."
- "Read every frame in this section and give me one story each."
- "Render this frame as a PNG baseline for a design-vs-build check."
- "Here's the Figma link and the site URL — compare them and report the differences."
- "Check whether this file has published Components."
- "Preview our Code Connect mappings, but do not publish them."

## Capabilities

- Diagnose Figma token scopes, plan/seat eligibility, and CLI installation.
- Discover teams, projects, files, nodes, published Components, and styles.
- Extract a screen's real TEXT layers — the on-screen words that become requirements.
- Derive `Description → User Story → Test Conditions` blocks, one per frame.
- Render frames as PNG baselines for design-vs-build verification.
- Run the **full design-vs-build cycle** from a Figma link + a site URL: read the design here,
  drive the page via `browser-testing`/`playwright-cli`, and report classified differences.
- Read design comments as an additional requirements source.
- Scaffold, preview, parse, publish, and unpublish component↔code mappings for Dev Mode.

## Verified capability and limitation report

Verified on July 30, 2026 against the live CLI (`@figma/code-connect` **1.5.0**, run via `npx`) and
Figma's official developer docs. **This table is a point-in-time snapshot and goes stale silently** —
the CLI's flags change between releases (1.4.9 → 1.5.0 landed within a day of the previous check).
Live `figma connect <cmd> --help` is always authoritative where it differs from anything below;
reconfirm before relying on a version-specific flag. The two-path architecture is version-stable:
re-verified on 1.5.0 that the CLI still exposes only the six `connect` subcommands and **still has
no design read/export/render command**, so design reads remain REST-only.

### What the official tooling can handle

| Requirement | Capability |
|---|---|
| Read a screen's labels, actions, and error copy | REST `/files/<key>/nodes?ids=` + TEXT-layer walk |
| Split a feature into per-screen stories | Iterate a SECTION's top-level child frames |
| Produce a visual baseline | REST `/images` → PNG URL (expires in ~30 min) |
| Compare a design against a live build | REST (design side) + `browser-testing`/`playwright-cli` (build side) — the CLI plays no part |
| Find Code Connect targets | REST `/files/<key>/components` |
| Author a mapping | `figma connect create`, or the Figma MCP template tools |
| Validate before shipping | `figma connect preview`, `parse`, `publish --dry-run` |
| Ship a mapping to Dev Mode | `figma connect publish --label <l>` |
| Undo a mapping | `figma connect unpublish --node <url> --label <l>` |

### What it cannot directly or safely guarantee

- **Code Connect needs a Dev or Full seat on an Organization or Enterprise plan.** On Free or
  Professional it fails regardless of token or scopes. This is the most common dead end.
- **Only published Components can be mapped.** A plain frame or section cannot. Most app-screen
  files have zero published Components and are a REST job, not a Code Connect job.
- **The CLI cannot read a design.** Reading is REST-only; the CLI exists to author mappings.
- **The Figma MCP does not return TEXT-layer characters.** `get_metadata`/`get_screenshot` give
  structure and a picture; the actual button labels and validation copy come from REST.
- **There is no "list all files" endpoint.** You must name a team, project, or file key.
- **A clean `publish` exit is not proof.** A wrong `--label` or an unpublished Component both exit
  successfully with nothing visible in Dev Mode. Verify in Dev Mode.
- **A design cannot compensate for missing intent.** A frame with no text supports a placeholder or
  a clarification request, not reliable test conditions.

The skill must stop and report a limitation. It must not switch to browser automation, a scraped
Figma page, or a third-party Figma CLI.

## Best practice for design-derived QA work

1. Decide whether the scope is one screen or a whole feature/section.
2. Parse the URL into `FILE_KEY` and `NODE_ID` (either dash or colon form works on the request).
3. Confirm the token reads the file (`me:200` + `file:200`) before deriving anything.
4. Check for published Components only if a Code Connect mapping is actually the goal.
5. Extract TEXT layers — never derive a story from a frame name or Dev Mode CSS.
6. For a section, emit one story block per child frame instead of one flattened dump.
7. Attach the `/images` PNG when a visual baseline is wanted, and download it immediately.
8. Hand the block to `test-design`, `task-estimation`, or `browser-testing`.
9. For mappings: `preview` → `publish --dry-run` → `publish --label TEST` → real label.
10. Verify the snippet in Dev Mode before reporting a publish as done.

## Requirements

- A Figma personal access token with **File content: Read** (design reads).
- Add **Code Connect: Write** only to publish mappings — the CLI needs **both** scopes, and a
  one-scope token authenticates fine against `/v1/me` while failing the CLI with a 403.
- Node 18+ for the CLI, run via `npx @figma/code-connect@latest` (no global install needed).
- An Organization or Enterprise plan with a Dev or Full seat for Code Connect.
- Live `figma connect ... --help` is authoritative when it differs from remembered syntax.

## Fast start

Copy the shared template, then fill in *your* token. `.env.example` is committed (placeholders
only); `.env` is yours alone (gitignored):

```bash
cp .env.example .env        # then edit .env:
#   FIGMA_ACCESS_TOKEN=figd_…   (Figma → Settings → Security → Personal access tokens)
#   FIGMA_FILE_KEY=…            (the …/design/<FILE_KEY>/… segment of a Figma URL)

set -a; . ./.env; set +a
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" https://api.figma.com/v1/me   # 200 = connected
```

*(On Windows/PowerShell, see the "Windows note" in the reference for the `.env` load equivalent.)*

## Safety model

The workflow reads before it writes and targets stable file keys and node IDs. REST GETs and
`preview`/`parse` are read-only and run directly. Anything that changes what teammates see —
`publish`, `unpublish`, `migrate`, or posting a comment — is stated first and waits for approval,
and is tested under a disposable `--label` before the real one.

The token stays in `.env` only. It is sent in the `X-Figma-Token` header or `FIGMA_ACCESS_TOKEN`
and is never printed, logged, or placed on a command line, where `--token` would leak it into
shell history. A token pasted into a chat is compromised — rotate it.

## Files

- [SKILL.md](SKILL.md) — complete routing, workflow, safety, and verification instructions.
- [Official Figma CLI + REST reference](references/figma-cli.md) — install, auth, config schema,
  every command and flag, the authoring API, the REST read toolkit, and a troubleshooting table.
- [`scripts/extract_visible_text.js`](scripts/extract_visible_text.js) — the design-text extractor
  (same runner-script pattern as `run_api.js` / `run_db.js` / `ask_kb.js`). Pulls only
  **effectively-visible** TEXT layers, so hidden layers never become fabricated requirements:
  `node scripts/extract_visible_text.js --file <FILE_KEY> --node <NODE_ID> [--per-frame]`.
- [`scripts/extract_visible_text.test.js`](scripts/extract_visible_text.test.js) — regression test
  that **imports** the extractor above (plain `assert`, no framework, no dependency — matching
  `ask_kb.test.js`). Run `node skills/figma-integration/scripts/extract_visible_text.test.js`
  after touching the extractor.

## Boundaries

This skill reads designs and syncs component mappings. **Editing or creating Figma content is out
of scope.** It is the producer at the front of the QA pipeline: it emits the handoff block and
hands off to [`test-design`](../test-design/), [`task-estimation`](../task-estimation/), or
[`browser-testing`](../browser-testing/) — it does not write to Azure DevOps itself.
