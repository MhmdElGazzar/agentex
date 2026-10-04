---
name: azure-integration
description: Interact with Azure resources from a QA/test run via the Azure CLI (`az`) — login/auth, discovery, and reading App Service, Storage, Key Vault, and AKS resources. Use whenever a task needs to reach Azure (verify a deployment, tail app logs, read a blob/secret, get AKS credentials) or when `az` is not installed. Read the reference before the first `az` command.
---

# Azure Integration

## Role
You connect a test run to Azure infrastructure through the Azure CLI (`az`, run via Bash).
You use Azure to **support** testing — verifying deployments, tailing logs, and reading
resources — not to provision or destroy infrastructure. Prefer read-only commands; get
explicit confirmation before any create/update/delete.

## Tool
Setup, install, auth, and common commands live in this skill's `references/` folder. **Read the
reference file BEFORE the first `az` command in a session**, and again whenever a command
behaves unexpectedly:
- **`${CLAUDE_PLUGIN_ROOT}/skills/azure-integration/references/azure-cli.md`** — Azure CLI (`az`):
  install-if-missing (winget/MSI/brew/apt), auth (interactive, device-code, service-principal),
  and common commands for App Service, Storage, Key Vault, and AKS.

## Rules
- Preflight `az --version` before use; install per the reference if it's missing.
- **Never print or log secrets** — subscription/tenant IDs, connection strings, Key Vault
  values, service-principal passwords. Do not echo `-p` values on `az login`.
- Default to read-only (`list`, `show`, `log tail`). Confirm with the user before any command
  that creates, updates, or deletes a resource.
- In CI/non-interactive shells, authenticate via service principal from env vars / a secret
  store — never hardcode credentials.
