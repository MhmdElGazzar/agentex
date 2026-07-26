# Getting Started

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

In the project you want to test (the agent will offer to do this for you):

```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

## 3. Scaffold the project

```
/init-test
```

This scaffolds sample specs (`test/suite1/`), the `executions/` output folder, and a keys-only `.env`.

## 4. Set permissions

Plugin manifests can't ship permission rules, so copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's `.claude/settings.json`
(merge with anything already there). This pre-approves the safe `playwright-cli` commands and denies
secret reads / destructive actions.

## 5. Run

```
/execute-test https://example.com
```

Or just ask in natural language:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Every run writes to a timestamped `executions/execu_<timestamp>/` folder — `report.md`,
`extent-report.html`, per-session logs/screenshots, and a merged bug list.

## Next steps

- [Browser Testing](./browser-testing.md) — sequential vs. parallel modes, writing specs.
- [Configuration](./configuration.md) — environment variables and secret handling.
- [docs/](./README.md) — the full feature reference.
