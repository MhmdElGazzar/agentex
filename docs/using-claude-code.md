# Using Claude Code — the Basics

If you've never used an AI coding assistant like Claude Code before, start here — every other
page in this manual assumes you've read this one.

## What Claude Code is

Claude Code is a program you talk to in plain English. You type what you want, it does the
work — driving a browser, running commands, reporting back — and tells you what happened.
AgenTeX is a set of extra abilities ("skills") installed into Claude Code specifically for QA
testing.

## Typing a request

You just type what you want in plain language, the same way you'd ask a colleague:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Claude reads this, figures out which of its abilities apply (here: AgenTeX's browser-testing
skill), and gets to work.

## Slash commands

A **slash command** is a shortcut for a specific request — type `/` followed by a name and
some arguments, and Claude runs that exact ability with no guessing:

```
/execute-test https://example.com
```

Slash commands are optional — you can always just describe what you want in plain language
instead (like the signup form example above). AgenTeX's commands are listed in
[Getting Started](./getting-started.md).

## Approving actions

Claude Code often **pauses and asks before doing something** — especially before running a
command it hasn't run before, or before an AgenTeX skill takes an action like filing a bug.
You'll see a prompt asking you to approve, and nothing happens until you respond. This is a
safety feature, not a bug — you're always in control of what actually runs.

AgenTeX itself adds its own checkpoints on top of this: for example, a sequential test run
stops after planning scenarios and again after each one, so you can review before it continues.

## What you'll see during a run

When AgenTeX runs a test, you'll typically see:
- Claude explaining what it's about to do, in plain language, before doing it
- A real browser window opening and being driven through your scenario (if you're watching)
- A summary at the end: what passed, what failed, and where the evidence (screenshots, logs)
  was saved

Next: [Getting Started](./getting-started.md) — install AgenTeX and run your first test.
