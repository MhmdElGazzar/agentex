---
name: agentex-update
description: Update an initialized AgenTeX Codex project, preserving edited skills and configuration. Use for Codex AgenTeX updates.
---

# AgenTeX Codex update

Read `.agentex/codex.json` for the installed plugin root. Review the installed version and available source version if an update is requested. Never run Claude marketplace update commands. From the consumer project root, run `node <plugin-root>/scripts/codex/install.js update <absolute-project-root>`. This invokes the existing AgenTeX migration engine, then synchronizes native Codex skills only if their installed copies are unedited. Report any preserved user edits and migration flags. Updating the plugin source itself is a separate user-controlled operation.
