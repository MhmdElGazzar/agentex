# Getting Started

New to Claude Code itself? Read [Using Claude Code](./using-claude-code.md) first — this page
assumes you already know how to type a request and approve an action.

## 1. Install the plugin

AgenTeX installs through the **`elgazzar-plugins`** marketplace. From Claude Code:

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

> **Developing against a local clone?** Point the marketplace at your local copy of the
> `elgazzar-plugins` repo (the one containing `.claude-plugin/marketplace.json`) instead of GitHub:
> `/plugin marketplace add /path/to/elgazzar-plugins`, then install the same way.

## 2. Install the browser driver

In the project you want to test (Claude will offer to do this for you):

```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

## 3. Scaffold the project

```
/init-test
```

This creates a starting point in your project: sample test files in `test/suite1/` (editable
examples — adapt them to your app), an empty `executions/` folder where run results will land,
and a `.env` file with setting names ready for you to fill in.

## 4. Set permissions

Plugin manifests can't ship permission rules, so copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's `.claude/settings.json`
(merge with anything already there). This pre-approves the safe `playwright-cli` commands —
so Claude doesn't have to ask before every single one during a run — and denies secret reads /
destructive actions.

## 5. Run your first test

```
/execute-test https://example.com
```

Or just describe what you want, in plain language:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Here's what happens: Claude restates what it's about to test and proposes a numbered list of
scenarios — this is a checkpoint, nothing runs yet until you approve. Once you do, it opens a
real browser and works through each scenario one at a time, pausing after each one so you can
see the result before it continues. When it's done, everything lands in a new timestamped
folder:

```
executions/execu_<timestamp>/
├── report.md              # the final summary — what passed, what failed
├── extent-report.html     # an interactive dashboard version, open it in any browser
├── bugs/bug-list.md       # a merged list of every defect found
└── ...                    # screenshots and logs backing up every result
```

## Quick reference

- Install: `/plugin marketplace add MhmdElGazzar/elgazzar-plugins` then
  `/plugin install agentex@elgazzar-plugins`
- Browser driver: `npm install -D @playwright/cli && npx playwright-cli install-browser chromium`
- Scaffold: `/init-test`
- Permissions: copy the `permissions` block from [`settings.example.json`](../settings.example.json)
  into `.claude/settings.json`
- Run: `/execute-test <url>`

## Next steps

- [Browser Testing](./browser-testing.md) — sequential vs. parallel modes, writing your own specs.
- [Configuration](./configuration.md) — environment variables and secret handling.
- [docs/](./README.md) — the full feature reference.
