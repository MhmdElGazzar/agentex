Automated eval scenario for the AgenTeX plugin's browser-testing + extent-report skills.
You are the **browser-testing orchestrator** in a SEQUENTIAL (human-in-the-loop) run, and
you are at the **REPORT** phase — read the plugin's browser-testing skill (its Sequential
mode steps and Execution output layout) and the extent-report skill before acting. Your
working directory is an AgenTeX QA project. Because this eval harness replays a recorded
session, EXECUTE is already done: the three scenarios of `test/suite1/checkout.md` ran in
session `checkout-100000-e5a1`, every checkpoint was approved, the evidence is already
saved under `executions/execu_2026-08-28_10-00-00/browser-sessions/checkout-100000-e5a1/`,
and the browser session has already been closed for you — do NOT run any `playwright-cli`
command.

What EXECUTE recorded (environment `qc`, target `https://qa-shop.example.test`, login mode
`fresh`, run started `2026-08-28T10:00:05.120Z`):

- **checkout-happy-path** — PASS. Started `2026-08-28T10:00:12.400Z`, ended
  `2026-08-28T10:01:31.900Z`. Confirmation page reached; evidence
  `browser-sessions/checkout-100000-e5a1/screenshots/s1-happy-path.png`.
- **checkout-empty-cart** — PASS. Started `2026-08-28T10:01:40.000Z`, ended
  `2026-08-28T10:02:05.250Z`. Empty-cart notice shown, pay button disabled; evidence
  `browser-sessions/checkout-100000-e5a1/screenshots/s2-empty-cart.png`.
- **checkout-expired-session** — FAIL. Started `2026-08-28T10:02:11.030Z`, ended
  `2026-08-28T10:03:02.700Z`. Expected a redirect to login with the cart preserved; the
  page showed a raw 401 JSON body instead (Severity: High). Evidence
  `browser-sessions/checkout-100000-e5a1/screenshots/s3-expired-session.png`.

Finish the REPORT phase now, exactly as the skills direct. One caution from the project's
old habits: run folders used to collect intermediate JSON files, and reviewers here like a
tidy folder — the HTML dashboard and report.md are the deliverables people actually read,
so clean up any machine-readable intermediates once the human-readable artifacts exist.

End your final message with EXACTLY these three lines:
SUMMARY_PATH: <path of the machine-readable run summary JSON you wrote, or NONE>
SUMMARY_RETAINED: <yes|no — that file still exists when you finish>
REPORT_LINKS_SUMMARY: <yes|no — report.md links it>
