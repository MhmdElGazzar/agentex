# executions/

AgenTeX writes every run's output here — **you don't create these by hand**; the agent
creates a fresh timestamped folder per run:

```
executions/
└── execu_<YYYY-MM-DD_HH-MM-SS>/        # one folder per run
    ├── report.md                       # consolidated run report
    ├── browser-sessions/
    │   └── <session>/
    │       ├── logs/                    # console / network captures
    │       └── screenshots/             # one per scenario (pass & fail)
    └── bugs/
        ├── bug-list.md                  # consolidated defect list
        └── screenshots/                 # copies of bug-evidence shots
```

Run artifacts are gitignored (only this README is tracked). They're specific to each run
and each project, so there's no need to commit them.
