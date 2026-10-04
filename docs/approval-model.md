# Approvals and action boundaries

A host's permission to run a shell command or drive a browser is not, by itself, AgenTeX
approval for a persistent project or business action. The agent must present the relevant
scope and wait for the user at the workflow's own checkpoint. Core browser testing does not
require Azure credentials or authorize Azure writes.

| Action | AgenTeX boundary |
|---|---|
| Define Flow browser step | Observe the current page, propose the action, obtain approval, execute it in the same session, then verify the observed result with the user. Never silently reopen or switch pages. |
| Save a generated spec | Show the final content and destination; save only after approval, without overwriting a user file. |
| Create Azure Bug | Prepare failure/evidence and exact write plan; file only after scoped approval. A test FAIL can remain local. |
| Create Azure QA tasks or Test Cases | Advisory estimate/design first; persist only after approval of the proposed plan. |
| Initialize or migrate a consumer project | Identify the project and expected changes; migration needs its own approval and a clean Git rollback point. |
| Refresh a runtime plugin/package | Separate from consumer migration; approve the relevant host/package operation. |

Approval of one target, spec, defect, or project does not authorize a different one. If a
planned target, payload, or evidence materially changes, present the changed plan again.
Local evidence, screenshots, session state, and `.env` secrets should remain scoped to the
consumer project and should not be published merely because a run completed.
