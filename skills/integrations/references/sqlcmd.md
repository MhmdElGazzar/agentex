# Tool: sqlcmd (SQL Server) — executing `*_db.json` entries

How to execute a cataloged database query. Read before the first `db:` step in a session.
v1 targets **SQL Server** via `sqlcmd`; other engines (psql/mysql) can be added as sections
here later.

## Preflight & install
- Preflight: `sqlcmd "-?"` (or `sqlcmd --version` for the new go-sqlcmd).
- If missing:
  - **Windows:** `winget install -e --id Microsoft.Sqlcmd` (modern go-sqlcmd)
  - **macOS:** `brew install sqlcmd`
  - **Linux (Debian/Ubuntu):** install `mssql-tools18` per Microsoft's repo instructions, then
    ensure `/opt/mssql-tools18/bin` is on PATH.
- Offer before installing; don't install without confirmation in sequential mode.

## Connection — env vars only, never credentials on the command line

The catalog file names the env vars; the user sets the values in `.env`/shell:

```json
{
  "name": "sample-db",
  "engine": "sqlserver",
  "connection": { "serverEnv": "DB_SERVER", "portEnv": "DB_PORT", "databaseEnv": "DB_NAME", "userEnv": "DB_USER" },
  "queries": [
    { "name": "todo-by-title", "params": ["title"],
      "query": "SELECT TOP 1 Id, Title, Status FROM Todos WHERE Title = '{title}' ORDER BY Id DESC" }
  ]
}
```

```bash
# Password comes ONLY from the SQLCMDPASSWORD env var (sqlcmd reads it natively).
# NEVER pass -P — a password on the command line leaks into logs/history.
export SQLCMDPASSWORD  # user exports it in their shell / .env

# Compose the server value: SQL Server appends the port with a COMMA (not a colon).
# DB_PORT empty → default 1433.
SRV="$DB_SERVER"; [ -n "$DB_PORT" ] && SRV="$DB_SERVER,$DB_PORT"

sqlcmd -S "$SRV" -d "$DB_NAME" -U "$DB_USER" -C -b \
  -Q "SELECT TOP 1 Id, Title, Status FROM Todos WHERE Title = 'qa-test-item' ORDER BY Id DESC" \
  > "$SESSION_DIR/logs/s6-todo-by-title.log" 2>&1
```

- `-C` trusts the server certificate (typical for staging); `-b` makes SQL errors set a nonzero
  exit code so failures are detectable.
- For Azure AD / integrated auth omit `-U` and use `-G`/`-E` per the environment; ask the user
  once which applies.

## Parameter substitution — do it carefully
- Substitute values ONLY into the declared `{param}` placeholders in the cataloged query.
- Escape single quotes in values by doubling them (`O'Brien` → `O''Brien`).
- Refuse values containing `;`, `--`, `/*`, or newlines — surface to the user instead.
- Never concatenate anything else into the SQL; the cataloged text is the query.

## Safety (restated from the skill)
- Execute only cataloged queries. Writes (INSERT/UPDATE/DELETE) run if cataloged.
- **DDL ban is absolute**: refuse any query containing `DROP`, `TRUNCATE`, or `ALTER` even if
  it is in the catalog — report it as a catalog error.

## Asserting the expectation
- Row present/absent, column values: read the log output (sqlcmd prints a result table; add
  `-h -1 -W` for terse parseable output when needed).
- Mismatch = FAIL defect; the log file is the evidence.
