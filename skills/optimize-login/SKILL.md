---
name: optimize-login
description: >
  Pay a web application's login cost once per session instead of once per test — drive the
  login live, reduce it to the smallest script that works, save the browser session, and
  reload that session into a fresh browser to continue. Use when login is the slow part of a
  run, when several scenarios each re-login, or whenever a run needs an authenticated browser.
---

# Optimize Login — pay for the login once

Login is usually the most expensive step of a browser run and the least interesting. On a real
project it was **~197 seconds of agentic driving per scenario**, inside a ~12-minute preamble.
After applying this skill: **~38s once**, then **~8s** per later run.

The loop below is the same everywhere. **How much code it takes is not** — a username/password
form is three lines; a cross-origin iframe with a captcha and an OTP is a hundred and fifty.
Find out by looking, not by assuming.

## The loop

1. **Look at the real login.** Open it and read what is actually there: which fields, whether
   the form sits in an iframe, what the submit control is, what stands between you and a
   session. Never write the script from memory or from another application's login.
2. **Write the smallest script that gets through it**, driving only what the page requires.
3. **Prove you are in** — by a landmark, never by the URL (see below).
4. **Save the session** (`storageState`).
5. **Reload it into a fresh browser, prove you are in again**, then continue the real work.
6. **When the session dies, log in again.** Do not build renewal machinery; re-login is cheap
   once step 2 exists.

Steps 3–5 are identical in every application and ship with this skill:
`${CLAUDE_PLUGIN_ROOT}/skills/optimize-login/scripts/session.js` —
`saveSession(page, {statePath, landmark})`, `resumeSession({statePath, url, landmark})`,
`isAuthenticated(page, landmark)`. Steps 1–2 are yours to discover per application.

To check a saved session without writing any project code:

    node ${CLAUDE_PLUGIN_ROOT}/skills/optimize-login/scripts/session.js resume \
      --state test/.auth/<app>-state.json \
      --url   https://app.example.com/dashboard \
      --absent "role=button[name='Login']"

Prints one `RESULT: RESUME_PASS|RESUME_FAIL` line. Set `NODE_PATH=<project>/node_modules` if
`playwright` is not resolvable from the working directory.

## Verify by landmark, never by URL

A landmark is something true **only** when logged in: an element that appears (an account
menu), or one that disappears (the Login button). Pass `{present: sel}`, `{absent: sel}`, or
both.

URLs lie. A login page can carry `?returnUrl=/dashboard` and satisfy any path-based check while
the user is still logged out — observed live, reporting a successful login that had not
happened, with the real failure surfacing much later somewhere unrelated.

Verify **before** saving and again **after** loading. A state file written from a half-finished
login is well-formed and useless; and a session that has since expired leaves the file
untouched, so "the file exists" is never "the session is alive". Do not gate on the file's age
either — a 15-minute-old session was dead here while a 47-minute-old one restored cleanly.

## When a step does not work

Read the live page, not your assumptions: dump the fields, buttons, disabled states and any
error text **as they are at the moment of failure**, then fix that specific thing and re-run.
Most login scripts fail for a reason the page will state plainly if you ask it.

Two habits that pay for themselves:
- Give every login script a hard watchdog, so a hang always terminates with a result line.
- Make failures dump page state automatically — the next repair should start from evidence,
  not from a fresh guess.

## Record what you learn, per application

Whatever you discover about a specific login — a control that ignores clicks on its label, a
field the server reads that the visible inputs never populate, a step that opens on a different
method than you expect — belongs in that application's own notes, not in this skill. In a
project using the AgenTeX page map, that means the page's `gotchas`.

This is deliberate. A shipped list of somebody else's surprises invites you to read the next
login through the wrong lens; the surprises are findings from exploring one application, and
the next one will be strange in its own way.

## Limits

- **Gates are surfaced, never defeated.** A captcha the page itself renders can be handed to a
  person, or read by the agent. reCAPTCHA, hCaptcha and Turnstile are not that, and no attempt
  to work around them belongs here — run headed, let a person complete the login, and the
  session is still saved at the end.
- **An OTP you cannot obtain is a stop.** Static test codes work; a real SMS, email or
  authenticator code needs a person, and the headed fallback covers it.
- **`storageState` is cookies and localStorage only.** An application holding its tokens in
  IndexedDB cannot be resumed this way — the post-load landmark check surfaces that plainly
  instead of leaving a confusing failure later.
- **Only for applications you are authorised to access.** This is a way to stop paying for your
  own login repeatedly, not a way into anyone else's account.

## Session files are credentials

A saved session is a bearer token in a file: whoever holds it is logged in as that user. Keep
these in a git-ignored directory (`test/.auth/` by convention here) and never commit one.
