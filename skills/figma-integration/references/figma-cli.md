# Tool: figma (`@figma/code-connect`)

Figma's official CLI — the **Code Connect** tool — **and** the Figma REST read recipes.
Official docs: https://developers.figma.com/docs/code-connect/  ·  Verified live via `npx`.

> ## ⏩ Start here — which half do you need?
> | Your task | Go to | Needs |
> |---|---|---|
> | **Read a design** — text→stories, specs, PNG baseline, design-vs-build (**the everyday path**) | **[§Read designs via the Figma REST API](#read-designs-via-the-figma-rest-api-verified-live)** | File-Read token only |
> | Sync a **published component library** to code for Dev Mode (rarer) | §Preflight & install → §Commands | Org/Enterprise + both scopes |
>
> The CLI sections come first below only because they're the file's original subject — **most tasks
> want the REST section.** If the target is a screen or frame rather than a published Component,
> skip straight to it.

> **There is only one official Figma CLI.** The binary is `figma`, shipped in the npm package
> `@figma/code-connect`, and `connect` is its only command family (`figma --help` lists just
> `connect` and `help`). There is no `@figma/cli` package and no `developers.figma.com/docs/cli`
> page — both 404. The `figma-cli` package on npm is an unrelated third-party tool from 2019; do
> not install it. Design *reads* are not a CLI feature at all — they go through the REST API
> (see §Read designs via the Figma REST API).

> Note: Code Connect maps Figma **components ↔ code snippets** so they show in Dev Mode. It is a
> design-system / dev-handoff tool, not a browser test runner — it does not execute app tests.
> **Per Figma's CLI reference, the CLI cannot read, export, or retrieve designs or images at all**;
> it only manages component↔code connections. Every design read in this skill (text, specs, PNG
> renders) is therefore a **REST** job — see §Read designs via the Figma REST API. A design-vs-build
> comparison needs REST for the design side and `playwright-cli` for the build side; the Figma CLI
> plays no part in it.

## Preflight & install
- Preflight: `npx --yes @figma/code-connect@latest --version` (no global install needed) and
  `figma connect --help`.
- Node **18+** required. Two ways to run:
  - **No install (recommended):** `npx @figma/code-connect@latest connect <command> …`
  - **Global:** `npm install --global @figma/code-connect@latest`, then `figma connect <command> …`
- Verify: `figma connect --help` (or the `npx …` form).

## Auth
- Create a **personal access token** at Figma → Settings → Security → Personal access tokens,
  with scopes: **Code Connect = Write**, **File content = Read**.
- The CLI reads it from **`FIGMA_ACCESS_TOKEN`** (or `--token <t>`; prefer the env var — never put
  the token on the command line). Keep values in `.env` (gitignored): `FIGMA_ACCESS_TOKEN`,
  and optionally `FIGMA_FILE_KEY` for the file you work against. Load with `set -a; . ./.env; set +a`.
- Token scopes matter: `publish`/`unpublish` need Code Connect **Write**; reads need File **Read**.

## Config — `figma.config.json`
The CLI auto-discovers `figma.config.json` (or pass `-c/--config`). `publish`/`unpublish`/`parse`
use the `include`/`exclude` globs to find files; with no config it parses the current directory (or
`--dir`).
```json
{
  "codeConnect": {
    "include": ["src/**/*.figma.tsx"],
    "exclude": ["**/node_modules/**", "**/*.stories.tsx"],
    "parser": "react",
    "label": "React",
    "importPaths": { "src/components/*": "@ui/components" }
  }
}
```
**Full field list** (from the official config-file doc — the CLI auto-detects most of these, so
set a field only to override):

| Field | Values / type | Default |
|---|---|---|
| `include` / `exclude` | globs for where to parse Code Connect files | — |
| `parser` | `react` · `html` · `swift` · `compose` · `custom` (see §Custom parsers) | auto-detected from project files |
| `label` | string — groups a set of mappings; the `-l/--label` flag targets it | the project type (`React`, `Angular`, `Vue`, `Web Components`) |
| `language` | syntax highlighting: `tsx` `jsx` `typescript` `javascript` `swift` `kotlin` `html` `css` `python` `go` `ruby` `rust` `bash` `sql` `json` `xml` `graphql` `cpp` `dart` `plaintext` | inferred from `parser` |
| `documentUrlSubstitutions` | object — rewrite Figma node URLs at parse/publish time | — |
| `defaultBranch` | string — branch used for source-code links | auto-detected |
| `interactiveSetupFigmaFileUrl` | string — file used by interactive setup | — |
| `parserCommand` | string — command invoking your own parser (`node ./scripts/parser.js`). Required when `parser` is `custom` | — |

React-specific: `importPaths` (glob → import path, rewrites the import shown in Dev Mode),
`paths` (tsconfig-style alias resolution), `imports` (hand-written import lines, overriding the
generated ones).
SwiftUI-specific: `xcodeprojPath`, `swiftPackagePath`, `sourcePackagesPath`, `importMapping`.

Supported frameworks: React/React Native, HTML/Web Components (Angular, Vue), SwiftUI, Jetpack
Compose — plus any language via framework-agnostic template files.
- **TypeScript repos** — add the Code Connect type defs to `tsconfig.json` so template files get
  autocomplete on `figma.*` / the `instance.get*` accessors:
  ```json
  { "compilerOptions": { "types": ["@figma/code-connect/figma-types"] } }
  ```

## Commands
Verified against the live CLI. Common flags on the file-scanning commands (`publish`/`unpublish`/
`parse`): `-r/--dir <dir>`, `-f/--file <files…>`, `-c/--config <path>`, `--dry-run`,
`--exit-on-unreadable-files` (use in CI).

- **Scaffold a mapping — `figma connect create <FIGMA_NODE_URL>`**  (read-then-write-file)
  Generates a boilerplate `.figma.ts` with the component's prop accessors. Output location:
  **`-o/--outDir <dir>`** (defaults to the current directory). **Fetches the node from Figma →
  needs the token with BOTH scopes.**
- **Preview — `figma connect preview [files…]`**  (read-only)
  Renders snippets as the Figma inspect panel shows them; validates syntax (Prettier). Safe anytime.
  Takes files as a **positional argument** (`preview Button.figma.tsx`; empty = preview all) — it
  has no `-f/--file` *flag*, unlike the other scanning commands. Also `-r/--dir`, `-c/--config`,
  and `--output table|json` (default `table`; use `json` to feed another tool).
- **Parse — `figma connect parse [--outFile <file>]`**  (read-only)
  Emits the JSON representation of the Code Connect files (stdout by default) for debugging/tooling.
- **Publish — `figma connect publish` (WRITE — confirm first)**
  Scans `include`/`exclude` for `.figma.ts`/`.figma.js`, publishes them to Dev Mode. Flags:
  `-l/--label <l>`, `--force` (overwrite UI-created mappings), `--skip-validation`,
  `-b/--batch-size <n>` (chunk large uploads).
- **Unpublish — `figma connect unpublish` (WRITE — confirm first)**
  Removes connections. Either by dir/file (matches config), **or** target one:
  `--node <NODE_URL> --label <l>` (`--label` is required with `--node`).

### ⚠️ The two ways to damage other people's work
Both change what the whole team sees. Confirm explicitly and prefer `--dry-run` first:
- **`unpublish` with no `--node`** removes **every** connection matched by the config — the
  easiest way to wipe a team's mappings by accident. Always scope it with `--node` + `--label`
  unless a full teardown is genuinely intended.
- **`publish --force`** overwrites mappings other people authored in the **Code Connect UI**
  inside Figma. Only use it once the user confirms the repo is the source of truth — their UI
  work is not recoverable from the repo.
- **Migrate — `figma connect migrate` (WRITE)**
  Converts **legacy parser-based** `.figma.tsx` (uses `figma.connect()`) → **template-based**
  `.figma.ts` (the newer format, see "Two authoring modes" below). Flags: `--outDir <dir>`,
  `--javascript` (emit `.figma.js`), `--batch auto|all|none`, `--include-props`.
  Migration output is a **starting point, not finished** — commit first, write to `--outDir` (keep
  originals), then review for: `getPropertyValue()` string comparisons (usually → `getBoolean`/
  `getEnum`); verbose if/else from variant restrictions (often → a ternary on `example`/`imports`);
  and unnecessary `figma.helpers.*` (drop when a prop's type is known). Verify equivalence with
  `parse --file <path>` before/after; delete originals only once the new files parse.

Global flags (all commands): `-t/--token <t>` (defaults to `FIGMA_ACCESS_TOKEN`), `-v/--verbose`,
`-a/--api-url <url>` (custom API base), `--skip-update-check`, `-V/--version`, `-h/--help`.

## Prerequisites for Code Connect (both authoring modes)
Before publishing any mapping, all of these must hold — otherwise you hit a wall the commands
don't explain:
- **Figma plan/seat:** Code Connect is available on a **Dev or Full seat** on the **Organization**
  and **Enterprise** plans. **Not available on Free or Professional** — publish will fail
  regardless of token/scopes. A Viewer seat on a qualifying plan is also not enough.
- **Published Components:** the node must be a real Figma **Component** *published to a team
  library* (a plain frame/section can't be mapped).
- **Token:** the CLI path needs **both** scopes (see gotcha below). The MCP path uses your Figma
  MCP session instead of a token.

## Two Code Connect authoring modes
There are **two** ways to author mappings — pick by what's available:

| Mode | Files | How | Prefer when |
|---|---|---|---|
| **A. CLI / parser** | `.figma.tsx` using `figma.connect()`, `figma.string()`, `figma.enum()`… | author locally → `figma connect publish` | **CI / no MCP**, or a repo of `.figma.tsx` already exists |
| **B. MCP / template** | `.figma.ts` template files, or mappings saved straight to Figma | the **Figma MCP** tools (below) fetch component context and save mappings | **an MCP server is available** (the newer, Figma-recommended path) |

**Decision rule:** *Figma MCP server available → prefer templates (Mode B). CI or no MCP →
parser + CLI (Mode A).* The CLI sections in this file cover Mode A; the rest of this section
covers Mode B.

Figma now files the framework-specific React/HTML/SwiftUI/Compose integrations under **Legacy
Integration Guides** and describes template files as the format it is actively investing in.
**Default to template files for anything new**; reach for the legacy parser API only when an
established codebase already uses it and the user doesn't want to migrate yet.

**Where to start:** most of the value comes from connecting a handful of high-traffic components
(Button, Input, Card) — not exhaustive coverage. Say so when a user asks how to scope the work.
A non-technical team with no repo access should use the **Code Connect UI** inside Figma instead
of this CLI.

### Mode B — Figma MCP tools (template-based, no local CLI)
When a `figma` MCP server is connected, these tools do Code Connect without the CLI or a token:
- `list_file_components_for_code_connect` (fileKey) — every published component in a file + its
  dependency graph, for planning mappings in bulk.
- `get_code_connect_suggestions` (nodeId, fileKey) — AI-suggested code↔design links to review.
- `get_context_for_code_connect` (nodeId, fileKey) — a component's properties, variants, and
  descendant tree — the input for a template file.
- `get_code_connect_map` (nodeId, fileKey) — read existing mappings (`{nodeId: {src, name}}`).
- `add_code_connect_map` / `send_code_connect_mappings` — **WRITE** the mapping(s) to Figma
  (single or bulk). Confirm with the user first, same as `publish`.

**Template file shape** (`.figma.ts`, Mode B) differs from the parser API — it fetches context at
author time via `figma.selectedInstance` and getters:
```ts
// url=https://www.figma.com/design/<FILE_KEY>/File?node-id=123-456
// source=src/components/Button.tsx
// component=Button
import figma from 'figma'
const instance = figma.selectedInstance
export default {
  example: figma.code`<Button
    variant=${instance.getEnum('Variant', { Primary: 'primary', Secondary: 'secondary' })}
    disabled=${instance.getBoolean('Disabled')}
  >${instance.getString('Label')}</Button>`,
  imports: ["import { Button } from '@ui/button'"],
  id: 'button',
  metadata: { nestable: true },
}
```
**Metadata comments** sit at the very top. `url` is **required** — it names the Figma component the
template publishes to (get it via right-click → *Copy link to selection*). `source` (code path) and
`component` (code component name) are optional and only surface in Figma's UI.

**Export fields:** `example` (the snippet) · `imports` (rendered above the snippet; **hoisted and
deduplicated** when templates nest) · `id` (identifies this template so others can reference it) ·
`metadata.nestable` (when `false`, a nested instance renders as a clickable link instead of
expanding inline).

**Template getters:** `getString` · `getBoolean('Name', { true:…, false:… })` · `getEnum` ·
`getInstanceSwap` · `getSlot` · `findInstance` · `findConnectedInstances`. `getEnum` is where
design↔code naming drift gets reconciled — it maps Figma's human-facing variant values onto code
values. (Parser mode A uses the `figma.string()/boolean()/enum()` helpers in the authoring section
below instead.)

## ⚠️ Token scopes — the #1 gotcha for the CLI path (verified live)
The CLI needs **BOTH** scopes on the token, even for `create`:
- **File content → Read**  AND  **Code Connect → Write**

A token with only one scope authenticates fine for REST (`/v1/me` → 200) but the CLI fails with:
`Failed to get node data from Figma (403): Invalid scope(s): Please ensure that you have selected
both the File Read scope and the Code Connect Write scope`. A REST file-read 404 (not 403) is the
*other* symptom of a missing File Read scope. Fix: regenerate the token with both scopes checked.

## Authoring a mapping — the `.figma.ts` file
`create` scaffolds one, but you often hand-write it. Structure (React example):
```ts
import figma from '@figma/code-connect'
import { Button } from './Button'   // your real code component

figma.connect(Button, 'https://www.figma.com/design/<FILE_KEY>/x?node-id=<NODE_ID>', {
  props: {
    label:    figma.string('Label'),                 // Figma text prop  -> string
    disabled: figma.boolean('Disabled'),             // Figma boolean prop
    variant:  figma.enum('Variant', {                // Figma variant     -> code values
      Primary: 'primary', Secondary: 'secondary',
    }),
    icon:     figma.instance('Icon'),                // nested component instance
  },
  example: ({ label, disabled, variant, icon }) => (
    <Button disabled={disabled} variant={variant} icon={icon}>{label}</Button>
  ),
})
```
- First arg = the **imported code component** (drives the import statement shown in Dev Mode).
- Use the **dash** node-id form here, exactly as copied from the Figma URL (`11073-1898`) — see
  §NODE_ID for how the REST API keys the *response* differently.
- The node must be a real Figma **Component** (not a plain frame) for Dev Mode to attach the snippet.

### Prop helpers (map Figma properties → code)
| Helper | Maps |
|---|---|
| `figma.string('Prop')` | a text property → string |
| `figma.boolean('Prop', {true:…, false:…})` | a boolean property (optional value map) |
| `figma.enum('Prop', { VariantA: …, VariantB: … })` | a variant property → code values |
| `figma.instance('Prop')` | a nested component instance → its own connected snippet |
| `figma.textContent('Layer')` | a child text layer's content |
| `figma.children('Layer')` · `figma.children(['A','B'])` · `figma.children('Icon*')` | render child instances by layer name (wildcards allowed) |
| `figma.nestedProps('Layer', { size: figma.enum(…) })` | props of a nested instance **without** connecting it |
| `figma.className([ 'base', figma.enum(…), figma.boolean(…) ])` | concatenate class strings, dropping undefined |

### Variant restrictions (one Figma component → many code components)
Use multiple `figma.connect` calls with a `variant` filter so each variant maps to a different
code component:
```ts
figma.connect(PrimaryButton,   'https://…', { variant: { Type: 'Primary' },   example: () => <PrimaryButton/> })
figma.connect(SecondaryButton, 'https://…', { variant: { Type: 'Secondary' }, example: () => <SecondaryButton/> })
figma.connect(DangerButton,    'https://…', { variant: { Type: 'Danger', Disabled: true }, example: () => <DangerButton/> })
```
This is Code Connect's **one-to-many** mapping. CLI-published connections appear in the Figma UI
but are **editable only via the CLI** (not in the UI).

### The `figma.code` array rule (the #1 authoring footgun)
Snippets **look like strings but are arrays underneath** (so Figma can render prop pills + inline
errors). **Never concatenate them with `+`** — always compose inside a `figma.code` template:
```ts
figma.code`<MyExample/>` + iconSnippet                 // ❌ wrong — collapses the structure
figma.code`<MyExample/>${showIcon ? iconSnippet : null}` // ✅ right
```

### Nested content — slot vs inline
- `figma.getSlot('Content')` (template) / `figma.children('Content')` (parser) — for **freeform/
  varied** children. Renders as a clickable label in Dev Mode; the Figma MCP can traverse into it.
- `findConnectedInstances()` — when **every child is the same connected component** and the full
  code should **expand inline** (e.g. a `<Select>` of list items):
  ```ts
  const options = instance.findConnectedInstances((n) => n.hasCodeConnect())
    .map((child) => child.executeTemplate().example)
  const example = figma.code`<Select>${options}</Select>`
  ```
  Optional 2nd arg: `{ traverseInstances: true }` to recurse, `{ path: string[] }` to restrict by
  layer position. `metadata.nestable: false` makes a nested instance render as a link, not inline.

### Batch files (many components, one code shape — e.g. icon sets)
For large uniform sets, use a **batch** rather than one file per component:
`*.figma.batch.ts` (the shared template) + `*.figma.batch.json` (the per-node data). **Add
`**/*.figma.batch.json` to the config `include`** — a missing glob is the most common reason a
batch silently doesn't publish. Full schema: the batch-files doc (linked at the bottom).

## Typical workflow (test under a throwaway label first)
Publish under a **disposable label** so a mistake is invisible to the team and removable with one
`unpublish` — then switch to the real label.
```bash
set -a; . ./.env; set +a                                   # load FIGMA_ACCESS_TOKEN (both scopes)
figma connect create "<NODE_URL>" --outDir src/components   # scaffold a .figma.ts (errors if file exists)
# …edit: import your component, map props, write the example…
figma connect preview src/components/Button.figma.ts        # read-only: see the Dev Mode snippet
figma connect publish --label TEST --dry-run                # validate, publish nothing
figma connect publish --label TEST                          # ship under a throwaway label; verify in Dev Mode
figma connect publish --label React                         # WRITE (confirm) → live for the team
```
Publishing prints component names + node URLs — surface those links to the user.

## Read designs via the Figma REST API (verified live)
This is the **workhorse for QA/requirements** — the Code Connect CLI authors mappings but cannot
*read* a design. Reads need only the **File content: Read** scope (not Code Connect Write), so they
work even when the CLI is blocked. Same token in the `X-Figma-Token` header, base
`https://api.figma.com/v1`.

> **REST vs the Figma MCP for *reading* — they return different things.** The Figma MCP
> (`get_metadata`, `get_screenshot`) gives the layer **structure** and a **screenshot** — great for
> frame names and a visual baseline, and it needs no token (just the connector). But it does **not**
> return the **TEXT-layer characters** (button labels, validation copy, error messages) — the exact
> on-screen words that become requirements. For those, use the **REST `/nodes` + TEXT extraction**
> below (needs `FIGMA_ACCESS_TOKEN`). Rule of thumb: **MCP for structure/visual, REST for the copy.**
> Also: `get_metadata` on a whole feature/section can be huge (overflows the token limit) — read a
> single frame with `?depth=N` or `/nodes?ids=` instead of the whole node.

**Parse the Figma URL first** (both values come from it):
`https://figma.com/design/`**`<FILE_KEY>`**`/Name?node-id=`**`<NODE-ID>`**
- **FILE_KEY** = the segment right after `/design/`.
- **NODE_ID** = the `node-id` query param. The URL uses a **dash** (`11073-1898`); the REST API keys
  its response by **colon** (`11073:1898`).
  **Verified against the live API:** `/nodes?ids=` accepts **either** form — both return identical
  data, so the dash is *not* rejected. What matters is the **response shape**: the `nodes` object is
  always keyed by the **colon** form, so `json.nodes["11073-1898"]` is `undefined` even though the
  request succeeded. Index with the colon, or use `Object.values(json.nodes)[0]` (what the snippets
  below do) and the question disappears. The dash form is what `figma.connect()` URLs take.

### Discovery — teams → projects → files (there is no "list all files" endpoint)
```bash
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/teams/<TEAM_ID>/projects"      # projects in a team
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/projects/<PROJECT_ID>/files"   # files in a project
```
`<TEAM_ID>` = the number in a team URL (`figma.com/files/team/<TEAM_ID>/…`). You **must** name a
team or file — the API cannot enumerate your teams from the token alone.

### Read a file or a single node
```bash
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>?depth=1"       # cheap existence/perms check — the standard file endpoint (prefer this for the connection check)
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/meta"          # file metadata only (name/folder/creator) — real endpoint, but a distinct/lighter shape
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>?depth=2"       # pages + top-level frames (shallow = fast)
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/nodes?ids=<NODE:ID>"  # ONE node/frame subtree (best for a single screen)
```
Use `?depth=N` to avoid pulling a whole huge file; use `/nodes?ids=` when you only need one screen.
`<FILE_KEY>` = the `…/design/<FILE_KEY>/…` segment of a Figma URL.

### The useful sub-resources
```bash
.../files/<FILE_KEY>/components   # published Components (Code Connect targets; empty on plain-frame files)
.../files/<FILE_KEY>/styles       # color / text / effect styles (design tokens)
.../files/<FILE_KEY>/comments     # design feedback (read as requirements)  · POST to add a comment
.../images/<FILE_KEY>?ids=<NODE:ID>&format=png&scale=2   # render a frame → PNG URL (design reference for a screenshot diff)
```
The `/images` response is a JSON `{ images: { "<node>": "<url>" } }`; the URL is **short-lived
(~30 min)** — download it immediately, don't store the link.

### Extracting requirements from a design (the pattern used in practice)
To turn a screen into user stories / test conditions, read the node and pull its **TEXT** layers
(the words are the requirements). The node-id may be passed in either form here — the snippet reads
`Object.values(...)[0]`, so the dash/colon response-keying (see NODE_ID above) never bites.
**Prefer the bundled runner** — it is the tested implementation of everything below
(`scripts/extract_visible_text.test.js` imports it, so the logic and its test cannot drift):
```bash
set -a; . ./.env; set +a
node ${CLAUDE_PLUGIN_ROOT}/skills/figma-integration/scripts/extract_visible_text.js \
  --file <FILE_KEY> --node <NODE_ID>            # one screen
node ${CLAUDE_PLUGIN_ROOT}/skills/figma-integration/scripts/extract_visible_text.js \
  --file <FILE_KEY> --node <NODE_ID> --per-frame  # a SECTION → one group per child frame
```
Reads `FIGMA_ACCESS_TOKEN` from the env, accepts the node-id in **either** dash or colon form, and
exits `2` with a `BLOCKED:` line on a missing token or an API error. Pipe a saved response with
`--stdin` to re-extract without re-hitting the API.

The inline snippets below are the same logic, kept for when the plugin scripts aren't reachable
(a bare `curl` shell) or you need to adapt the walk. Example — collect all **effectively visible**
text under a node:
```bash
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/nodes?ids=<NODE:ID>" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const doc=Object.values(JSON.parse(d).nodes)[0].document, out=[];
  (function w(n,vis,op){
    const v = n.visible===false ? false : vis;               // visible:false hides the subtree
    const o = (n.opacity===undefined ? 1 : n.opacity) * op;  // opacity is INHERITED — multiply down
    if(v && o > 0 && n.type==="TEXT" && n.characters) out.push(n.characters.replace(/\s+/g," ").trim());
    (n.children||[]).forEach(c=>w(c,v,o));
  })(doc,true,1);
  console.log(doc.name+" — "+out.length+" visible text layers"); out.forEach(t=>t&&console.log("  • "+t));
});'
```
> ⚠️ **Hidden text is not a requirement.** A Figma file routinely carries text that never renders —
> deprecated states, alternate variants, layers parked at `opacity: 0`. Extracting them fabricates
> requirements, and `test-design` will faithfully turn each one into a real Test Case.
> **Check both conditions:** a node can have `visible: true` while inheriting `opacity: 0` from an
> ancestor, so a `visible === false` check **alone silently misses it**. Multiply `opacity` down the
> tree as above, and treat only effectively-visible text as a requirement.
Raw Dev Mode CSS is **not** a good story/requirement source — it's positions and shapes with no
actions or labels. Read TEXT layers via REST instead.

**A SECTION or multi-frame node → one story per frame (don't flatten).** The snippet above walks a
single node; if the link points at a **SECTION** (or any node holding several screens), iterate its
top-level children so each frame becomes its own story instead of one undifferentiated dump:
```bash
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" "https://api.figma.com/v1/files/<FILE_KEY>/nodes?ids=<NODE:ID>" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const root=Object.values(JSON.parse(d).nodes)[0].document;
  // a SECTION/holder → one story per child frame; a single frame → just itself
  const frames = (root.type==="SECTION"||(root.children||[]).some(c=>c.type==="FRAME"))
    ? (root.children||[]).filter(c=>["FRAME","COMPONENT","INSTANCE"].includes(c.type)) : [root];
  for (const f of frames){
    const out=[]; (function w(n,vis,op){                       // same visibility guard as above
      const v = n.visible===false ? false : vis;
      const o = (n.opacity===undefined ? 1 : n.opacity) * op;
      if(v && o > 0 && n.type==="TEXT" && n.characters) out.push(n.characters.replace(/\s+/g," ").trim());
      (n.children||[]).forEach(c=>w(c,v,o));
    })(f,true,1);
    console.log("\n## "+f.name+"  ("+out.length+" visible text layers)"); out.forEach(t=>t&&console.log("  • "+t));
  }
});'
```
Feature-level links (a whole section) are the normal sprint-planning input — this gives you one
`Description → User Story → Test Conditions` block per screen.

> **Windows note:** the `set -a; . ./.env; set +a` loader is **bash** (use the Bash tool). In
> **PowerShell**, load `.env` and call the API like this:
> ```powershell
> Get-Content .env | ? {$_ -match '^\s*[^#].*='} | % { $k,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($k.Trim(),$v.Trim()) }
> curl.exe -s -H "X-Figma-Token: $env:FIGMA_ACCESS_TOKEN" https://api.figma.com/v1/me
> ```
>
> **Windows `/tmp` trap.** Piping `curl -o /tmp/x.json` then `node -e 'require("/tmp/x.json")'`
> **fails** on Windows even under the Bash tool: bash resolves `/tmp` to the Git-Bash mount, but
> Node resolves it against the current drive → `MODULE_NOT_FOUND: D:\tmp\x.json`. Either pipe
> straight into node (`curl … | node -e '…process.stdin…'`, as the snippets below do) or write to a
> real Windows-style path and pass it as `process.argv`.

> **A read-scoped token still reads everything here.** REST needs only File-Read; only the CLI
> demands both scopes (§Token scopes). A `403 Invalid scope(s)` from `figma connect` while these
> REST calls return `200` is the expected, correct split — not a broken setup.

### When to use REST vs the Code Connect CLI
| Goal | Use |
|---|---|
| Read a design's text/specs → user stories, test conditions, design-vs-build checks | **REST** (this section) |
| Render a frame as a reference image for a screenshot diff | **REST** `/images` |
| Keep a **component library** in sync with code in Dev Mode | **Code Connect CLI** (needs real Components **and** both token scopes) |

App-screen files (frames/sections, 0 published Components) are a REST job, not a Code Connect job.

## Custom parsers
When the built-in parsers don't fit — component metadata lives in a sidecar file, the language
isn't recognised, or mappings are generated from something other than source files — point the CLI
at your own parser. Set `parser: "custom"` + `parserCommand`; `publish`, `parse`, and `create` then
delegate to that command instead of parsing files themselves:
```json
{
  "codeConnect": {
    "parser": "custom",
    "parserCommand": "node ./scripts/my-parser.js",
    "include": ["src/**/*.ts"],
    "exclude": ["**/*.test.ts"]
  }
}
```
The handshake: the CLI collects `include` minus `exclude`, runs `parserCommand` passing a
`ParseRequestPayload` on **stdin**; your parser writes a `ParseResponsePayload` to **stdout**
holding Code Connect documents built with the Template API; `publish` then sends those to Figma.
(`create` uses `CreateRequestPayload`/`CreateResponsePayload` the same way.)

Two things to get right, or failures pass silently:
- Return `WARNING`/`ERROR` **in the response payload** rather than printing them loosely — the CLI
  decides whether to proceed based on those messages.
- **Exit non-zero on failure.** A broken parse that exits `0` publishes silently.

Always test with `parse` before ever running `publish`.

## CI/CD
Publish from CI on merges to the default branch so mappings never drift from the code. Pass
`--exit-on-unreadable-files` so a malformed template **fails the build** instead of silently
publishing a partial set, and supply the token as a secret via `FIGMA_ACCESS_TOKEN` (never
`--token`, which lands in CI logs).

## Troubleshooting (Code Connect CLI)
| Symptom | Likely cause / fix |
|---|---|
| File ignored on publish | `include` glob doesn't match the extension — check `.figma.ts` vs `.figma.js` vs `.figma.batch.json` |
| 403 on publish/create | Token missing **Code Connect: Write** or **File content: Read** scope (see gotcha above) |
| Snippet renders but props are blank | Property name in `getString`/`getEnum`/`figma.string` doesn't match Figma's exactly — **case- and space-sensitive** |
| Nested component shows as a link, not inline code | `metadata.nestable` is `false` on the child template (or you used a slot, not `findConnectedInstances`) |
| `create` exits with an error | Target file already exists — edit it, or pass `--outDir` |
| Snippet structure looks mangled | String concatenation on a snippet — wrap in `figma.code` (see the array-rule) |
| `publish` succeeds but nothing in Dev Mode | Wrong `--label`, or the node isn't a **published** Component, or the plan lacks Code Connect |

## Rules
- Preflight `figma connect --help` (via `npx`) before use; the CLI is npm-based — **not** a
  standalone binary and **not** installed by default.
- **Never print or log the token** — pass it via `FIGMA_ACCESS_TOKEN` from `.env`; do not echo it
  or put it in argv (`--token` on a shared shell leaks it into history).
- Default to read-only (`preview`, `parse`, REST GETs). Confirm with the user before any
  **publish / unpublish / migrate** — these change what teammates see in Figma Dev Mode.
- In CI, use `--exit-on-unreadable-files` and the `FIGMA_ACCESS_TOKEN` env var (never hardcode).
- `--help` on any subcommand is authoritative for the installed version — flags change between
  releases. When a task goes past this reference (full template API, batch schema, custom parsers),
  fetch the relevant page below rather than guessing.

## Official docs
- Quickstart: https://developers.figma.com/docs/code-connect/quickstart-guide/
- CLI reference: https://developers.figma.com/docs/code-connect/cli-reference/
- Template files: https://developers.figma.com/docs/code-connect/template-files/
- Template API: https://developers.figma.com/docs/code-connect/template-api/
- Batch files: https://developers.figma.com/docs/code-connect/batch-files/
- Custom parsers: https://developers.figma.com/docs/code-connect/custom-parsers/
- Config file: https://developers.figma.com/docs/code-connect/api/config-file/
