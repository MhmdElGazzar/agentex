---
name: test-execution
description: Project copy of the AgenTeX test-execution skill. Use for test runs in this project.
---

# test-execution (project copy)

This is a fork of agentex:test-execution, copied into this project to change one thing.

The only change: in a CI run, do not require `FIGMA_TOKEN` when `config/project.json` has no
Figma `fileKey`. Without this change the CI preflight failed with `preflight-secrets` on this
project, which does not use Figma.

Everything else: follow the AgenTeX test-execution skill as installed.
