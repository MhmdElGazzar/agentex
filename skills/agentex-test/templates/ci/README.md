# Codex quality gate for Azure Pipelines (consumer-owned)

`azure-quality-gate.yml` is an **inactive job template**. It does not register or
queue a pipeline. Copy/reference it from the consumer's own YAML, alongside a
checkout or pinned installation of AgenTeX. The older
`skills/test-execution/templates/ci/azure-pipelines.yml` remains the Claude
example and is not suitable for the Codex exact-run flow.

The job runs `azure_quality_gate.js`, which creates a new job-attempt identity
from `Build.BuildId`, `System.JobId`, `System.JobAttempt`, and a random UUID. It
creates a private folder under `Agent.TempDirectory`, passes one handoff path
and that identity to `parallel.js`, waits for it, and calls
`evaluate_handoff_run.js`. Product failure from the coordinator does **not**
skip gate evaluation. The bridge verifies ownership/finalization and delegates
policy to Phase 5's `evaluate_release_gate.js`. No step scans `executions/` or
calls a finalizer. The gate writes only its existing `gate-result.json`.

## Required consumer setup

- Supply `agentexRoot`, `consumerRoot`, and `specDir` as trusted template
  parameters. `agentexRoot` must point to a pinned, available plugin checkout;
  the example's path is illustrative. Keep scope/environment values out of
  untrusted queue-time interpolation. The Node adapter passes them as argument
  array elements, not a shell-concatenated command.
- The template selects Node 22. Supply the Codex CLI, `@playwright/cli`, and a
  Chromium browser in trusted `setupSteps` or on the agent image. The
  coordinator's existing preflight fails closed if Playwright CLI is not ready.
  Installation can need network access. Pin approved tool versions in the
  consumer pipeline/image; do not assume hosted images provide them.
- Supply noninteractive Codex authentication through approved Azure secret
  variables or another organization-approved mechanism. Official OpenAI Docs
  recommend API-key authentication for programmatic CLI jobs; an API key can
  be piped to `codex login --with-api-key` through stdin. The template does not
  embed a key or perform a login. In `setupSteps`, map `CODEX_HOME` to
  `$(AgentexCodexHome)` so authentication setup and execution use the same
  job-private `codexHome`; do not publish its contents. Never
  echo secrets or put them in command arguments. Keep the job trusted, not an
  untrusted public/PR execution context with privileged credentials.
- Provide consumer application configuration and secret variables using the
  existing AgenTeX environment conventions. The adapter sets `AGENTEX_CI=1`
  for the coordinator so tracker writes remain refused. The gate itself
  needs no Azure PAT or service connection.
- Adjust `pool` for a self-hosted agent or for Azure DevOps Server. Windows
  was locally tested. Linux template behavior is only statically reviewed;
  validate the CLI/browser and Codex approval path on that agent before
  relying on it. `PublishBuildArtifacts@1` works with Azure Pipelines/TFS;
  Azure DevOps Services may prefer the faster Pipeline Artifact task.
- Set `jobTimeoutMinutes` above legitimate worker runtime (default worker
  timeout 15 minutes, job timeout 90 minutes). A job cancellation is best
  effort: the adapter forwards SIGINT to its owned coordinator, and the
  coordinator handles its own workers/sessions. Azure may stop steps before
  publication completes. No global process kill is used.

## Outputs and downstream condition

The `RunGate` step sets `AgentexGateDecision`, `AgentexGateExitCode`,
`AgentexReleaseEligible`, `AgentexRunId`, `AgentexArtifactReady`,
`AgentexArtifactPath`, and `AgentexArtifactName` as Azure output variables.
Only the Phase 5 `gate-result.json` is the release verdict. A later job can
require both a successful quality job and
`dependencies.AgentexQualityGate.outputs['RunGate.AgentexReleaseEligible'] == 'true'`.
`azure-quality-gate.example.yml` shows a non-deploying eligibility job.

The adapter exits with the gate's `0`/`1`/`2` when the bridge evaluates a run.
`FAIL` and `REVIEW` both block the quality job, but remain distinct in output
variables and `gate-result.json`. Operational staging/launch errors also
block the job. `PublishBuildArtifacts@1` runs under `always()` only when the
adapter staged at least one verified-run file; a failed upload fails the job.
No deployment is present.

## Artifact boundary

The adapter stages from the **verified handoff run only** into a fresh private
directory. When present, it copies only `run-summary.json`, `gate-result.json`,
`report.md`, and `extent-report.html`. For FAIL/REVIEW it additionally copies
`parallel-timing.json`, `bugs/bug-list.md`, and image evidence referenced by
the summary under `browser-sessions/*/screenshots/` or `bugs/screenshots/`.
An owned incomplete run can also retain its non-secret `coordinator-owner.json`
as a validation diagnostic.
Every copied file must be a regular file whose canonical path remains inside
that run; missing files are skipped. No entire execution directory, auth
state, `.env`, Codex cache, transcript, executor result, or unreviewed text log
is published. Reports and screenshots can still contain sensitive application
content, so the consumer must approve their access and retention policy.

The handoff is not a PASS marker. If execution fails before a usable handoff,
or ownership cannot be proven, the adapter returns REVIEW and stages nothing.
If an owned run is incomplete, it may stage only available allowlisted files;
it never finalizes or re-evaluates another run.
