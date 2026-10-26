### Changed

- Release gate: `gate-plan.js` now maps the hunks of `agents/qa-executor.md` to the lanes of their section (browser steps and UI checks → ui, evidence and failure handling → ui + reporting, integration steps and KB questions → api) instead of asking for all seven lanes; a hunk outside a mapped section still runs the full gate (maintainer tooling).
