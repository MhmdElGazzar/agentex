### Fixed
- **Importing a Swagger/OpenAPI spec from a URL no longer hangs on a server that never answers.**
  The fetch now stops after 30 seconds and reports `could not fetch <url>: timed out after 30 s`.
- **Preflight checks the Node version.** The `node` entry now carries `required` (`>=20`, the version
  the CI templates and docs declare) and reports `ok: false` with both the found and the required
  version when Node is older.
