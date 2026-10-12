# Codex integration

AgenTeX exposes three sequential Codex skills in `.agents/skills`: `agentex-init`, `agentex-test`, and `agentex-update`. The parallel-enabled installation adds a fourth skill, `agentex-parallel`. Codex discovers the skills when launched from this repository. To install them in a QA project, run:

```sh
node <agentex-plugin-root>/scripts/codex/install.js init <absolute-project-root>
```

The init adapter runs the existing AgenTeX scaffold, then installs the three sequential skills plus `agentex-parallel` in the project's `.agents/skills` and records the plugin root and installed skill hashes in `.agentex/codex.json`. Fill in `config/project.json`, an environment file, and secrets through the existing Setup Wizard. Codex can then invoke `$agentex-test` or `$agentex-parallel` from the QA project. No Claude marketplace command is involved.

Update with:

```sh
node <agentex-plugin-root>/scripts/codex/install.js update <absolute-project-root>
```

Update runs the existing migration engine, including its git rollback preflight, then refreshes only Codex skill files that still match their installed hashes. Edited skills and user configuration remain intact. Refreshing the plugin source itself is separate.

The installer checks managed parent directories and metadata before invoking scaffold or migration. Linked or junction-backed managed parents are rejected; user-edited skill files remain preserved.

## Sequential handoff

The active Codex agent interprets saved Markdown specs or ad hoc instructions and uses the existing AgenTeX driver skills. Before driver execution, it declares required steps and assertions in a JSON input and runs `scripts/codex/host.js prepare <input.json>`. Prepare retains source copies and freezes assignments with unique run, attempt, and assignment IDs. A single named browser session can serve multiple sequential specs; each has a separate assignment, result, and validation destination.

After observing and recording each step, the agent writes the shared v1 result contract and calls `host.js finalize <absolute-run-root> <assignment-id>`. Finalize verifies custody metadata and calls PR A's `validateExecutionResult`. Its verdict and exit code are authoritative: PASS 0, FAIL 1, BLOCKED 2. Missing steps, missing or replaced evidence, stale IDs, failed cleanup, and malformed records cannot pass. Scenario summary counts remain scenario counts.

For `ui-check:` questions, retain the original BLOCKED result, ask the user, then call `host.js resolve <runRoot> <assignmentId> <input.json>` before finalization. The [UI outcome contract](../scripts/codex/ui-outcomes.md) defines the answer and proposed final result. Unanswered questions remain BLOCKED; named view mismatches appear as `viewMismatch` and gate BLOCKED/2. Existing B sequential custody records remain readable without rewriting them.

The `custody.json` and assignment files live apart from executor result files, and the validator rehashes the retained source and evidence. This is an integrity boundary within an agent workflow, not authentication against a caller with write access to both custody and assignment files. Review the original spec and declared obligations when completeness matters. No deterministic prose executor or Codex worker subprocess is used.

## Native parallel handoff

`$agentex-parallel` uses the active Codex host's genuine native subagent delegation. Confirm that the host exposes a delegation tool and determine its available child-agent capacity before preparing the run. The coordinator supplies `mode: "parallel"` and the verified `hostCapacity` to `host.js prepare`; the effective ceiling is `min(6, hostCapacity)`. Every assignment receives its own session and evidence directory. The host tool dispatches the worker with `scripts/codex/executor.md`, which points to the existing shared executor and driver semantics. Node does not spawn AI workers.

The coordinator records the native worker identity with `parallel.js launch` and its terminal status with `parallel.js finish`. `report` checks those lifecycle records in addition to the shared result validator. Missing, incomplete, cancelled, timed-out, or failed workers cannot authorize PASS. A validated product failure remains FAIL. The coordinator alone writes merged reports. Concurrent execution is claimed only when observed worker execution intervals overlap, with distinct browser sessions. If the Codex host has no native delegation or lifecycle visibility, stop and report BLOCKED.

If delegation fails before any worker identity exists, `parallel.js finish <runRoot> <assignmentId> launch-failed` records a terminal BLOCKED event without a fabricated launch. After workers finish, the coordinator resolves deferred UI questions before finalization; unanswered questions stay BLOCKED and view mismatches remain named.

## Mandatory standard reporting

After all scenarios and owned-session cleanup, call `node <plugin-root>/scripts/codex/host.js report <absolute-run-root> <metadata.json>`. Metadata contains observed run timing and a `scenarios` map keyed by assignment ID; each timing record has ISO `startedAt`, ISO `endedAt`, and integer active `durationMs` excluding user waits. Optional run fields are environment, targetUrl, loginMode and observed tools. Never include secrets. Step `note` fields hold observed versus expected behavior.

The Codex adapter revalidates retained results and compares any saved validations before translating to the existing schemaVersion 2 scenario-count contract. It writes `run-summary.json`, `report.md`, `extent-report.html` using the existing HTML generator, and `verdict.json`. Coverage stays separate. WARNING and FLAKY remain visible; frozen per-assignment policies determine the authoritative gate. A small Codex-side HTML banner adaptation displays that authoritative verdict rather than recalculating it from ambient Claude/CI policy. Missing results become BLOCKED. Malformed or stale validations cannot authorize PASS. Report generation failure returns nonzero (FAIL if a product failure is already validated, otherwise BLOCKED) and removes incomplete standard reports. The final CLI exit code, not renderer success, is the gate.

## Shared driver path aliases

`node <plugin-root>/scripts/codex/paths.js <absolute-consumer-root> <shared-skill-name>` resolves the installed metadata into pluginRoot and skillDir. In shared instructions substitute these for `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}` respectively. Resolve relative resources against skillDir and quote absolute shell paths. Codex does not require Claude environment variables or marketplace commands. Session ownership comes from Codex prepare, not a second shared init_run.js invocation. Existing Claude files and behavior are unchanged.
