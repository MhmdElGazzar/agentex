# Figma API — plumbing reference for ui-check baselines

Stable know-how for `fetch_baseline.js` and for anyone debugging it. The runner already
implements all of this; read here when it misbehaves or when you need to reason about a
Figma URL, a variant set, or a form-factor call.

## Endpoints & auth

| Call | Purpose |
|---|---|
| `GET /v1/me` | Token sanity check (manual troubleshooting only — the runner skips it) |
| `GET /v1/files/<fileKey>/nodes?ids=<id>` | Node metadata: name, type, `absoluteBoundingBox`, children |
| `GET /v1/images/<fileKey>?ids=<id>&format=png[&scale=N]` | Render a node to PNG; returns `{ err, images: { "<id>": "<url>" } }` |

- Base URL `https://api.figma.com`. Auth is the **`X-Figma-Token`** header — a personal
  access token, resolved from the env var named in `config/project.json`
  (`figma.token.envSecret`, conventionally `FIGMA_TOKEN`). Never on a command line,
  never in logs or JSON output.
- **Render URLs are short-lived** (S3-style presigned, expire within ~14 days but treat
  them as minutes): download **immediately**, store only the downloaded file, never the
  URL. The download request carries **no token** — the render host is not the Figma API.
- `scale` is 1–4; use `--scale 2` when fine detail matters in the vision pass.

## Node-id formats & URL extraction

- API form: `123:456`. URL form: `123-456` (in the `node-id` query parameter, sometimes
  URL-encoded as `123%3A456`). Normalize URL form → API form by replacing the single `-`
  with `:` on ids matching `^\d+-\d+$`.
- Frame URLs: `https://www.figma.com/<file|design|proto|board>/<fileKey>/<name>?node-id=<id>…`
  — the file key is the path segment after `file`/`design`/`proto`/`board`.
- A URL whose file key differs from the configured `figma.fileKey` is **never silently
  used** — the runner blocks with `fileKeyMismatch: true`; raise it with the user.

## Variants & component sets

- A `COMPONENT_SET` node's children are its variants; `SECTION` and `CANVAS` (page)
  nodes also group whole design frames. For these containers the runner returns
  `variants: [{id, name, width, height}, …]` (children of type `FRAME`/`COMPONENT` with
  a bounding box) so the variant gate can enumerate candidates. A plain `FRAME` is
  itself the design — its children are content, not variants.
- **Visibility/opacity inherit down the node tree**: a child with `visible: true` still
  doesn't render when an ancestor is hidden or has opacity 0. Trust the rendered PNG
  over per-node properties when they disagree.
- Renders of a whole set/section are for orientation only — after picking a variant,
  re-run the runner with the variant's own id so the baseline is that frame alone.

## Form-factor inference (baseline side)

Combine frame **width** with **name cues**; name wins when they disagree, and an
uncertain call goes through the variant/stop-and-ask rules, never a silent guess.

| Class | Width band (logical px) | Typical name cues |
|---|---|---|
| mobile | ≤ 480 | "Mobile", "iPhone", "Android", "sm" |
| tablet | 481–1024 | "Tablet", "iPad", "md" |
| desktop | ≥ 1025 | "Desktop", "Web", "lg", "xl" |

Named-viewport plugin defaults (overridable via `config/project.json` `"viewports"`):
**desktop 1440×900 · tablet 768×1024 · mobile 390×844.**

## Troubleshooting

| Symptom | Meaning |
|---|---|
| HTTP 403 | Token invalid/expired, or lacks file access — check `FIGMA_TOKEN` and its scopes |
| HTTP 404 | Wrong file key or node id (check URL-form vs API-form id) |
| `images` returns `null` URL / `err` | Node can't be rendered (deleted, empty, or not renderable) — BLOCKED, not improvised |
| Downloaded PNG fails validation | Truncated/expired render URL — re-run the runner (it re-renders) |
| 429 | Rate limited — wait and re-run; don't loop tightly |
