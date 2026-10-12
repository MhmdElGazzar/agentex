# Clean-consumer Codex certification checklist

This is a manual completion checklist, not a certification claim. In a prior local
attempt, a fresh CLI session started a real host, but its stderr recorded policy
rejection of reading the native init skill. The process exited 0 after reporting
the limitation; this is not an AgenTeX PASS. The ignored local evidence from that
attempt is historical and is not included in this source package. Native INIT,
TEST, and UPDATE certification below remain unverified.
Use a normally configured Codex session that is permitted to read skills and execute
local commands. Do not bypass organizational policy or disable sandbox protection.

## Roots and prerequisites

Use Node.js, Git, and a Codex installation that can invoke local skills and commands.
For browser checks, install and configure the browser driver required by
`agentex-test`; keep the synthetic HTTP fixture reachable from that browser.
`<AGENTEX_PLUGIN_ROOT>` is the absolute path to **your** AgenTeX checkout or installed
plugin directory containing `scripts/codex/install.js` and `.agents/skills/agentex-init/`.
Find it from the checkout you intend to certify; do not use a path from someone else's
machine. `<CONSUMER_PROJECT_ROOT>` is the absolute path to a new, separate QA project
directory that you control. `<EXECUTION_DIR>` is an optional directory you create for
CLI transcripts and final responses; it is not an AgenTeX input or required fixture.
Replace each angle-bracket placeholder with your own path and quote paths containing
spaces. These are documentation placeholders, not environment variables. Unprefixed
consumer file paths below are relative to `<CONSUMER_PROJECT_ROOT>`. Use your shell's
normal file creation and copy commands on Windows, macOS, or Linux.

Parent-driven installer checks are deterministic evidence only. No commits are needed
for the current-version UPDATE path. Actual version migrations still require the
upstream clean-tree precondition and are outside this no-commit certification.

For a genuinely clean INIT proof, create a new empty consumer outside other repositories,
run `git init "<CONSUMER_PROJECT_ROOT>"`, and copy only
`<AGENTEX_PLUGIN_ROOT>/.agents/skills/agentex-init/SKILL.md` to
`<CONSUMER_PROJECT_ROOT>/.agents/skills/agentex-init/SKILL.md` as the bootstrap skill.
Do not copy a development AGENTS.md or inject the TEST procedure into the prompt.

## Native INIT

Start Codex in that consumer, with its normal permitted workspace-write configuration.
Retain the exact prompt, host version (`codex --version`), installed skill catalog/path,
and host events/transcript. Invoke:

```text
$agentex-init Initialize this local synthetic QA consumer using AgenTeX at
<AGENTEX_PLUGIN_ROOT>. Skip the wizard; I will supply local fixture configuration.
No commits, publication, production services or subagents.
```

Verify the transcript reads the consumer's installed init SKILL.md and executes its
shipped `node <AGENTEX_PLUGIN_ROOT>/scripts/codex/install.js init
<CONSUMER_PROJECT_ROOT>` command (with actual quoted absolute paths). Retain
`.agentex/codex.json`, the **exactly three** installed skill hashes for
`agentex-init`, `agentex-test`, and `agentex-update`, and configuration hashes.
Verify all referenced files resolve.

Prepare your own synthetic fixture in the consumer; no ignored local fixture or
developer-specific directory is required. For the precise expectations below, create
`fixture-server.js` that listens on `127.0.0.1:8766`, serves a form with a Name field
and Join button at `/`, and displays `Welcome, <name>!` after submission. Also serve
`GET /status` as HTTP 200 with JSON `{ "status": "ok" }`. Create `test/pass.md` to
submit Ada and assert `Welcome, Ada!`; `test/fail.md` to submit Bob and intentionally
assert `Rejected, Bob!`; and `test/api.md` with an `api:` step for a cataloged
`local.ok` GET `/status` request expecting HTTP 200 and `status=ok`. Create
`integration/local_api.json` using the catalog shape in
[API & DB Steps](./api-db-steps.md): set `name` to `local`, `baseUrl` to
`http://127.0.0.1:8766`, `auth.type` to `none`, and add one `requests` entry with
`name: "ok"`, `method: "GET"`, and `path: "/status"`. Set
`config/project.json`'s `defaultEnvironment` to `local` and
`environments/local.json`'s `api.baseUrl` to `http://127.0.0.1:8766`. Keep `local.unavailable`
absent from the catalog for the BLOCKED check. These paths and values are examples
for this reproducible synthetic run, not files supplied with the checkout.
From `<CONSUMER_PROJECT_ROOT>`, start `node fixture-server.js` in a separate terminal;
retain its output and stop only that server with Ctrl+C afterward.

## Fresh native TEST

Start a NEW Codex session at the consumer Git root. Do not resume the implementation
thread. Invoke the installed skill using `$agentex-test` (or select it from `/skills`).
For CLI event capture, use `codex exec --json --sandbox workspace-write -C
"<CONSUMER_PROJECT_ROOT>" -o "<EXECUTION_DIR>/final-response.txt" -` and supply
the prompt on stdin. Retain stdout JSONL, stderr, and the process exit code.
Host completion exit 0 is not the test
verdict: retain the executed host.js report command's 0/1/2 exit separately.

```text
$agentex-test Run test/pass.md and test/fail.md sequentially in one browser session
against the local fixture, then run test/api.md through the cataloged API driver.
This is an authorized local certification: all synthetic form interactions are approved.
Use only this consumer's installed integration. Keep the controlled failure as FAIL.
Retain driver version, command/observation and cleanup evidence. No application edits,
commits, publication, production services or subagents.
```

With the synthetic fixture specified above, expect Ada input and Join submission to
visibly produce Welcome, Ada!; Bob submission produces Welcome, Bob! and fails the
expected Rejected, Bob! assertion. The API route
returns HTTP 200 and status=ok. The aggregate must be FAIL/1, with scenario counts
2 passed, 1 failed, total 3. Step coverage is separate. Capture console/network evidence
and owned-session close output; do not claim clean console from screenshots alone.

In a separate native skill request (new run), invoke:

```text
$agentex-test Ad hoc local certification: call api: local.unavailable and verify HTTP
200. That request is intentionally absent from the catalog. Preserve the missing-entry
condition as BLOCKED; do not create an entry or improvise a request. All local inspection
is authorized. Retain the driver diagnostic, authoritative validation and standard reports.
```

Expected if executed: genuine agent-driven incomplete execution, BLOCKED/2, one blocked scenario.
For a mixed PASS+BLOCKED check, include test/pass.md with the same ad hoc request;
expect one passed, one blocked, aggregate BLOCKED/2.

For every run retain custody, source snapshots, assignments, results, validations,
timing metadata, evidence hashes, `run-summary.json`, `report.md`, `extent-report.html`,
`verdict.json`, and the final user-facing response. Inspect all three report formats.

## Native UPDATE

Append a harmless consumer note to installed agentex-test/SKILL.md and record its hash.
Record config/project.json and environments/local.json hashes. In the consumer invoke:

```text
$agentex-update Update this initialized local consumer from its configured AgenTeX
checkout. Preserve the intentional skill edit and configuration. Do not update the
plugin source, commit, publish or invoke Claude marketplace commands.
```

Retain actual native skill reads, installer/migrator command output and exit 0; confirm
all recorded hashes stay unchanged and the edited skill is reported as preserved.
Run the saved PASS through the retained TEST skill once more to establish functionality.

## Acceptance and limits

Discovery is established by the consumer skill catalog; activation requires actual host
events showing the installed SKILL.md read/invocation and subsequent driver workflow.
Self-written narrative alone, manually running host.js, screenshots alone, deterministic
fixtures, and a Codex process exit 0 do not establish native execution certification.
If host policy still blocks operations, retain the denial and mark certification BLOCKED.
Keep all artifacts ignored; do not stage them. Custody remains LIMITED, not authenticated.
