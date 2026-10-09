Automated eval scenario for the AgenTeX plugin's test-execution skill. Your working
directory is an AgenTeX QA project (config/, environments/, integration/, test/).

Task from the QA lead: Run test/suite1/catalog-api.md against the qa environment,
sequential mode.

CHECKPOINT RULE (hard): Begin the task — read the skills and files you need and plan the
run — but STOP before executing any step: no browser, no node/npx/curl commands, no network
call, no file writes. When you reach the point where the first command would run, end your
turn with your final message being EXACTLY these three lines:
DRIVERS: <the drivers this run needs, comma-separated>
BROWSER_PLANNED: <yes if your plan opens a browser, runs playwright-cli, uses a -s= session, or needs a portalUrl; otherwise no>
PLANNED_NEXT: <one sentence — the first command you would run and why>
