# Azure DevOps bug integration — maintenance map

This reference is for maintaining or diagnosing the implementation. Normal bug filing
must use `scripts/bug-report.js` and does not need this file.

## Responsibility boundaries

| Owner | Responsibility |
|---|---|
| `scripts/bug-report.js` | Agent-facing context, semantic intent normalization, configured-template summary/defaults, approval artifact integrity, composite Bug/test-case execution, and semantic output. |
| `scripts/duplicate-ranking.js` | Deterministic lexical/IDF ordering, explanatory match evidence, and shortlist projection. It performs no Azure reads, duplicate verdict, blocking decision, or write policy. |
| `scripts/create-bug.js` | Bug-domain validation, field mapping, reproduction formatting, evidence upload, parent relationship, duplicate query, write order, and the low-level Bug ledger. |
| `scripts/check-image.js` | Dependency-free structural image validation. It cannot decide whether an image is relevant to a defect. |
| `scripts/read-workitem.js` | Legacy/ad-hoc raw work-item read CLI. It is not part of normal filing. |
| `scripts/lib/tracker/index.js` | Tracker selection and fail-closed project resolution. |
| `scripts/lib/tracker/adapters/ado.js` | Azure configuration fallbacks, credential handling, transport, request construction, provider field dialect, complete/chunked work-item batch reads, attachments, individual work items, and test-plan/run API calls. |
| `scripts/lib/tracker/cache.js` | Per-project runtime field metadata and allowed-value validation. |
| `scripts/lib/tracker/ledger.js` | Ordered writes, stop-on-first-failure behavior, and exact done/failed/not-attempted accounting. |
| `skills/test-design/scripts/testplan.js` | Test-suite/case reads, minimal Test Case creation, and recording an existing case as Failed. Bug filing calls this owner; it does not reproduce its logic. |

Configuration is documented in `docs/configuration.md` and resolved by the tracker adapter.
Do not add direct project JSON or `.env` parsing to a bug script. Azure resource-plane CLI
support in `skills/azure-integration` is unrelated to DevOps Boards and is not a fallback.

## High-level contract

`bug-report.js context --parent <id> --emit-intent` is the bootstrap form. It returns only
facts that can change an agent decision: normalized template/parent summaries, resolved
defaults, allowed choices, process requirements, test-plan identity, and an intent scaffold.
Parent-scoped discovery remains complete and fail-closed, but candidate bodies are withheld
until ranking has semantic input.

`bug-report.js context --intent <file>` derives the parent from that intent, reads every
direct Bug child across all states, and returns the deterministic default review ordering of
25 candidates plus any normalized exact-title pins. Metadata makes total, shown, omitted,
and truncation counts explicit. `--duplicate-view all` returns the same complete ranked
ordering without omissions. Neither rank nor shortlist membership is a duplicate verdict.

`bug-report.js prepare` requires the duplicate review ID and recomputes current runtime and
candidate data before any plan or board write. The receipt binds project, parent, ranking
version and inputs, the complete compact candidate content, and default shortlist IDs. A missing or
stale receipt returns a fresh shortlist/new ID and writes no plan. A fresh receipt allows the
existing read/dry-run validation and local plan creation. Successful approval contains a
compact receipt and any project-wide exact-title exception candidates, never the full parent
candidate list; the rest remains logical effects rather than provider mechanics.

`bug-report.js execute` verifies the artifact, project binding, evidence hashes, selected
test-case preconditions, CI state, and single-use marker before delegating writes. The Bug
must complete before a test-case write begins. The returned composite ledger preserves all
created IDs and stops after the first failed write; it never retries or cleans up.

The low-level `create-bug.js` and `testplan.js` CLIs remain compatible for diagnostics and
their own tests. They are implementation surfaces, not an instruction for the agent to
assemble a filing manually.

## Intentional remaining limits

- Duplicate handling is hybrid: strict parent-wide discovery -> deterministic intent-aware
  ordering/projection -> agent semantic judgment -> review-ID freshness check, plus the
  unchanged project-wide exact-title guard in `create-bug.js`. `bug-report.js` expands the
  selected parent and derives every direct `Hierarchy-Forward` child ID from that authoritative
  response. It then uses the adapter's 200-ID chunked batch read with only ID, type, title,
  state, and reproduction fields projected; complete response validation prevents partial
  discovery. A narrowly gated compatibility fallback uses at most eight concurrent individual
  reads when the endpoint or projection is explicitly unavailable. Ordinary request failures,
  malformed responses, and missing children remain fail-closed.
  State never changes eligibility or score, omitted shortlist entries are not classified as
  non-duplicates, and `--duplicate-view all` is the exhaustive fallback. Sibling presence and
  lexical score alone never block or allow preparation.
- The configured template currently supplies normalized defaults for the known optional Bug
  concepts. Runtime metadata reports additional required process fields; unknown fields are
  still ultimately enforced by server-side validation rather than blindly copied from a
  template.
- Provider relation identifiers remain pinned in the domain scripts that use them. Moving
  them behind semantic adapter methods would require a coordinated tracker-wide change and
  is outside this Bug-only refactor.
- `create-bug.js` keeps its own last-line attachment check even though `check-image.js`
  performs the richer pre-approval structural pass. The duplication is deliberate defense
  against a changed file at write time; the plan artifact also verifies evidence hashes.

When changing behavior, run the sibling Bug tests, the test-plan tests, and the shared
tracker/cache/ledger tests. Prefer assertions on semantic effects and safety invariants over
assertions that force raw provider requests back into agent-facing output.
