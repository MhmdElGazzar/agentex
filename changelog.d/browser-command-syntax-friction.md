### Fixed
- **The agent issues browser commands in the shapes the CLI takes.** The browser driver's
  playwright-cli reference now has a table of every command a run uses, with its arguments
  and the options that exist: the target is positional (`click e12`), `type` takes no target,
  and there is no `--ref`, `--target` or per-command `--timeout`. When the CLI answers
  `Unknown option`, the agent reads `npx playwright-cli --help <command>` and corrects the call
  once, instead of guessing another flag. Such an error is now the agent's own: it no longer
  uses up the scenario's retry or turns a passing retry into FLAKY. A second one on the same
  step leaves the step BLOCKED with the CLI's error.
- **run-code is written as one function, and is no longer the retry for a failed click.** The
  reference states run-code's rules with a right and a wrong example each (an
  `async (page) => …` function, no `require`, DOM only inside `page.evaluate`, longer code from
  a file under the session's `logs/` folder). A click or fill that fails on a rendered page is
  reported as a defect, never redone through run-code, `force: true` or a JS click, which could
  turn a real bug into a PASS.
- **Two stale gotchas are gone.** `requests` exists and is now the way to capture every request
  since the page loaded, and multi-line run-code works through `--filename`. The viewport for a
  UI check is set with `resize` in the browser driver, ui-check and the executor.
