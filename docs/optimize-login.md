# Optimize Login

Login is usually the slowest, least interesting part of testing a web app — and if every
scenario logs in from scratch, that cost repeats every single time. This feature pays it once:
Claude drives the real login the first time, saves that logged-in session, and reuses it for
every later run — turning minutes of repeated login into seconds.

## Walkthrough

The first time a run needs to be logged in, Claude:
1. Opens the actual login page and figures out what it needs (a simple form is quick; a page
   with a captcha or one-time code takes more care).
2. Logs in for real, then double-checks it actually worked by looking for something only a
   logged-in page shows (never just the URL, which can be misleading — a login page can carry
   `?returnUrl=/dashboard` and still mean you're logged out).
3. Saves that logged-in session to a file.

On every later run, instead of repeating all of that, Claude reloads the saved session into a
fresh browser and double-checks it's still valid — this is the ~8-second version instead of the
~197-second one, measured on a real project. If the saved session has since expired, Claude
just logs in again from scratch and saves a fresh one — no action needed from you.

**If a captcha or a one-time code shows up:** Claude can't and won't try to bypass it. It runs
with a visible browser window and waits for you to complete that one step by hand — then saves
the session afterward, same as usual, so you only do it once.

## Quick reference

- Saved sessions live in `test/.auth/` by convention — **gitignored, never commit them.** A
  saved session file is effectively a password: whoever has it is logged in as that user.
- Only use this for applications you're authorized to test — it's for not repeating your own
  login, not for getting into anyone else's account.
- Applications that store their login in IndexedDB (rather than cookies/localStorage) can't be
  resumed this way — you'll see the post-load check fail plainly rather than a confusing error
  later.
- Skill: `skills/optimize-login/SKILL.md`
- Check a saved session without running a full test:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/skills/optimize-login/scripts/session.js resume \
    --state test/.auth/<app>-<environment>-state.json \
    --url   https://app.example.com/dashboard \
    --absent "role=button[name='Login']"
  ```
