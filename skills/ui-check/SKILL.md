---
name: ui-check
description: >
  Execute ui-check: steps in test specs — compare the live page currently open in the
  browser under test against a declared design baseline: a Figma frame (identifier only;
  file + token configured once per project) or a screenshot image, in exact mode (every
  visible detail) or reference mode (only enumerated details can fail). Triggers on spec
  steps starting with "ui-check:", or requests like "check this page against the design",
  "compare with the Figma frame", "does the screen match the mockup". Baselines are
  resolved by the bundled fetch_baseline.js runner — an unresolvable baseline is BLOCKED,
  never improvised; the comparison verdict itself is agent-vision judgment.
---

# UI Check — design conformance inside test specs

Lets a scenario assert "this screen matches the approved design" as an executed,
evidenced step. **Mechanics live in the bundled runner** (Figma access, image
validation, the BLOCKED gate); **the verdict is yours** — a vision comparison under the
protocol below. No pixel-diff threshold decides anything, ever.

## Step syntax in test specs

```
ui-check: figma <node-id | frame URL> — mode: exact|reference [ — viewport: desktop|tablet|mobile|<W>x<H> ]
ui-check: image <path> — mode: exact|reference [ — viewport: ... ]
```

`reference`-mode enumerated details are the sub-bullets under the step (or explicitly
referenced adjacent spec text):

```
ui-check: figma 123:456 — mode: reference
  - must: primary CTA reads "Pay now" and is enabled
  - must: order summary shows 3 line items with a total row
```

Both bare node-ids (`123:456`, URL-style `123-456`) and full Figma frame URLs are valid
identifiers. The comparison target is always **the page as the scenario left it** at the
point the step appears — no extra navigation.

## Execution flow per step

### 1. Resolve the baseline (runner — deterministic)

```
node ${CLAUDE_PLUGIN_ROOT}/skills/ui-check/scripts/fetch_baseline.js \
  --source figma --id <node-id | frame URL> \
  --out <SESSION_DIR>/screenshots/<scenario>-ui-check-baseline.png \
  --log <SESSION_DIR>/logs/<scenario>-ui-check.log [--scale 2] \
  [--no-cache] [--cache-dir <dir>] [--cache-max-age-days <n>]

node ${CLAUDE_PLUGIN_ROOT}/skills/ui-check/scripts/fetch_baseline.js \
  --source image --path <baseline image> --out ... --log ...
```

It prints one JSON line:
`{"result":"OK|BLOCKED","baseline":…,"width":…,"height":…,"node":{…},"variants":[…],"cached":…,"cachedAt":…,"fileKeyMismatch":…,"reason":…}`
(exit 0 OK / 2 BLOCKED). Figma config comes from `config/project.json`'s `figma` block —
a story carries only the frame identifier.

- **Exit 2 → the check is BLOCKED** with the script's named reason, reported **verbatim**
  — never improvised around, never downgraded to FAIL. (Sequential mode: tell the user
  what is missing and stop this check.)
- **`fileKeyMismatch: true`** (frame URL names a different file than the configured
  `figma.fileKey`) → raise it with the user; the differing URL is never silently used.
- **`cached: true`** → Figma was unreachable (`reason` names how: a rate limit, a 5xx, a
  dead download) and the runner fell back to the baseline it cached at `cachedAt`. A
  parallel run is two Figma calls per ui-check step, so 19 steps earn a 429 from a design
  that has not moved in weeks — the check is worth running, but the caveat is not optional:
  - carry `reason` verbatim into the step report, cache date included;
  - a conforming result is **PASS + warning**, never a clean PASS — the page matched a
    baseline from `cachedAt`, which is not the same claim as matching the live design;
  - a deviation is still a **FAIL**, and its Evidence line must say the baseline was cached
    on `<cachedAt>`, so nobody files a design defect that is really a design *change*.
    Re-run the check once Figma answers before that bug is confirmed.
  The runner will not fall back past 7 days (`--cache-max-age-days`), and never falls back
  on a rejected token or an unknown node — those stay BLOCKED, because a config error that
  quietly resolves itself from cache is a config error nobody ever fixes. `--no-cache`
  turns the fallback off entirely.

### 2. Variant gate

If `variants` lists multiple candidate frames (component set / section / page):

- **Confident pick** — exactly one variant's name AND dimensions match the run's target
  form factor (e.g. testing web → the "Desktop" 1440-wide child): re-run the runner with
  that variant's id as `--id` and proceed.
- **Unconfident pick** — a best candidate exists but name/dimensions disagree: proceed
  with it and record a **warning naming the ambiguity** in the report.
- **Unintelligible set** — you cannot make sense of the candidates: **stop immediately
  and ask the user** (sequential). In a parallel run you cannot ask mid-run — report the
  check as **NEEDS-USER** with both image paths and the precise question, for resolution
  at MERGE. Never a silent guess.

### 3. Form-factor gate

Infer the baseline's form factor from its frame dimensions + name; the run's target from
the step's `viewport:` (or the current browser viewport when undeclared). Width bands and
name cues are in `references/figma-api.md`. **Different classes (mobile vs desktop etc.)
→ the check ends as a named "view mismatch error"** — e.g. "baseline is mobile 390×844;
run targets desktop 1440×900" — and **no PASS/FAIL verdict is issued**.

### 4. Set the viewport & capture the actual

- Declared viewport wins. Named sizes default to **desktop 1440×900, tablet 768×1024,
  mobile 390×844**, overridable by an optional `"viewports"` block in the consumer's
  `config/project.json` (e.g. `{"mobile": "414x896"}` — read if present). An explicit
  `<W>x<H>` in the step is used verbatim.
- No declared viewport → set the viewport width to the baseline frame's width (same
  class by construction).
- Set it via `run-code` `page.setViewportSize({width, height})`, then capture:
  `screenshot --filename=<SESSION_DIR>/screenshots/<scenario>-ui-check-actual.png`.
- **No navigation** — the comparison target is the live page as the scenario left it.

### 5. Compare — the vision protocol (judgment, yours)

Read the baseline image, then the actual. Work element by element — enumeration beats
gestalt glancing.

- **`exact` mode:** enumerate every visible element of the baseline (presence, content,
  position, size, color, typography); verify each in the actual; then sweep the actual
  for extra elements the baseline lacks.
  - A clear, unambiguous deviation → **FAIL**.
  - A deviation you suspect is rendering noise (font rasterization, anti-aliasing,
    dynamic data like dates/IDs/order numbers) → **confirm with the user BEFORE issuing
    any verdict** (sequential: ask now; parallel: report NEEDS-USER for MERGE-time
    resolution). **No numeric tolerance threshold, ever** — noise is confirmed, not
    assumed. Attributing a detected difference to noise IS this case — the attribution
    itself triggers the confirmation; "imperceptible" or "sub-perceptual" does not
    exempt a difference you detected. Pixel-diff numbers may inform what you enumerate,
    but a number never closes a verdict.
- **`reference` mode:** PASS/FAIL is decided **only** by the enumerated details.
  - A violated enumerated detail → **FAIL naming it**.
  - All details correct but the overall layout/structure visibly drifts from the
    baseline → **PASS with a warning** describing the drift.
  - Non-enumerated deviations never affect the verdict (note them informationally at
    most).

### 6. Record

Write into the scenario's report entry: the verdict, mode, baseline identity (node id +
name, or image path), and **both image paths** (`*-ui-check-baseline.png` /
`*-ui-check-actual.png` — they live in the session's evidence slice like every
screenshot). A **FAIL becomes a standard defect** in the run's bug list — Title / Steps
to reproduce / Expected = the baseline / Actual = the implemented page / Severity /
Evidence = both images — filable through the bug-report-azure flow unchanged.

## Verdict vocabulary

`report.md` uses these names verbatim; `extent-report.html` carries the two new statuses
first-class:

| Outcome | Meaning | extent-report status |
|---|---|---|
| PASS | conforms per the mode | `passed` |
| PASS + warning | reference-mode layout drift, unconfident variant pick, or a cached (not live) baseline | `warning` (summary count `warnings`) |
| FAIL | clear deviation (exact) / violated enumerated detail (reference) | `failed` |
| VIEW MISMATCH ERROR | form factors differ; no PASS/FAIL | `viewMismatch` (note names the mismatch) |
| BLOCKED | unresolvable baseline (script's named reason, verbatim) | `blocked` |
| NEEDS-USER *(parallel interim only)* | pending noise-confirmation or variant question | never appears in a final report — resolved at MERGE |

## Configuration (once per project)

```json
// config/project.json
"figma": { "fileKey": "<your file key>", "token": { "envSecret": "FIGMA_TOKEN" } }
```

`FIGMA_TOKEN` holds the personal access token in `.env`. Screenshot baselines
(`--source image`) need **no Figma configuration at all**; keep them anywhere in the
project (conventionally `test/baselines/`).

**Secret rule:** the Figma token is only ever an env-var *name* in config; the runner
sends it as a header. The value never appears in logs, reports, JSON output, or on a
command line.

## Honest limits

Vision comparison can miss very subtle deviations (1–2px shifts, near-identical hues).
"No silent tolerance" means no numeric threshold is ever applied — it does not repeal
perception limits. The element-by-element protocol above is the mitigation; disclose
residual uncertainty in the report note rather than overclaiming.

## Reference

**`${CLAUDE_PLUGIN_ROOT}/skills/ui-check/references/figma-api.md`** — Figma endpoints and
auth, node-id formats, render parameters and the short-lived-URL rule, variant traversal
caveats, form-factor inference bands, named-viewport defaults, troubleshooting. Read it
before the first Figma-sourced check in a session and whenever the runner behaves
unexpectedly.
