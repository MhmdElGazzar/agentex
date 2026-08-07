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
    ├── bugs/
    │   ├── bug-list.md                  # consolidated defect list
    │   └── screenshots/                 # copies of bug-evidence shots
    └── design/                          # design-vs-build runs only
        └── figma-<node>.png             # design baseline (the /images PNG, downloaded)
```

A **design-vs-build** run (`figma-integration` SKILL §6) stores the design baseline in `design/`
and the matching live capture under `browser-sessions/<session>/screenshots/`. The Figma image URL
expires in ~30 minutes, so the PNG must be downloaded into the run folder — never referenced by
link.

Run artifacts are gitignored (only this README is tracked). They're specific to each run
and each project, so there's no need to commit them.
