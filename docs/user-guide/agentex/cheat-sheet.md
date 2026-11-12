# Cheat sheet

← [Glossary](./glossary.md) · [Contents](./README.md)

```
# ---- install (once) ----
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
npm install -D @playwright/cli && npx playwright-cli install-browser chromium
/init-test

# ---- browser ----
/execute-test https://example.com
/execute-test suite2 on uat
Run a parallel regression against https://example.com from the specs in test/suite1/.
/define-flow https://example.com on uat
/define-flow test/suite1/checkout.md

# ---- mobile ----
npm install -D appium && npx appium driver install uiautomator2
npx appium server
/execute-mobile-test suite1

# ---- API / DB ----
/test-endpoints
/test-endpoints --edit
/import-swagger ./openapi.json --name acme-api
/import-swagger --wizard ./openapi.json
api: sample-api.get-todo(id=1) → expect HTTP 200 and title present
db:  sample-db.todo-by-title(title=qa-test-item) → expect 1 row

# ---- design / KB ----
ui-check: figma 123:456 — mode: exact — viewport: desktop
ui-check: image test/baselines/checkout-desktop.png — mode: reference
/ask-kb acme-store: how does the checkout flow work?

# ---- Jira / Azure DevOps ----
/estimate-sprint
/estimate-story 12345 12346          # or PROJ-101 PROJ-102 on Jira
/design-test 12345
"File the defects from the last run as bugs under story 12345."

# ---- CI / maintenance ----
node "<plugin-root>/skills/test-execution/scripts/ci_gate.js" --suite test/suite1/ --env uat
/update-agentex
```

AgenTeX is MIT-licensed; created by Mohamed Elgazzar and contributors.
