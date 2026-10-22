# Suite wizard — the agent's protocol (`/import-swagger --wizard`)

The wizard is a local page ("New suite from Swagger") served by the endpoint-testing studio.
Steps 1, 2, 4 and 5 run on the page alone. Step 3 (test data) is yours: you look in the
project first, then sign in to the application's UI and read its own network calls. The page
cannot wake you; you stay attached by looping a bounded wait on the channel.

Paths below are relative to `${CLAUDE_PLUGIN_ROOT}/skills/`. Every script prints one JSON line.

## 1. Launch

1. Start the studio in the background, from the project root:
   `node endpoint-testing/scripts/studio/server.js --mode wizard [--spec <source>] [--lang=ar|en]`
   - Pass `--spec` when the user gave a source with `--wizard`: it is only pre-filled; the tester
     still picks the suite name and the environment (no silent default).
   - It prints `{"ok":true,"url":…}`. Give the tester the URL.
   - `"error":"port-in-use"`: relay its message (it names the next port to try) and stop.
     `"already-running"`: give the tester that URL instead.
2. Loop `node endpoint-testing/scripts/studio/channel.js wait` until it returns `closed`.
   - On `idle`, wait again without writing anything in chat.
   - Each wait ends within ~90 s, so the page always knows whether you are still attached.

## 2. On `collect` (and `collect-again`)

The event carries `{runId, suite, env, user, apiOrigin, needs:[{param, in, type, operations}]}`.
Post progress with `channel.js post <kind> --json '<object>'`, always with that `runId`.

**Project first**
- Run `node swagger-import/scripts/project_values.js --needs -` with the event on stdin.
- Post each hit that answers a need as
  `value {runId, param, value, source:"project", provenance:{file, path}}`. Choosing which hit
  fits which need is your judgment: check the type and the operations that use it.
- Its `db` list names the cataloged queries. Run only `"selectOnly": true` entries, through
  `db-integration/scripts/run_db.js --entry <entry> … --log "$TMPDIR/agentex-wizard-<n>.log"`.
  The log goes to the OS temp dir, so the project stays untouched before approval. Never run a
  write entry.

**Then the UI**, only for values still missing, and only if the environment has `portalUrl`
and the event names a `user`. Otherwise post `failed {runId, reason}` in plain words (for
example "no application URL is configured for qc") and stop. The wizard goes on.
1. Open a headed session: `playwright-cli -s=agentex-collect open <portalUrl> --headed`.
2. Find the login form. Fill the user's identifying field (from `users.<user>` in the
   environment file) yourself.
3. Fill the password **only** through the bridge. Put it last and let the bridge submit:
   `node swagger-import/scripts/browser_bridge.js fill-secret --session agentex-collect --locator <password field> --env <env> --user <user> --submit <submit button>`
   - Never type a password literal and never read one.
   - Never take a `snapshot` (or `eval` an input's value) while a filled password field is on
     screen. The accessibility snapshot prints field values; that is why the bridge submits
     in the same step.
4. Prove the login by a landmark (optimize-login's rules: an element only a signed-in user
   sees, never the URL).
   - A captcha or OTP: post `gate {runId, kind:"captcha"|"otp"|"other", text}` and wait for
     `gate-cleared`. Never try to solve or bypass it.
   - If the tester does not clear it, post `failed` with the reason.
5. Walk the screens that load the data. Wrap each data-loading navigation or click in:
   `browser_bridge.js capture --session agentex-collect --api-origin <apiOrigin> (--goto <url> | --click <locator>) --to-studio --user <user>`
   - Use the `apiOrigin` from the event, or the API origin you see the app call if it differs.
   - The output lists the app's calls, redacted. A token seen on them goes to the studio by
     itself; you only see `"token":{"seen":true,"delivered":"studio"}`.
   - Map the observed values to needs (judgment) and post each as
     `value {runId, param, value, source:"ui", user, provenance:{screen, call}}`.
   - `call` is the method and path you observed.
   - The server refuses a credential-shaped value (`"error":"credential-shaped"`). Never
     re-post it in another shape.
6. For a need you cannot fill, post `missing {runId, param, hint}`.
7. Post `phase {runId, name:"project"|"login"|"walk"|"create"|"done", text}` as you move, so
   the page shows live progress.

**Never** send an HTTP request of your own to the service during collection: no curl, no
fetch, no `run_api.js`, no catalog run. Only the application's own UI talks to its API. A
value you cannot get from the project or the UI stays missing. The tester can type it or leave
it as a placeholder.

## 3. Creating data (Q21)

Only when a need can be met **only** by creating data through the UI:
1. Post **one** `proposal {runId, items:[{what, screen}]}`: the exact list, each item with the
   screen it is created on. One proposal per collect run.
2. If the answer is `"error":"refused"`, the environment is not marked non-production.
   - Tell the tester in chat what the page says: add `"nonProduction": true` to
     `environments/<env>.json`.
   - **Do not edit** that file yourself, and do not argue the environment is "only QA".
   - Continue without creating anything.
3. Then wait. On `consent` with `decision:"yes"`, create exactly the listed items and nothing
   else. After each one, post `created {runId, proposalId, index}`.
   - If another item turns out to be needed, it stays missing. There is no second consent in
     the same run.
   - A `created` outside the list is refused and shown to the tester as a violation.
4. On `decision:"no"`, create nothing. The values stay missing.

"Collect again" starts a new run (`collect-again`), which may ask once more for a new exact
list.

## 4. End

- Post `ended {runId, found, total}` when collection is done.
- On any failure, post `failed {runId, reason}`. The wizard always continues with project,
  typed and placeholder values.
- On `cancel`, stop the browser work and post `ended`.
- On `closed` (`reason: "approved" | "done" | "shutdown"`), stop waiting and summarize in chat:
  - the files written (`catalogPath`, `suitePath` from the event);
  - the counts by source (`bySource`) and any created items;
  - the token **reference** (`tokenRef`). Never its value.
  - that the write cases stay skipped. "Approve and run now" runs them BLOCKED `case
    skipped`; each is enabled one at a time after the tester reviews it, never by a bulk
    strip of the `skip` lines (swagger-import's SKILL.md, "After a successful import", 3).

## 5. Outside the wizard (the tester asks in chat)

- **Refresh a token:** sign in as above, then
  `browser_bridge.js capture … --store <suite> --env <env> --user <user>`. It writes
  `test/.auth/api-tokens/<suite>-<env>.json` (0600; refused when that folder is not
  gitignored: point at `/update-agentex`).
  - `browser_bridge.js token-status --store <suite> --env <env>` shows the owner and the
    times, never the value.
  - A `tokenEnv` value set in `.env` always wins over a captured token.
- **One missing value:** propose the exact suite edit in chat and write it only after the
  tester says yes. If the editor page has unsaved changes for that suite, ask the tester to
  Save or reload first; never write under an open editor.
- **"Show me the token" / "put it in the catalog":** never. The value lives only in its
  store. For CI, the tester sets the catalog's `tokenEnv` variable in `.env` or the CI secrets.

## What the scripts guarantee

- Nothing is written in the project before the tester approves step 5. Your only scratch is
  `.playwright-cli/` (gitignored) and the OS temp dir.
- The token and the password never pass through your context, a command line you compose, a
  page response or a log. The bridge redacts what it prints.
- The non-production guard is enforced by the server. It does not depend on you remembering
  it.
