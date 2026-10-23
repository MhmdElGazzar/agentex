# Suite wizard — the agent's protocol (`/import-swagger --wizard`)

The wizard is a local page ("New suite from Swagger") served by the endpoint-testing studio.
Steps 1, 2, 4 and 5 run on the page alone. Step 3 (test data) is yours, as a ladder: the
project first, then the database, then the chosen user's saved session, and a sign-in to the
application's UI last, reading its own network calls. The page cannot wake you; you stay
attached by looping a bounded wait on the channel.

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
Go down the ladder in this order, and take each next rung only for what is still missing: a
value, or a token.

**Project first**
- Run `node swagger-import/scripts/project_values.js --needs - --env <env>` with the event on
  stdin. It reads past runs (`executions/`, newest run first) before the test data. It drops a
  hit from another environment and only counts it.
- Per operation, pick the group (`groups[]`: one record or one URL) that covers most of its
  needs in the event's environment. When one group covers all of an operation's needs, take
  every value from it and never mix groups: values from different records can make the call
  return 404.
- Post each hit you use as
  `value {runId, param, value, source:"project", user, environment, group, provenance:{file, path}}`,
  where `user` is the hit's `owner`, and `environment` and `group` are the hit's own. Leave out a
  field the hit has as `null`; never guess it. Choosing which hit fits which need is your
  judgment: check the type and the operations that use it.
- The server refuses a hit from another environment (`"error":"other-environment"`), a value
  of the wrong type (`"bad-type"`, naming the expected type) and a credential-shaped value
  (`"credential-shaped"`). Drop that hit. Never re-post it in another shape.

**Then the database**, only for a need still missing that a cataloged query would answer. The
queries come from `project_values.js`'s output:
- Its `db` list names the cataloged queries. Run only `"selectOnly": true` entries, through
  `db-integration/scripts/run_db.js --entry <entry> … --log "$TMPDIR/agentex-wizard-<n>.log"`.
  The log goes to the OS temp dir, so the project stays untouched before approval. Never run a
  write entry.

**Then the saved session**, only when values are still missing or a token is still needed.
If neither, post `ended` (§4) and stop.
- No `user` in the event: never pick one yourself. Post `missing {runId, param, hint}` for
  each need still open, then `phase {runId, name:"session", text:"pick a user to go on"}`, then
  `ended`. The page preselects the user who owns most of the project values; the tester picks
  a user and collects again.
- A user marked `disabled` never reaches you: the server refuses to collect with one.
- Post `phase {runId, name:"session", text}`, then renew that user's saved session, headless:
  `node swagger-import/scripts/browser_bridge.js renew --env <env> --user <user> --url <portalUrl> --api-origin <apiOrigin> (--present <selector> | --absent "input[type=password]") --to-studio`
  - The landmark: `--present` an element only a signed-in user of this app sees, if you know
    one; otherwise `--absent "input[type=password]"`.
  - `renew` picks the user's own saved session by itself: the saved login
    `test/.auth/<env>-<user>-state.json` that runs write, else the newest file whose name
    carries both the environment and the user. It loads it read-only and never rewrites it.
  - Never open, `cat`, print, copy or edit a `*-state.json` (or its `*-state.meta.json`), and
    never look for one yourself: `renew` reads it by itself.
  - A token goes to the studio by itself; you see only
    `"token":{"seen":true,"delivered":"studio"}`.
  - `"renewed": true`: if no value is still missing, post `ended`. Otherwise go on to the UI.
  - `"renewed": false` with a `reason` (`no-state-file`, `landmark-failed`, `no-token`,
    `playwright-missing`, `browser-failed`): a normal miss. Go on to the UI.

**The UI last**, only for values still missing or a token `renew` did not deliver. If the
environment has no `portalUrl`, post `failed {runId, reason}` in plain words (for example "no
application URL is configured for qc") and stop. The wizard goes on.
1. Open a headed session: `playwright-cli -s=agentex-collect open <portalUrl> --headed`.
2. Find the login form and `snapshot` it now, while no secret is on the page: take the refs of
   the fields and of the submit button from this snapshot. Fill the user's identifying field
   (from `users.<user>` in the environment file) yourself. If that field is itself an
   `{ "envSecret": "NAME" }`, it is a secret: type it with `fill_secret.js` (below, without a
   submit flag) just before the password.
3. Type the password last, through a script that submits in the same call. Its form is
   `users.<user>.password`, else `defaults.password`, in `environments/<env>.json`:
   - `{ "envSecret": "NAME" }`, the standard form: browser-driver's `fill_secret.js`, the
     plugin's only way to type a secret (browser-driver's Secret fields rule; read
     `browser-driver/references/tools/fill-secret.md` first):
     `node browser-driver/scripts/fill_secret.js --session agentex-collect --target <password ref> --env-var NAME --env <env> --submit-target <submit ref>`
     (`--submit` presses Enter instead).
   - A plain string (legacy; the secret scan warns on it): the bridge,
     `node swagger-import/scripts/browser_bridge.js fill-secret --session agentex-collect --locator <password field> --env <env> --user <user> --submit <submit button>`.
     `--submit` is required: without it the bridge types nothing (`"error":"submit-required"`).
     It refuses an `envSecret` password (`"error":"use-fill-secret"`) before touching the
     browser and gives the `fill_secret.js` call to run instead: run it as given, from the
     project root (`cwd`), as `command` in a POSIX shell or `commandPowerShell` in PowerShell.
   Rules:
   - Never type, read or echo a password: no `fill`, `type`, `press` or `run-code` carrying it,
     no `$NAME`, no reading `.env`.
   - Between the first secret fill and the submit, run no other playwright-cli command. A
     snapshot prints field values, password fields included, and every action writes one to
     `.playwright-cli/`; that is why the script submits in the same call.
   - Never wrap the login in `capture`, and never print the login request (`requests`,
     `request-body`): its body carries the password.
   - `"scrubbed": 0` (the bridge: `"passwordFieldCleared": false`): the page moved on, or no
     field kept the password. Go on to step 4.
   - `"scrubbed"` 1 or more (the bridge: `"passwordFieldCleared": true`): the login did not
     leave the page (wrong password, or a captcha/OTP on the same page), or the server sent the
     form back with the password in it. Every field on the page holding the password was emptied
     after the submit, so a snapshot is safe again — only after this scrub, never before. To
     try again, run the same call once more.
   - `"reason":"secret-unavailable"`: NAME is not set in `.env` (or not declared). Post
     `failed {runId, reason}` naming the variable, never a value, and stop the UI step.
   - `"reason":"target-not-found"`: nothing was typed. If no earlier secret fill on this page
     left a value, re-`snapshot` and retry once with the current ref; otherwise treat it as
     the next case.
   - Any other failure once a secret may be on the page (another BLOCKED, the bridge's
     `"error":"not-filled"` or `"passwordFieldStillFilled": true`): take no `snapshot`, `eval`
     or `screenshot` of that page. Close the session and post `failed`.
4. Prove the login by a landmark (optimize-login's rules: an element only a signed-in user
   sees, never the URL).
   - A captcha or OTP: post `gate {runId, kind:"captcha"|"otp"|"other", text}` and wait for
     `gate-cleared`. Never try to solve or bypass it.
   - If the tester does not clear it, post `failed` with the reason.
   - No landmark: post `failed {runId, reason:"sign-in not proven"}` and stop the UI step.
5. Walk the screens that load the data. Wrap each data-loading navigation or click in:
   `browser_bridge.js capture --session agentex-collect --api-origin <apiOrigin> (--goto <url> | --click <locator>) --to-studio --user <user>`
   - Use the `apiOrigin` from the event, or the API origin you see the app call if it differs.
   - The output lists the app's calls, redacted. A token seen on them goes to the studio by
     itself; you only see `"token":{"seen":true,"delivered":"studio"}`.
   - Map the observed values to needs (judgment) and post each as
     `value {runId, param, value, source:"ui", user, group, provenance:{screen, call}}`.
   - `call` is the method and path you observed; `group` is `ui:<call>` (one call, one group).
   - The server refuses a credential-shaped value (`"error":"credential-shaped"`). Never
     re-post it in another shape.
6. For a need you cannot fill, post `missing {runId, param, hint}`.
7. Post `phase {runId, name:"project"|"session"|"login"|"walk"|"create"|"done", text}` as you
   move, so the page shows live progress.

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

- Post `ended {runId, found, total}` only when collection succeeded.
- On any failure, post `failed {runId, reason}` and no `ended` after it: `failed` is final, and
  a later `ended` does not replace the failure note. The wizard always continues with project,
  typed and placeholder values.
- On `cancel`, stop the browser work and post `ended`.
- On `closed` (`reason: "approved" | "done" | "shutdown"`), stop waiting and summarize in chat:
  - the files written (`catalogPath`, `suitePath` from the event);
  - the counts by source (`bySource`) and any created items;
  - the token **reference** (`tokenRef`). Never its value.
  - any operation whose values come from different records: its cases carry a review note
    (the call may return 404), so the tester checks them first.
  - that the write cases stay skipped. "Approve and run now" runs them BLOCKED `case
    skipped`; each is enabled one at a time after the tester reviews it, never by a bulk
    strip of the `skip` lines (swagger-import's SKILL.md, "After a successful import", 3).

## 5. Outside the wizard (the tester asks in chat)

- **Refresh a token** for a user:
  1. If `users.<user>.disabled` is set in `environments/<env>.json` (a reason, or `true`),
     refuse that user. Name the reason, sign in as no one, type no credential, and offer the
     environment's users that are not disabled. Stop.
  2. Renew the user's saved session first, as in §2 with `--store <suite>` instead of
     `--to-studio`:
     `browser_bridge.js renew --env <env> --user <user> --url <portalUrl> --api-origin <origin> (--present <selector> | --absent "input[type=password]") --store <suite>`.
     The same rules hold: never open, print or edit a `*-state.json`; `renew` reads it by
     itself. On `"renewed": true`, report the token as below and stop.
  3. Only on `"renewed": false`: sign in as above, then
     `browser_bridge.js capture … --store <suite> --env <env> --user <user>`. It writes
     `test/.auth/api-tokens/<suite>-<env>.json` (0600; refused when that folder is not
     gitignored: point at `/update-agentex`). If the sign-in fails, report the failure and
     its reason, never a secret.
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
  page response or a log. `fill_secret.js` reads an `envSecret` password itself and never
  relays playwright-cli's output; the bridge redacts what it prints. After the submit, either
  one empties a password field still holding its value.
- The non-production guard is enforced by the server. It does not depend on you remembering
  it.
- The server refuses to collect with a user marked `disabled`. `renew` refuses one too, loads a
  saved session read-only and never prints or rewrites it; runs write that file, the wizard
  never does.
