### Changed
- **The manual `curl` fallback no longer loads `.env`.** When the API runner cannot start, the
  fallback in `api-integration` used `set -a; . ./.env; set +a`, which put every key of `.env` in
  the shell and broke on values with spaces or `#`. It now uses only variables already set in the
  shell (yours, or CI's), checks that each is set without printing it, and stops with BLOCKED
  naming a missing variable. This matches the rule that the agent never reads `.env`.
