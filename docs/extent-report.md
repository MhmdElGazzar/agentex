# Interactive HTML Report

At the end of a run, you get more than a plain-text summary — AgenTeX can also produce a
standalone **`extent-report.html`**: a dark-themed dashboard you can open in any browser, no
server or internet connection needed.

## Walkthrough

Once your test run finishes, open `executions/execu_<timestamp>/extent-report.html` in any
browser. You'll see:
- A donut chart showing the pass/fail/blocked split at a glance
- Stat cards per status
- Expandable cards per test case — click one to see its step-by-step detail

Everything (CSS/JS) is inlined into that one file, so you can email it or attach it to a ticket
as-is — nobody else needs any special software to view it.

## Quick reference

Generated at the end of a run (one test case or a full batch), via the extent-report skill,
by the deterministic script:

```bash
node skills/extent-report/scripts/make_html_report.js
```

The file is written next to `report.md` in the same execution directory.

The **browser-testing** skill's REPORT and MERGE steps mention this report as an optional artifact
for creating an interactive dashboard alongside the test results.

**Reference:**
- Skill: `skills/extent-report/SKILL.md`
- Contributed by [@mabdel130](https://github.com/mabdel130) (PR #1).
