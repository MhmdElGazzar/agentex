# UI check steps — design conformance in test specs

A `ui-check:` step compares the **live page currently open in the browser under test**
against a declared design baseline, at the exact point in the scenario where the step
appears. It joins `api:` / `db:` / `kb:` as a first-class spec step, executed by the
**ui-check** skill.

```
ui-check: figma <node-id | frame URL> — mode: exact|reference [ — viewport: desktop|tablet|mobile|<W>x<H> ]
ui-check: image <path> — mode: exact|reference [ — viewport: ... ]
```

## Baseline sources

| Source | What the spec carries | Setup needed |
|---|---|---|
| `figma` | Just the frame identifier — a node id (`123:456`, URL-style `123-456`) or the full frame URL | `figma` block in `config/project.json` + `FIGMA_TOKEN` in `.env` (once per project) |
| `image` | A path to a baseline screenshot (PNG/JPEG), e.g. `test/baselines/checkout-desktop.png` | none — works with zero Figma configuration |

A frame URL whose file key differs from the configured one is surfaced to you and never
silently used. An unresolvable baseline (unknown node, missing config, unset env var,
unreadable image) makes the check **BLOCKED** with a message naming exactly what is
missing — distinct from FAIL, never improvised around.

## Modes

- **`exact`** — the page must match the baseline in every visible detail. A clear,
  unambiguous deviation fails the check. There is **no silent tolerance threshold**:
  when the agent suspects a deviation is rendering noise (font rasterization,
  anti-aliasing, dynamic data like dates/IDs), it **confirms with you before issuing a
  verdict**.
- **`reference`** — the baseline shows what the screen should *generally* look like; the
  details that matter are enumerated as sub-bullets under the step. Only a violated
  enumerated detail fails the check. If every enumerated detail is correct but the
  overall layout visibly drifts, the check **passes with a warning** describing the
  drift. Non-enumerated deviations never affect the verdict.

```
ui-check: figma 123:456 — mode: reference
  - must: primary CTA reads "Pay now" and is enabled
  - must: order summary shows 3 line items with a total row
```

**In parallel (autonomous) runs** the agent cannot ask you mid-run: confirmation
questions (exact-mode suspected noise) and design-variant sets it cannot make sense of
are deferred as pending items and put to you — with both images — when the run's results
are merged, before the final report is written. They are never silently decided and
never degraded to BLOCKED.

## Viewports & form factors

- `viewport:` in the step wins. Named sizes ship with plugin defaults — **desktop
  1440×900, tablet 768×1024, mobile 390×844** — overridable via an optional
  `"viewports"` block in `config/project.json` (e.g. `{ "mobile": "414x896" }`).
  An explicit `<W>x<H>` is used verbatim.
- No declared viewport → the browser is set to the baseline frame's width.
- **Same form factor is mandatory.** A mobile baseline against a desktop run (or the
  reverse) ends the check as a named **view mismatch error** ("baseline is mobile
  390×844; run targets desktop 1440×900") — no PASS/FAIL is issued.

## Multi-variant designs

When the referenced node contains several design variants (a component set, a section, a
page): a **confidently identified** applicable variant (name and dimensions both match
the run's target) is used; an unconfident pick proceeds **with a warning naming the
ambiguity**; a set the agent cannot make sense of **stops with a question to you** —
never a silent guess.

## Results & evidence

Every check leaves the baseline image and the actual screenshot in the run's execution
folder (`…-ui-check-baseline.png` / `…-ui-check-actual.png`) and a verdict in
`report.md` and `extent-report.html` — where **Warning** and **View Mismatch** are
first-class statuses with their own colors and stat cards. A failed check becomes a
standard defect in the run's bug list (Expected = the baseline, Actual = the implemented
page, both images attached), filable via the Azure bug-filing flow unchanged.

## Configuration

```json
// config/project.json
"figma": { "fileKey": "AbCdEf123456", "token": { "envSecret": "FIGMA_TOKEN" } }
```

`/init-test` scaffolds the block (empty) and the `FIGMA_TOKEN=` key; `/update-agentex`
adds both to existing projects. The token value lives only in `.env` — it is sent as the
`X-Figma-Token` header by the bundled runner and never appears in any output, log,
report, or generated file. See [configuration.md](./configuration.md).

## How the comparison works — and its honest limits

Baseline resolution is deterministic (the bundled `fetch_baseline.js` renders/validates
the image and enforces the BLOCKED gate in code). The **verdict is the agent's vision
judgment** under a disciplined protocol: enumerate the baseline's visible elements,
verify each in the actual page, then sweep for extras. No pixel-diff score ever decides
a verdict — the spec's semantics (enumerated details, noise confirmation, variants) are
judgment calls a numeric threshold cannot make.

Be aware: vision comparison can miss very subtle deviations (1–2px shifts,
near-identical hues). "No silent tolerance" means no numeric threshold is ever applied;
it does not make perception perfect. Treat `exact` mode as a rigorous visual review, not
a pixel-perfect guarantee.
