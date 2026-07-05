# Tool: azure-cli (`az`)

Azure command-line tool. Read this when a task needs Azure resources (App Service, Storage,
Key Vault, AKS, resource groups, etc.) or when `az` is missing.

## Preflight & install
- Preflight: `az --version` (verify it's installed and check the version).
- If missing, install:
  - **Windows (preferred):** `winget install -e --id Microsoft.AzureCLI`
    - Or MSI: download from https://aka.ms/installazurecliwindows and run it.
    - Or PowerShell (admin):
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri https://aka.ms/installazurecliwindows -OutFile .\AzureCLI.msi; Start-Process msiexec.exe -Wait -ArgumentList '/I AzureCLI.msi /quiet'; Remove-Item .\AzureCLI.msi`
  - **macOS:** `brew update && brew install azure-cli`
  - **Linux (Debian/Ubuntu):** `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`
- After install, open a new shell so `az` is on PATH.
- Upgrade later with `az upgrade`.

## Auth
- `az login` — interactive browser login (opens a browser).
- `az login --use-device-code` — for headless/remote shells.
- Service principal (CI/non-interactive):
  `az login --service-principal -u <appId> -p <secret-or-cert> --tenant <tenantId>`
  - Never hardcode or print secrets; use env vars / a secret store. Do NOT echo `-p` values.
- `az account show` — current subscription · `az account list -o table` — list all
- `az account set --subscription "<name-or-id>"` — switch subscription

## Common usage
- **Config / discovery**
  - `az configure --defaults group=<rg> location=<region>` — set defaults
  - `az group list -o table` · `az group create -n <rg> -l <region>`
  - `az resource list -g <rg> -o table`
- **App Service (web apps)**
  - `az webapp list -o table`
  - `az webapp show -g <rg> -n <app>`
  - `az webapp log tail -g <rg> -n <app>` — stream logs
  - `az webapp deploy -g <rg> -n <app> --src-path <zip>` — deploy
- **Storage**
  - `az storage account list -o table`
  - `az storage blob list --account-name <acct> -c <container> -o table`
  - `az storage blob upload --account-name <acct> -c <container> -f <file> -n <name>`
- **Key Vault (read-only here; never print secret values to logs)**
  - `az keyvault list -o table`
  - `az keyvault secret list --vault-name <kv> -o table`
- **AKS**
  - `az aks list -o table`
  - `az aks get-credentials -g <rg> -n <cluster>` — write kubeconfig
- **Generic**
  - `az <group> <cmd> --help` — built-in help
  - Add `-o table | json | tsv` to control output; `--query "<JMESPath>"` to filter.

## Notes
- `az` is a standalone binary (Python-based) — **not** an npm package; install via winget/MSI,
  not `npm install`.
- Treat any subscription/tenant IDs, connection strings, and secrets as sensitive — never
  print them.
