---
name: agentex-init
description: Initialize AgenTeX for Codex in a QA project using the existing AgenTeX scaffold and install native Codex skills. Use for Codex AgenTeX setup.
---

# AgenTeX Codex init

Find the AgenTeX plugin checkout or installed directory. From the consumer project root, run `node <plugin-root>/scripts/codex/install.js init <absolute-project-root>`. This reuses the existing idempotent scaffold and installs Codex skills under `.agents/skills`. It does not call Claude marketplace commands. Read `.agentex/codex.json` for the plugin root. Then guide the user through the existing Setup Wizard with `node <plugin-root>/scripts/wizard/server.js <absolute-project-root>` if configuration is incomplete. Do not overwrite project configuration or secrets.
