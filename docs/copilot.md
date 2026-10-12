# VS Code Copilot native parallel handoff

## Selected harness and limits

Select **Copilot** in the VS Code Session Target control and open the QA consumer folder. This integration targets the Copilot Agent Host, whose native subagent delegation is managed by the Copilot SDK. `agent/runSubagent` belongs to the separate **Local** harness and is not used here; Codex `spawn_agent` belongs to the Codex harness. Thus this implementation does **not** satisfy a requirement specifically demanding a `runSubagent` call. Copilot subagent concurrency is documented in principle, but the actual available capacity and overlap of this VS Code session must be observed. Never borrow a capacity number from a Copilot CLI plan or a Codex session.

VS Code discovers workspace custom agents from `.github/agents/*.agent.md`. The source definitions are `agentex-copilot-parallel.agent.md` and `agentex-copilot-executor.agent.md`. Install them in a QA consumer with:

```sh
node <agentex-plugin-root>/scripts/copilot/install.js <absolute-qa-project-root>
```

The installer records the absolute plugin root in `.agentex/copilot.json` and preserves edits to installed agents. In VS Code, use the Agent Customizations editor or `/agents` to verify that `agentex-copilot-parallel` appears for the **Copilot** target and `agentex-copilot-executor` is available for subagent invocation. Inspect the diagnostics view if either is absent. The executor is hidden from the user picker with the documented `user-invocable: false` field. Its model and tools are inherited from the selected Copilot session; verify terminal and all required browser/integration tools are actually available before running. Agent Host access to client-side tools can depend on a connected VS Code window.

Installation rejects linked or junction-backed `.github/agents` and `.agentex` paths before writing agents or metadata, while preserving edited agent files.

## Run

Ask the `agentex-copilot-parallel` agent to run at least two independent saved specs or original ad hoc requests. Give it the target URL and environment. It reads the existing AgenTeX shared executor and driver instructions. It freezes assignments through `scripts/codex/host.js`, then delegates each exact assignment to a **native Copilot subagent**. Concurrent dispatch requires a native parallel facility exposed by that Copilot session; if only serial delegation is available, report the limitation. The existing `scripts/codex/parallel.js` records observed lifecycle; `host.js finalize` calls the shared `validateExecutionResult`; `host.js report` revalidates and produces standard reports. These Node commands maintain custody and reporting. They do not spawn AI workers.

The worker uses one owned browser session, result path, and evidence directory. It follows `agents/qa-executor.md`, substituting the absolute plugin root for the Claude-specific path variable in that canonical contract. `scripts/lib/execution_result.md` defines the shared result schema. Custody remains **LIMITED**: the unkeyed assignment digest detects drift but cannot authenticate an adversary that can rewrite both retained custody and assignment files.

A failed delegation can be recorded as `launch-failed` without a worker ID or launch record. Deferred UI questions use the shared [UI outcome contract](../scripts/codex/ui-outcomes.md): the coordinator collects answers after workers finish and resolves them before finalization; unanswered questions remain BLOCKED, and named view mismatches remain visible.

The current shared host and report filenames and display title retain their Codex-origin naming. This does not assert that the Codex harness performed the Copilot run. Check the selected harness and native worker events in the VS Code session transcript.

## Consumer certification

Record `code --version`, GitHub Copilot extension version, chosen **Copilot** Session Target, agent discovery diagnostics, available tools, and observed host capacity. Start `node <pluginRoot>/scripts/copilot/fixtures/server.js` in a separate terminal. It binds only `127.0.0.1:8766`; stop it after the run. Copy `scripts/copilot/fixtures/pass.md` and `fail.md` into the consumer's `test/` folder. Ask the coordinator to run both saved natural-language specs concurrently against the local fixture, with the Bob assertion intentionally failing. Retain the original prompt and spec hashes. Capture the Copilot native delegation calls and actual worker IDs from the session UI or transcript. Record each worker's launch, start, end, completion/cancellation and terminal outcome. Verify **overlapping execution intervals** and distinct owned browser session IDs and interactions. A common parent response or sequential workers is insufficient evidence of overlap.

For every assignment retain `custody.json`, copied source, frozen assignment, worker events, evidence with hashes, result, and authoritative validation. Retain the timing metadata, `run-summary.json`, `verdict.json`, `report.md`, and `extent-report.html`, plus CLI exit 0/1/2. Check that public counts are scenario counts and required-step coverage is separate. Verify each browser session was closed by its owner. If the host exposes no usable worker identity, lifecycle, driver access, or true concurrent delegation, record the limitation and mark live Copilot certification **BLOCKED / NOT VERIFIED**. Deterministic Node tests and Codex certification are separate evidence.

Official host references: [VS Code subagents](https://code.visualstudio.com/docs/agents/run/subagents), [VS Code custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents), [VS Code harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), and [Copilot SDK custom agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents).
