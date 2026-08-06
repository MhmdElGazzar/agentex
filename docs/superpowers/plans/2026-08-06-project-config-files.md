# Project Config Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split AgenTeX project configuration out of `.env` into `config/project.json` and `environments/<env>.json`, with `{ envSecret }` secret references and full `.env` fallback for legacy projects.

**Architecture:** One shared resolver module (`scripts/lib/project_config.js`, plugin root) owns all file-loading, environment-selection, and secret-resolution logic, with its own unit tests. The three runner scripts (`run_db.js`, `run_api.js`, `ask_kb.js`) and `bug-report-azure/_lib.js` consume it. Skill/command instruction files and docs are updated to describe the new resolution order. `init.js` scaffolds the new layout from new plugin-root `templates/`.

**Tech Stack:** Node.js (CommonJS, zero dependencies), plain-`node` test scripts (same style as the existing `ask_kb.test.js`), markdown skill/command instructions.

**Spec:** `docs/superpowers/specs/2026-08-06-project-config-files-design.md` — read it before starting.

## Global Constraints

- **Resolution order everywhere: new files first, `.env` fallback second.** Legacy projects (no `config/`, no `environments/`) must keep working untouched.
- **The JSON config files never contain a secret.** Secret-valued fields are either a plain string (throwaway test creds only) or `{ "envSecret": "NAME" }` naming an `.env` variable.
- **Secrets are never printed, logged, or passed on a command line.** DB password only via the `SQLCMDPASSWORD` env var of the spawned process.
- **Environment selection:** explicit name → `defaultEnvironment` in `config/project.json` → null (legacy). A *named* environment with no file is an error listing available environments — never a silent fallback.
- Node scripts are CommonJS, no external dependencies, must run on Windows (never `process.exit` after a `fetch` — set `process.exitCode`; see existing comments in `run_api.js`).
- Runner scripts run with **cwd = consumer project root** and are invoked via `${CLAUDE_PLUGIN_ROOT}` paths; the shared lib is required with a relative path from each script's `__dirname`.
- `scripts/init.js` stays idempotent and non-destructive: never overwrite an existing file.
- All file paths below are relative to the plugin repo root `d:/Dnlds/projects/agentex`.

---

### Task 1: Shared resolver module `scripts/lib/project_config.js`

**Files:**
- Create: `scripts/lib/project_config.js`
- Create: `scripts/lib/project_config.test.js`

**Interfaces:**
- Consumes: nothing (foundation module).
- Produces (all later code tasks require this exact API):
  - `readEnvVar(cwd, name)` → `string|null` — `process.env` first, then a `KEY=value` line in `<cwd>/.env` (strips surrounding quotes).
  - `loadProjectConfig(cwd)` → `object` — parsed `config/project.json`, `{}` when absent; throws `Error("invalid JSON in <file>: …")` on bad JSON.
  - `listEnvironments(cwd)` → `string[]` — env names from `environments/*.json`, `[]` when the folder is absent, sorted.
  - `loadEnvironment(cwd, name)` → `{ name, …fileContents }|null` — resolves the active env (explicit `name` → `defaultEnvironment` → `null` = legacy); throws when a wanted env has no file, message lists available envs.
  - `resolveSecret(cwd, field)` → `string|null` — plain string → itself; `{ envSecret: "N" }` → `readEnvVar(cwd, "N")`; anything else → `null`.
  - `secretHint(field)` → `string` — `"env var N"` for envSecret refs, `"value"` otherwise (for error messages).
  - `resolveDbConnection(cwd, envName, catalogConn)` → `{ server, port, database, user, password, source }` — environment `db` block first, legacy catalog `connection` env-var names second; throws a BLOCKED-worthy `Error` when nothing resolves.
  - `resolveApiTarget(cwd, envName)` → `{ baseUrl, token, hasToken, tokenHint, source }|null` — environment `api` block, `null` when absent (caller falls back to the catalog).

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/project_config.test.js`:

```js
'use strict';
// Unit tests for the shared project-config resolver. Run: node scripts/lib/project_config.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pc = require('./project_config.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Fresh throwaway project dir per test, with optional files.
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-pc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// ---- readEnvVar ----
test('readEnvVar reads a .env line and strips quotes', () => {
  const dir = proj({ '.env': "DB_SERVER='srv.local'\nPLAIN=abc\n" });
  assert.strictEqual(pc.readEnvVar(dir, 'DB_SERVER'), 'srv.local');
  assert.strictEqual(pc.readEnvVar(dir, 'PLAIN'), 'abc');
  assert.strictEqual(pc.readEnvVar(dir, 'MISSING'), null);
});
test('readEnvVar prefers process.env over .env', () => {
  const dir = proj({ '.env': 'X_TEST_VAR=fromfile\n' });
  process.env.X_TEST_VAR = 'fromproc';
  try { assert.strictEqual(pc.readEnvVar(dir, 'X_TEST_VAR'), 'fromproc'); }
  finally { delete process.env.X_TEST_VAR; }
});

// ---- loadProjectConfig ----
test('loadProjectConfig returns {} when file is absent', () => {
  assert.deepStrictEqual(pc.loadProjectConfig(proj()), {});
});
test('loadProjectConfig parses config/project.json', () => {
  const dir = proj({ 'config/project.json': { name: 'demo', defaultEnvironment: 'qa' } });
  assert.strictEqual(pc.loadProjectConfig(dir).defaultEnvironment, 'qa');
});
test('loadProjectConfig throws on invalid JSON', () => {
  const dir = proj({ 'config/project.json': '{ nope' });
  assert.throws(() => pc.loadProjectConfig(dir), /invalid JSON/);
});

// ---- listEnvironments / loadEnvironment ----
test('listEnvironments: [] without folder, sorted names with it', () => {
  assert.deepStrictEqual(pc.listEnvironments(proj()), []);
  const dir = proj({ 'environments/uat.json': {}, 'environments/qa.json': {} });
  assert.deepStrictEqual(pc.listEnvironments(dir), ['qa', 'uat']);
});
test('loadEnvironment: null for legacy project (no name, no default)', () => {
  assert.strictEqual(pc.loadEnvironment(proj(), null), null);
});
test('loadEnvironment: explicit name wins over defaultEnvironment', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { portalUrl: 'https://qa' },
    'environments/uat.json': { portalUrl: 'https://uat' },
  });
  assert.strictEqual(pc.loadEnvironment(dir, 'uat').portalUrl, 'https://uat');
  assert.strictEqual(pc.loadEnvironment(dir, null).name, 'qa');
});
test('loadEnvironment: wanted-but-missing env throws listing available', () => {
  const dir = proj({ 'environments/qa.json': {} });
  assert.throws(() => pc.loadEnvironment(dir, 'live'), /available: qa/);
});

// ---- resolveSecret / secretHint ----
test('resolveSecret: literal string, envSecret ref, null', () => {
  const dir = proj({ '.env': 'MY_SECRET=s3cret\n' });
  assert.strictEqual(pc.resolveSecret(dir, 'plain'), 'plain');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'MY_SECRET' }), 's3cret');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'UNSET_VAR' }), null);
  assert.strictEqual(pc.resolveSecret(dir, null), null);
  assert.strictEqual(pc.secretHint({ envSecret: 'MY_SECRET' }), 'env var MY_SECRET');
});

// ---- resolveDbConnection ----
test('resolveDbConnection: environment db block wins, password via envSecret', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 'qa-db', port: 1434, name: 'QaDb', user: 'u1', password: { envSecret: 'QA_DB_PW' } } },
    '.env': 'QA_DB_PW=pw1\nDB_SERVER=legacy-db\n',
  });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER' });
  assert.strictEqual(c.server, 'qa-db');
  assert.strictEqual(c.port, '1434');
  assert.strictEqual(c.database, 'QaDb');
  assert.strictEqual(c.password, 'pw1');
});
test('resolveDbConnection: legacy catalog fallback reads .env by name', () => {
  const dir = proj({ '.env': 'DB_SERVER=legacy-db\nDB_NAME=LegacyDb\nSQLCMDPASSWORD=lpw\n' });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' });
  assert.strictEqual(c.server, 'legacy-db');
  assert.strictEqual(c.database, 'LegacyDb');
  assert.strictEqual(c.password, 'lpw');
});
test('resolveDbConnection: nothing resolvable throws', () => {
  assert.throws(() => pc.resolveDbConnection(proj(), null, {}), /no db config/);
});

// ---- resolveApiTarget ----
test('resolveApiTarget: env api block with envSecret token', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { api: { baseUrl: 'https://api.qa/', token: { envSecret: 'QA_TOKEN' } } },
    '.env': 'QA_TOKEN=tok1\n',
  });
  const t = pc.resolveApiTarget(dir, null);
  assert.strictEqual(t.baseUrl, 'https://api.qa'); // trailing slash stripped
  assert.strictEqual(t.token, 'tok1');
  assert.strictEqual(t.hasToken, true);
});
test('resolveApiTarget: null when no environment or no api block', () => {
  assert.strictEqual(pc.resolveApiTarget(proj(), null), null);
  const dir = proj({ 'config/project.json': { defaultEnvironment: 'qa' }, 'environments/qa.json': { portalUrl: 'x' } });
  assert.strictEqual(pc.resolveApiTarget(dir, null), null);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/lib/project_config.test.js`
Expected: crash with `Cannot find module './project_config.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/project_config.js`:

```js
'use strict';
// AgenTeX project-config resolver — the ONE place that knows where project data lives.
//
// Three kinds of data, three homes (see docs/superpowers/specs/2026-08-06-project-config-files-design.md):
//   secrets            → .env                        (only secrets)
//   project settings   → config/project.json         (azure, kb, login, defaultEnvironment)
//   environment data   → environments/<env>.json     (portalUrl, defaults, users, db, api)
//
// Resolution order everywhere: new files first, .env fallback second — so legacy
// projects (everything in .env) keep working untouched.
//
// Secret-valued JSON fields are either a plain string (throwaway test creds only)
// or { "envSecret": "NAME" } naming the .env variable that holds the real value.
const fs = require('fs');
const path = require('path');

// Read an env var: process.env first, then a KEY=value line in <cwd>/.env
// (the harness does not always load .env into process.env). null when unset.
function readEnvVar(cwd, name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    const re = new RegExp('^' + name + '\\s*=\\s*(.+)$', 'm');
    const m = fs.readFileSync(path.join(cwd, '.env'), 'utf8').match(re);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return null;
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
}

// config/project.json — {} when absent (legacy project).
function loadProjectConfig(cwd) {
  return readJsonIfExists(path.join(cwd, 'config', 'project.json')) || {};
}

// Names of defined environments; [] when environments/ doesn't exist.
function listEnvironments(cwd) {
  const dir = path.join(cwd, 'environments');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

// Active environment: explicit name → defaultEnvironment → null (legacy project).
// A wanted environment with no file is an error (fail fast, list what exists) —
// never a silent fallback to another environment.
function loadEnvironment(cwd, name) {
  const wanted = name || loadProjectConfig(cwd).defaultEnvironment || null;
  if (!wanted) return null;
  const file = path.join(cwd, 'environments', `${wanted}.json`);
  const data = readJsonIfExists(file);
  if (data === null) {
    const avail = listEnvironments(cwd);
    throw new Error(`environment "${wanted}" not found — ${avail.length ? `available: ${avail.join(', ')}` : 'this project has no environments/ folder'}`);
  }
  return { name: wanted, ...data };
}

// A secret-valued field: plain string = the literal value; { envSecret: "NAME" } =
// that variable's value (process.env → .env). null when unset/unresolvable.
function resolveSecret(cwd, field) {
  if (field == null) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && typeof field.envSecret === 'string') return readEnvVar(cwd, field.envSecret);
  return null;
}

// Human-readable pointer for "not set" error messages.
function secretHint(field) {
  return field && typeof field === 'object' && field.envSecret ? `env var ${field.envSecret}` : 'value';
}

// DB connection: active environment's db block first, legacy catalog "connection"
// env-var names second. Throws a BLOCKED-worthy Error when nothing resolves.
function resolveDbConnection(cwd, envName, catalogConn) {
  const environment = loadEnvironment(cwd, envName);
  const db = environment && environment.db;
  if (db) {
    if (!db.server) throw new Error(`environment "${environment.name}" db block has no "server"`);
    return {
      server: String(db.server),
      port: db.port !== undefined && db.port !== null && db.port !== '' ? String(db.port) : '',
      database: db.name ? String(db.name) : '',
      user: db.user ? String(db.user) : '',
      password: resolveSecret(cwd, db.password) || readEnvVar(cwd, 'SQLCMDPASSWORD'),
      passwordHint: db.password ? secretHint(db.password) : 'env var SQLCMDPASSWORD',
      source: `environments/${environment.name}.json`,
    };
  }
  const conn = catalogConn || {};
  const fromEnv = key => (conn[key] ? readEnvVar(cwd, conn[key]) : null);
  const server = fromEnv('serverEnv');
  if (!server) {
    throw new Error(conn.serverEnv
      ? `env var ${conn.serverEnv} (server) is not set`
      : 'no db config: add a "db" block to the active environment file (environments/<env>.json) or a "connection" block to the catalog');
  }
  return {
    server,
    port: fromEnv('portEnv') || '',
    database: fromEnv('databaseEnv') || '',
    user: fromEnv('userEnv') || '',
    password: readEnvVar(cwd, 'SQLCMDPASSWORD'),
    passwordHint: 'env var SQLCMDPASSWORD',
    source: 'catalog connection (.env)',
  };
}

// API target from the active environment's api block; null → caller falls back
// to the catalog's ${ENV_VAR} baseUrl / auth block (legacy path).
function resolveApiTarget(cwd, envName) {
  const environment = loadEnvironment(cwd, envName);
  const api = environment && environment.api;
  if (!api || !api.baseUrl) return null;
  return {
    baseUrl: String(api.baseUrl).replace(/\/$/, ''),
    token: resolveSecret(cwd, api.token),
    hasToken: api.token !== undefined && api.token !== null,
    tokenHint: secretHint(api.token),
    source: `environments/${environment.name}.json`,
  };
}

module.exports = {
  readEnvVar, loadProjectConfig, listEnvironments, loadEnvironment,
  resolveSecret, secretHint, resolveDbConnection, resolveApiTarget,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/lib/project_config.test.js`
Expected: `15 passed`, exit 0. Also run `node skills/ask-kb/scripts/ask_kb.test.js` — still `11 passed` (nothing touched, sanity).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/project_config.js scripts/lib/project_config.test.js
git commit -m "feat: shared project-config resolver (config/project.json + environments/<env>.json + envSecret refs)"
```

---

### Task 2: `run_db.js` — connection from the active environment

**Files:**
- Modify: `skills/db-integration/scripts/run_db.js:17-29` (args), `:64-81` (connection), `:84` (spawn env)
- Create: `skills/db-integration/scripts/run_db.test.js`
- Modify: `skills/db-integration/SKILL.md` (runner usage + docs), `skills/db-integration/references/sqlcmd.md:44` area (connection docs)

**Interfaces:**
- Consumes: `resolveDbConnection(cwd, envName, catalogConn)` from Task 1.
- Produces: `run_db.js` accepts a new optional `--env <name>` flag (orchestrators pass the active environment name); behavior otherwise unchanged (same JSON result line, same exit codes).

- [ ] **Step 1: Write the failing test**

Create `skills/db-integration/scripts/run_db.test.js`:

```js
'use strict';
// Tests for run_db.js config resolution — only BLOCKED paths that exit BEFORE
// sqlcmd is spawned (no sqlcmd needed). Run: node skills/db-integration/scripts/run_db.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run_db.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-rundb-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const CATALOG = {
  name: 'sample-db',
  connection: {},
  queries: [{ name: 'ping', description: 'x', params: [], query: 'SELECT 1' }],
};
// Run the runner in a scrubbed env so the host machine's DB_*/SQLCMDPASSWORD can't leak in.
function run(cwd, args) {
  const env = { ...process.env };
  for (const k of ['DB_SERVER', 'DB_PORT', 'DB_NAME', 'DB_USER', 'SQLCMDPASSWORD']) delete env[k];
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: JSON.parse((r.stdout || '{}').trim().split('\n').pop()) };
}

test('named environment without a file -> BLOCKED listing available', () => {
  const dir = proj({ 'integration/sample_db.json': CATALOG, 'environments/qa.json': {} });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--env', 'live', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /available: qa/);
});
test('env db block with user but unresolvable password -> BLOCKED naming the var', () => {
  const dir = proj({
    'integration/sample_db.json': CATALOG,
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 's', name: 'd', user: 'u', password: { envSecret: 'MISSING_PW' } } },
  });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /MISSING_PW/);
});
test('no environment and empty catalog connection -> BLOCKED with guidance', () => {
  const dir = proj({ 'integration/sample_db.json': CATALOG });
  const { code, out } = run(dir, ['--entry', 'sample-db.ping', '--log', path.join(dir, 'x.log')]);
  assert.strictEqual(code, 2);
  assert.match(out.reason, /no db config/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node skills/db-integration/scripts/run_db.test.js`
Expected: FAIL — current runner knows no `--env` flag (treats it as nothing and reason says `catalog connection.serverEnv missing`, not `available: qa` / `no db config`).

- [ ] **Step 3: Implement**

In `skills/db-integration/scripts/run_db.js`:

(a) Add to the header comment usage line: `[--env <environment-name>]`.

(b) In the args loop (line ~20), add an `envName` variable and flag:

```js
let entry, logPath, catalog = './integration', expectRows, expectMinRows, envName;
// … inside the for-loop:
  else if (a === '--env') envName = v();
```

(c) Replace the whole `---- connection from env ----` section (lines 64-81, from `const conn = def.connection || {};` through the `if (user)` line) with:

```js
// ---- connection: active environment's db block first, legacy catalog env names second ----
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
let c;
try { c = pc.resolveDbConnection(process.cwd(), envName, def.connection); }
catch (e) { blocked(e.message); }
if (c.user && !c.password) blocked(`DB password is not set — set ${c.passwordHint} in .env (never on the command line)`);
const srv = c.port ? `${c.server},${c.port}` : c.server;

const cmdArgs = ['-S', srv, '-C', '-b', '-h', '-1', '-W', '-s', '|', '-Q', sql];
if (c.database) cmdArgs.splice(2, 0, '-d', c.database);
if (c.user) cmdArgs.splice(2, 0, '-U', c.user); // password only via SQLCMDPASSWORD in the child env
```

(d) Change the `spawnSync` call (line ~84) to inject the resolved password (covers passwords that live in `.env` but were never exported, and per-env vars like `SQLCMDPASSWORD_UAT`):

```js
const r = spawnSync('sqlcmd', cmdArgs, {
  encoding: 'utf8', timeout: 30000,
  env: c.password ? { ...process.env, SQLCMDPASSWORD: c.password } : process.env,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node skills/db-integration/scripts/run_db.test.js` → `3 passed`.
Run: `node scripts/lib/project_config.test.js` → still `15 passed`.

- [ ] **Step 5: Update the skill docs**

In `skills/db-integration/SKILL.md`:
- In the runner usage block (lines 17-22), add `[--env <environment-name>]` after the `--param` line.
- Replace the sentence fragment in line 24-25 `resolves the connection from env vars,` with `resolves the connection (active environment's db block, else legacy catalog env vars),`.
- After the "Step syntax in test specs" section, add:

```markdown
## Where the connection comes from

1. **`environments/<env>.json` `db` block** of the active environment (pass the
   orchestrator's environment name via `--env`; omitted = the project's
   `defaultEnvironment`): `{ "server", "port", "name", "user", "password": { "envSecret": "SQLCMDPASSWORD" } }`.
2. **Legacy fallback** — the catalog's `connection` block naming `.env` vars
   (`serverEnv` …) exactly as before. Old projects keep working untouched.

The password is never in a JSON file: `db.password` is a `{ "envSecret": "NAME" }`
reference resolved from `.env` and handed to sqlcmd only through its environment.
```

In `skills/db-integration/references/sqlcmd.md`, below the `connection` example (line ~44), add a short note:

```markdown
> The `connection` block is the **legacy** path. When the project defines
> `environments/<env>.json` with a `db` block, the runner uses that instead
> (see SKILL.md "Where the connection comes from"); `--env <name>` selects the
> environment.
```

- [ ] **Step 6: Commit**

```bash
git add skills/db-integration
git commit -m "feat(db-integration): resolve connection from the active environment's db block, legacy .env fallback"
```

---

### Task 3: `run_api.js` — base URL and token from the active environment

**Files:**
- Modify: `skills/api-integration/scripts/run_api.js:20-33` (args), `:58-82` (env resolution + auth)
- Create: `skills/api-integration/scripts/run_api.test.js`
- Modify: `skills/api-integration/SKILL.md`, `skills/api-integration/references/api-requests.md:59` area

**Interfaces:**
- Consumes: `resolveApiTarget(cwd, envName)` from Task 1.
- Produces: `run_api.js` accepts optional `--env <name>`; same JSON result line and exit codes.

- [ ] **Step 1: Write the failing test**

Create `skills/api-integration/scripts/run_api.test.js`:

```js
'use strict';
// Tests for run_api.js environment resolution, against a local HTTP server.
// Run: node skills/api-integration/scripts/run_api.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run_api.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-runapi-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const CATALOG = {
  name: 'sample-api',
  baseUrl: '${API_BASE_URL}',
  auth: { type: 'none' },
  requests: [{ name: 'get-thing', method: 'GET', path: '/thing', params: [] }],
};
function run(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.API_BASE_URL; delete env.API_TOKEN;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: JSON.parse((r.stdout || '{}').trim().split('\n').pop()) };
}
function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  await test('environment api.baseUrl overrides catalog ${API_BASE_URL}', async () => {
    let hit = null;
    const { srv, port } = await serve((req, res) => { hit = req.url; res.end('{"ok":true}'); });
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}` } },
    });
    const { code, out } = run(dir, ['--entry', 'sample-api.get-thing', '--expect-status', '200', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(hit, '/thing');
  });

  await test('environment api.token envSecret becomes the bearer header', async () => {
    let auth = null;
    const { srv, port } = await serve((req, res) => { auth = req.headers.authorization; res.end('{}'); });
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: `http://127.0.0.1:${port}`, token: { envSecret: 'QA_TOKEN' } } },
      '.env': 'QA_TOKEN=tok-123\n',
    });
    const { code } = run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    srv.close();
    assert.strictEqual(code, 0);
    assert.strictEqual(auth, 'Bearer tok-123');
  });

  await test('api.token declared but unresolvable -> BLOCKED naming the var', async () => {
    const dir = proj({
      'integration/sample_api.json': CATALOG,
      'config/project.json': { defaultEnvironment: 'qa' },
      'environments/qa.json': { api: { baseUrl: 'http://127.0.0.1:9', token: { envSecret: 'NOPE_TOKEN' } } },
    });
    const { code, out } = run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /NOPE_TOKEN/);
  });

  await test('legacy path still works: catalog ${API_BASE_URL} from process env', async () => {
    const { srv, port } = await serve((req, res) => res.end('{}'));
    const dir = proj({ 'integration/sample_api.json': CATALOG });
    const { code } = run(dir, ['--entry', 'sample-api.get-thing', '--log', path.join(dir, 'x.log')],
      { API_BASE_URL: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node skills/api-integration/scripts/run_api.test.js`
Expected: first three tests FAIL (runner ignores environment files; BLOCKED on unset `API_BASE_URL`), last one passes.

- [ ] **Step 3: Implement**

In `skills/api-integration/scripts/run_api.js`:

(a) Header usage comment: add `[--env <environment-name>]`.

(b) Args loop (line ~23): add `envName`:

```js
let entry, logPath, catalog = './integration', expectStatus, expectFields = [], expectEquals = [], envName;
// … inside the for-loop:
  else if (a === '--env') envName = v();
```

(c) Replace the `---- env resolution ----` block's baseUrl line (line 65) and the auth block (lines 72-82) with:

```js
// ---- target: active environment's api block first, catalog ${ENV_VAR} refs second ----
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));
let target = null;
try { target = pc.resolveApiTarget(process.cwd(), envName); }
catch (e) { blocked(e.message); }
if (target && target.hasToken && !target.token) blocked(`${target.tokenHint} (api token) is not set`);
const baseUrl = target ? target.baseUrl : resolveEnvRefs(def.baseUrl || '');
let urlPath = req.path || '';
for (const [k, v] of Object.entries(params)) urlPath = urlPath.split(`{${k}}`).join(encodeURIComponent(v));
const unresolved = urlPath.match(/\{[a-zA-Z0-9_]+\}/);
if (unresolved) blocked(`unresolved placeholder ${unresolved[0]} in path`);
const url = baseUrl.replace(/\/$/, '') + urlPath;

const headers = { 'Accept': 'application/json' };
const auth = def.auth || { type: 'none' };
if (target && target.token) {
  headers['Authorization'] = `Bearer ${target.token}`; // environment token wins
} else if (auth.type === 'bearer') {
  const tok = process.env[auth.tokenEnv];
  if (!tok) blocked(`env var ${auth.tokenEnv} (bearer token) is not set`);
  headers['Authorization'] = `Bearer ${tok}`;
} else if (auth.type === 'basic') {
  const u = process.env[auth.userEnv], p = process.env[auth.passEnv];
  if (!u || !p) blocked(`env vars ${auth.userEnv}/${auth.passEnv} (basic auth) are not set`);
  headers['Authorization'] = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}
```

(Note: the `urlPath`/`unresolved`/`url` lines are the existing lines 66-70 kept in place — only the baseUrl source and the auth `if` chain change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node skills/api-integration/scripts/run_api.test.js` → `4 passed`.

- [ ] **Step 5: Update the skill docs**

In `skills/api-integration/SKILL.md`: add `[--env <environment-name>]` to the usage block, and after "Step syntax in test specs" add:

```markdown
## Where the target comes from

1. **`environments/<env>.json` `api` block** of the active environment
   (`--env <name>`, omitted = the project's `defaultEnvironment`):
   `{ "baseUrl": "https://…", "token": { "envSecret": "API_TOKEN" } }`.
   The token reference is resolved from `.env` — never a value in JSON.
2. **Legacy fallback** — the catalog's `${API_BASE_URL}` refs and `auth` block,
   exactly as before. Old projects keep working untouched.
```

In `skills/api-integration/references/api-requests.md` (line ~59 bullet about resolving env-var names), append:

```markdown
- When the project defines `environments/<env>.json` with an `api` block, its
  `baseUrl`/`token` override the catalog's env refs; `--env <name>` selects the
  environment.
```

- [ ] **Step 6: Commit**

```bash
git add skills/api-integration
git commit -m "feat(api-integration): resolve base URL and token from the active environment's api block"
```

---

### Task 4: `ask_kb.js` — kb settings from `config/project.json`

**Files:**
- Modify: `skills/ask-kb/scripts/ask_kb.js:29-32` (loadKbConfig), `:88-104` (precedence + messages)
- Modify: `skills/ask-kb/scripts/ask_kb.test.js` (add cases)
- Modify: `skills/ask-kb/SKILL.md:39-53`, `commands/ask-kb.md:16-34`, `docs/ask-kb.md:36-37`

**Interfaces:**
- Consumes: nothing from Task 1 (this script keeps its own tiny loaders — it predates the lib and already has `resolveEnv`; adding a lib dependency would change nothing observable). Precedence contract:
  `--flag` → `config/project.json` `kb.*` → `KB_*` (env/.env) → legacy `agentex.config.json` `kb.*` → default.
- Produces: same CLI, same JSON result lines.

- [ ] **Step 1: Add failing tests**

In `skills/ask-kb/scripts/ask_kb.test.js`: first add a second fixture helper next to the existing `fixtureCwd` (~line 27) — the existing one (writes `agentex.config.json`) stays untouched:

```js
// Fixture with the new config/project.json (and optionally the legacy file too).
function fixtureCwd2({ projectKb, legacyKb }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askkb-'));
  if (legacyKb) fs.writeFileSync(path.join(dir, 'agentex.config.json'), JSON.stringify({ kb: legacyKb }));
  if (projectKb) {
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({ kb: projectKb }));
  }
  return dir;
}
```

Then, after the existing "KB_PROJECT and KB_ORG env override config" test (~line 95), add:

```js
  // 2c. config/project.json kb block beats env and legacy agentex.config.json
  await test('config/project.json kb block wins over env and legacy config', async () => {
    let seen = null;
    const srv = await server((req, res, body) => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'x', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd2({
      projectKb: { project: 'proj-json', org: 'org-json' },
      legacyKb: { project: 'legacy', org: 'legacy-org' },
    });
    await run(cwd, { KB_ASK_BASE_URL: `http://127.0.0.1:${port}`, KB_PROJECT: 'env-proj', KB_ORG: 'env-org' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(seen.project, 'proj-json');
    assert.strictEqual(seen.org, 'org-json');
  });

  // 2d. kb.baseUrl in config/project.json used when KB_ASK_BASE_URL is unset
  await test('kb.baseUrl in config/project.json reaches the server', async () => {
    const srv = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, answer: 'x', sources: [], hasContext: true, isNoAnswer: false }));
    });
    const port = srv.address().port;
    const cwd = fixtureCwd2({ projectKb: { baseUrl: `http://127.0.0.1:${port}`, project: 'p1' } });
    const r = await run(cwd, { KB_ASK_BASE_URL: '' }, ['--question', 'Q']);
    srv.close();
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.result, 'OK');
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node skills/ask-kb/scripts/ask_kb.test.js`
Expected: 11 old pass, 2 new FAIL (project comes from env, baseUrl BLOCKED).

- [ ] **Step 3: Implement**

In `skills/ask-kb/scripts/ask_kb.js`, replace `loadKbConfig` (lines 29-32) with:

```js
// kb settings: config/project.json "kb" block (new home) + agentex.config.json (legacy).
function loadKbConfig(cwd) {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(cwd, ...f), 'utf8')).kb || {}; } catch { return {}; } };
  return { proj: read(['config', 'project.json']), legacy: read(['agentex.config.json']) };
}
```

In `main()` (lines 88-104), change the resolution lines to:

```js
const { proj, legacy } = loadKbConfig(cwd);

const question = typeof args.question === 'string' ? args.question : null;
// Precedence: --flag → config/project.json kb.* → KB_* (env/.env) → legacy agentex.config.json kb.* → default.
const project = (typeof args.project === 'string' ? args.project : null) || proj.project || resolveEnv(cwd, 'KB_PROJECT') || legacy.project || null;
const org = (typeof args.org === 'string' ? args.org : null) || proj.org || resolveEnv(cwd, 'KB_ORG') || legacy.org || 'acme';
const model = (typeof args.model === 'string' ? args.model : null) || proj.model || legacy.model || 'opus';
const cfgNum = (a, b, ok, dflt) => (ok(a) ? a : ok(b) ? b : dflt);
const timeoutMs = cfgNum(Number(proj.timeout_ms), Number(legacy.timeout_ms), n => n > 0, 120000);
const retries = cfgNum(proj.retries, legacy.retries, Number.isInteger, 2);
const logPath = typeof args.log === 'string' ? args.log : null;
const baseUrl = proj.baseUrl || resolveEnv(cwd, 'KB_ASK_BASE_URL');
const apiKey = resolveEnv(cwd, 'KB_ASK_API_KEY'); // secret — .env only, never JSON
```

And update the two BLOCKED messages (lines 103-104):

```js
if (!project) out({ result: 'BLOCKED', reason: 'no project: pass --project, set kb.project in config/project.json, or KB_PROJECT in .env' }, 2);
if (!baseUrl) out({ result: 'BLOCKED', reason: 'no KB base URL: set kb.baseUrl in config/project.json or KB_ASK_BASE_URL in .env' }, 2);
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `node skills/ask-kb/scripts/ask_kb.test.js` → `13 passed`.

- [ ] **Step 5: Update the docs**

- `skills/ask-kb/SKILL.md`: in the settings table (lines 39-41), change the source column to say each value comes from `config/project.json` `kb.baseUrl`/`kb.project`/`kb.org` with the `KB_*` var as fallback; line 44: `` `config/project.json` → `kb` block tunes the rest (legacy `agentex.config.json` still honored; missing key = documented default): ``; line 53: `` Project precedence: `--project` flag → `kb.project` in `config/project.json` → `KB_PROJECT` (`.env`) → legacy `agentex.config.json`. ``
- `commands/ask-kb.md` lines 16 and 34: same precedence rewrite (`config/project.json` first, `.env` fallback, legacy last).
- `docs/ask-kb.md` table (lines 36-37): note the new home `config/project.json` `kb` block with `KB_*` as fallback.

- [ ] **Step 6: Commit**

```bash
git add skills/ask-kb commands/ask-kb.md docs/ask-kb.md
git commit -m "feat(ask-kb): kb settings from config/project.json kb block, KB_* and legacy agentex.config.json as fallback"
```

---

### Task 5: Scaffold — templates, `init.js`, `.env.example`, `/init-test` command

**Files:**
- Create: `templates/config/project.json`, `templates/environments/qa.json`
- Modify: `scripts/init.js:93-102` area (new section), `.env.example` (full rewrite), `commands/init-test.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `/init-test` scaffolds `config/project.json` + `environments/qa.json`; `.env` scaffold becomes secrets-only.

- [ ] **Step 1: Create the templates**

`templates/config/project.json`:

```json
{
  "name": "my-project",
  "defaultEnvironment": "qa",
  "azure": {
    "org": "https://dev.azure.com/your-org",
    "project": "your-project",
    "team": "your-team",
    "assignee": "qa.engineer@example.com"
  },
  "kb": {
    "baseUrl": "http://localhost:3000",
    "project": "acme-store"
  },
  "login": { "mode": "session" }
}
```

`templates/environments/qa.json`:

```json
{
  "portalUrl": "https://example.com",
  "defaults": {
    "otp": "0000",
    "password": "Test@1234"
  },
  "users": {
    "valid_user": { "phone": "0550000001", "role": "customer" },
    "expired_user": { "phone": "0550000002", "notes": "for negative login scenarios" }
  },
  "db": {
    "server": "localhost",
    "port": 1433,
    "name": "my-database",
    "user": "qa_user",
    "password": { "envSecret": "SQLCMDPASSWORD" }
  },
  "api": {
    "baseUrl": "https://jsonplaceholder.typicode.com",
    "token": { "envSecret": "API_TOKEN" }
  }
}
```

- [ ] **Step 2: Rewrite `.env.example` (secrets only)**

Replace the whole file with:

```
# AgenTeX — secrets (example)
#
# Copy to `.env` and fill in the values:  cp .env.example .env
# `.env` is gitignored — never commit real secrets.
#
# ONLY secrets live here. Non-secret configuration lives in `config/project.json`
# (project settings) and `environments/<env>.json` (per-environment data) — those
# files reference these variables BY NAME via { "envSecret": "<NAME>" }.

# Azure DevOps PAT. The azure-devops CLI extension reads it from AZURE_DEVOPS_EXT_PAT —
# export it in your shell (the agent never prints or passes the PAT):
#   export AZURE_DEVOPS_EXT_PAT="$AZURE_PAT"
AZURE_PAT=

# SQL Server password — read natively by sqlcmd from the env; never on a command line.
SQLCMDPASSWORD=

# Bearer token for cataloged api: requests.
API_TOKEN=

# KB Ask shared secret, sent as x-api-key (required when the server has it set).
KB_ASK_API_KEY=
```

- [ ] **Step 3: Extend `init.js`**

In `scripts/init.js`, after section 4 (integration catalog, line ~102), insert:

```js
// ── 4b. Project config + environments (new layout; .env keeps only secrets) ──
copyFileIfAbsent(path.join(pluginRoot, 'templates', 'config', 'project.json'),
                 path.join(projectRoot, 'config', 'project.json'));
copyFileIfAbsent(path.join(pluginRoot, 'templates', 'environments', 'qa.json'),
                 path.join(projectRoot, 'environments', 'qa.json'));
```

(No change needed to the `.env` scaffold logic — it blanks whatever `.env.example` now contains.)

- [ ] **Step 4: Verify by scaffolding a scratch project**

```bash
DIR=$(mktemp -d) && node scripts/init.js "$DIR" && ls "$DIR/config" "$DIR/environments" && cat "$DIR/.env"
```

Expected: `[created] config/project.json`, `[created] environments/qa.json` lines in the output; `.env` contains only the four secret keys (empty values). Run it a second time on the same dir → all `[skipped]`.

- [ ] **Step 5: Update `commands/init-test.md`**

- In the scaffold list (lines 16-22) add two bullets: `- \`./config/project.json\` — project settings (Azure org/project, default environment, login mode)` and `- \`./environments/qa.json\` — sample environment (portal URL, defaults, test users, db/api targets)`; change the `.env` bullet to `keys-only secrets \`./.env\` (PAT, DB password, API token, KB key) …`.
- Rewrite step 2 (lines 27-29) to: tell the user to fill `config/project.json` + `environments/qa.json` with their real values and put secrets in `.env`; the agent may read all three but never prints secret values.
- In the closing paragraph (line 44), change "both need the `AZURE_*` keys in `.env`" to "both read the `azure` block in `config/project.json` (legacy `AZURE_*` keys in `.env` still work)".

- [ ] **Step 6: Commit**

```bash
git add templates .env.example scripts/init.js commands/init-test.md
git commit -m "feat(init-test): scaffold config/project.json + environments/qa.json; .env becomes secrets-only"
```

---

### Task 6: Azure consumers — `bug-report-azure/_lib.js` + Azure skill docs

**Files:**
- Modify: `skills/bug-report-azure/scripts/_lib.js:22-51`
- Modify: `skills/bug-report-azure/SKILL.md:17-24` (sources table)
- Modify: `skills/task-estimation/SKILL.md:35-38`, `skills/test-design/SKILL.md:39-42` (sources tables)
- Modify: `skills/azure-integration/references/azure-devops-cli.md:20-30` area, `docs/azure-devops.md:14-15`

**Interfaces:**
- Consumes: `loadProjectConfig`, `readEnvVar` from Task 1 (required as `../../../scripts/lib/project_config.js` from `skills/bug-report-azure/scripts/`).
- Produces: `loadConfig()` keeps its exact return shape (`{ org, project, team, areaPath, iterationPath, templateBugId, assignees, valueArea, environment, bugCategory, testPlanId, apiVersion }`) — callers unchanged.

- [ ] **Step 1: Rewrite config loading in `_lib.js`**

Replace lines 22-51 (the `---- config from .env ----` comment through the end of `loadConfig`) with:

First add `const path = require('node:path');` to the existing requires at the top of the file (next to the `node:fs` require at line 19). Then:

```js
// ---- config: config/project.json "azure" block first, legacy AZURE_* env fallback ----

const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

// Read one env var (process.env → .env), trimmed; empty => null.
function env(name) {
  const v = pc.readEnvVar(process.cwd(), name);
  return v === null || v === '' ? null : v;
}

// One value: azure block key first, env var second; empty/missing => null.
function pick(az, key, envName) {
  const j = az[key];
  if (j !== undefined && j !== null && String(j).trim() !== '') return String(j).trim();
  return env(envName);
}

// Resolve config. Anything null is ASKED at runtime or inherited from the parent
// story — never silently guessed.
function loadConfig() {
  const az = pc.loadProjectConfig(process.cwd()).azure || {};
  return {
    org: (pick(az, 'org', 'AZURE_URL') || '').replace(/\/+$/, '') || null, // {{ORG_URL}}
    project: pick(az, 'project', 'AZURE_PROJECT'),                         // {{PROJECT_NAME}}
    team: pick(az, 'team', 'AZURE_TEAM'),                                  // {{TEAM_NAME}}
    areaPath: pick(az, 'areaPath', 'AZURE_AREA_PATH'),                     // {{AREA_PATH}}
    iterationPath: pick(az, 'iterationPath', 'AZURE_ITERATION_PATH'),      // {{ITERATION_PATH}}
    templateBugId: pick(az, 'bugTemplateId', 'AZURE_BUG_TEMPLATE_ID'),     // {{TEMPLATE_BUG_ID}}
    // One or more assignees, comma-separated. Always asked.
    assignees: (pick(az, 'assignee', 'AZURE_ASSIGNEE') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    valueArea: pick(az, 'valueArea', 'AZURE_VALUE_AREA') || 'Business',
    environment: pick(az, 'environment', 'AZURE_ENVIRONMENT'),             // {{ENVIRONMENT}}
    bugCategory: pick(az, 'bugCategory', 'AZURE_BUG_CATEGORY'),            // {{BUG_CATEGORY}}
    testPlanId: pick(az, 'testPlanId', 'AZURE_TEST_PLAN_ID'),              // {{TEST_PLAN_ID}}
    apiVersion: pick(az, 'apiVersion', 'AZURE_API_VERSION') || '7.1',
  };
}
```

Also update the file-header comment (lines 4-8): config now lives in `config/project.json`'s `azure` block with `AZURE_*` `.env` keys as the legacy fallback; the PAT is still only `AZURE_DEVOPS_EXT_PAT` / `AZURE_PAT` in the environment. Note `bugTemplateId` in JSON maps to the internal `templateBugId` field. Numeric JSON values (e.g. `"bugTemplateId": 123`) are stringified by `pick` — same as env vars.

- [ ] **Step 2: Verify**

```bash
DIR=$(mktemp -d) && mkdir -p "$DIR/config" && printf '{"azure":{"org":"https://dev.azure.com/x/","project":"P1"}}' > "$DIR/config/project.json" && (cd "$DIR" && node -e "const l=require('d:/Dnlds/projects/agentex/skills/bug-report-azure/scripts/_lib.js'); const c=l.loadConfig(); console.log(c.org, c.project)")
```

Expected: `https://dev.azure.com/x P1` (trailing slash stripped, project from JSON). Then in the plugin repo run `node scripts/lib/project_config.test.js` (still passing) — and check `_lib.js` exports `loadConfig` (see its `module.exports` at the bottom of the file; keep it unchanged).

- [ ] **Step 3: Update the four instruction docs**

- `skills/bug-report-azure/SKILL.md` sources table (lines 17-24): change the source column entries from `` `AZURE_URL` / `az` defaults `` style to `` `azure.org` in `config/project.json` → `AZURE_URL` → `az` defaults `` (same pattern per row: JSON key first, env var as fallback, keep the "always asked" notes).
- `skills/task-estimation/SKILL.md` (lines 35-38) and `skills/test-design/SKILL.md` (lines 39-42): same rewrite of the source column — `` `azure.org` (`config/project.json`) → `AZURE_URL` / ask `` etc. for org/project/team/assignee.
- `skills/azure-integration/references/azure-devops-cli.md`: before the first `az devops configure` example (~line 20), add one sentence: "Resolve org/project/team from `config/project.json`'s `azure` block first (legacy `AZURE_*` keys in `.env` as fallback), then export them as shell vars for the commands below."
- `docs/azure-devops.md` step 2 (lines 14-15): "Fill the `azure` block in `config/project.json` — `org`, `project`, `team`, `assignee` (legacy `AZURE_*` keys in `.env` still work)."

- [ ] **Step 4: Commit**

```bash
git add skills/bug-report-azure skills/task-estimation/SKILL.md skills/test-design/SKILL.md skills/azure-integration docs/azure-devops.md
git commit -m "feat(azure): read org/project/team settings from config/project.json azure block, AZURE_* fallback"
```

---

### Task 7: Environment selection in the browser-testing flow

**Files:**
- Modify: `skills/browser-testing/SKILL.md` (new section + DISPATCH + rules), `agents/qa-executor.md:11-18` (params) and `:40+` (integration steps), `skills/optimize-login/SKILL.md:98-102`, `commands/execute-test.md`

**Interfaces:**
- Consumes: the file formats from the spec (no code).
- Produces: the prompt-level contract — orchestrator resolves the environment once and injects `ENVIRONMENT` (name), `TARGET_URL` (portalUrl), and the env's `defaults`/`users` into each `qa-executor`; executors pass `--env {{ENVIRONMENT}}` to the db/api runners.

- [ ] **Step 1: `skills/browser-testing/SKILL.md`**

(a) After the "## Role" section, insert:

```markdown
## Target & environment resolution

Resolve once, before any browser action, in this order:

1. **Explicit environment** — the user said "run on uat" / the spec has `env: uat`
   → read `environments/uat.json`.
2. **Default** — `defaultEnvironment` in `config/project.json` → that file.
3. **Legacy project** (no such files) → `QA_TARGET_URL` from `.env`, or the URL the
   user gave; no defaults/users available.

From the environment file: `portalUrl` is the target; `defaults` (fixed OTP, shared
test password, captcha flag, …) and `users` are the test data for every scenario in
the run. `users` is keyed by a descriptive handle — a spec step like "login as
expired_user" means the `users.expired_user` entry. A user without a `password`
field logs in with `defaults.password`. A `{ "envSecret": "NAME" }` value means:
read variable `NAME` from `.env` — never print it. A spec naming a user that is not
defined for the active environment is **BLOCKED** (report the missing handle), never
improvised.

Naming an environment that has no file is an **error**: stop and list the files in
`environments/`. Never silently fall back to another environment. Record the active
environment name in `report.md`.
```

(b) In Parallel-mode **DISPATCH** (step 3, line ~97): change the injected list to `SESSION`, `SESSION_DIR`, `WORKING_DIR`, `TARGET_URL`, `ENVIRONMENT`, `TEST_DATA` and add: "`ENVIRONMENT` is the resolved environment name (empty for legacy projects); `TEST_DATA` is the environment's `defaults` + `users` JSON (secrets left as `{ envSecret }` refs — the executor resolves them only at use time and never prints them)."

(c) Replace the Rules bullet (line 124-125) `` `.env` may be read to resolve config values… `` with: `` `config/project.json`, `environments/<env>.json`, and `.env` may be read to resolve config; never print, log, or pass secret values (tokens, credentials, envSecret targets) anywhere. ``

- [ ] **Step 2: `agents/qa-executor.md`**

In the PARAMETERS block (lines 11-18) add after `TARGET_URL`:

```
ENVIRONMENT:    {{ENVIRONMENT}}            # active environment name ("" for legacy projects)
TEST_DATA:      {{TEST_DATA}}              # defaults + users JSON from environments/<ENVIRONMENT>.json ("" if none)
```

In the INTEGRATION STEPS section (line ~40), add one bullet: "Pass `--env {{ENVIRONMENT}}` to `run_db.js` / `run_api.js` when ENVIRONMENT is non-empty, so DB/API hit the same environment as the browser." And after the evidence section add: "TEST_DATA is your test input (users, default OTP/password). A `{ \"envSecret\": \"NAME\" }` value = read `NAME` from the project's `.env` at use time; never print or log it."

- [ ] **Step 3: `skills/optimize-login/SKILL.md`**

In the "Session files are credentials" section (line ~98), extend the convention sentence: sessions are saved per environment — `test/.auth/<app>-<environment>-state.json` (e.g. `myapp-qa-state.json`); a session saved on one environment is never resumed on another. Add one sentence to "The loop" step 1: "Log in with a user from the active environment's `users` (password: the user's `password` or `defaults.password`; `login.mode` in `config/project.json` says whether to reuse saved sessions (`"session"`) or log in fresh every run (`"fresh"`))."

- [ ] **Step 4: `commands/execute-test.md`**

After the "Suite folder" block add:

```markdown
**Environment (if named in the arguments):**
- "on uat" / "env uat" selects `environments/uat.json` as the active environment;
  otherwise the project's `defaultEnvironment` applies (legacy projects: `.env`).
  An environment with no file is an error — list `environments/` and stop.
```

- [ ] **Step 5: Commit**

```bash
git add skills/browser-testing/SKILL.md agents/qa-executor.md skills/optimize-login/SKILL.md commands/execute-test.md
git commit -m "feat(browser-testing): resolve target, defaults and users from the active environment; plumb --env to executors"
```

---

### Task 8: Docs — configuration guide rewrite + remaining references

**Files:**
- Modify: `docs/configuration.md` (full rewrite), `docs/getting-started.md:36` + `:83`, `docs/api-db-steps.md:42` + `:49`, `test/README.md` (api/db bullet), `CHANGELOG.md` (new entry)

- [ ] **Step 1: Rewrite `docs/configuration.md`**

Replace the entire file with:

```markdown
# Configuration

Project data falls into three kinds, each with one home:

| Kind | Examples | Home |
|---|---|---|
| Secrets | PAT, passwords, API tokens | `.env` (**only** these) |
| Project settings | Azure org/project/team, login mode, KB settings | `config/project.json` |
| Environment data | portal URL, DB, API, test users, default OTP | `environments/<env>.json` |

**The JSON files never contain a secret.** A secret-valued field (`password`,
`token`) is either a plain string — acceptable only for team-known throwaway test
credentials like a shared QA password — or `{ "envSecret": "NAME" }` naming the
`.env` variable that holds the real value.

**Legacy projects keep working.** Everything below resolves the new files first and
falls back to the old `.env` variables (`QA_TARGET_URL`, `DB_*`, `AZURE_*`, `KB_*`)
when the files or blocks are missing.

## Walkthrough: setting up your first project

`/init-test` scaffolds all three: `config/project.json`, a sample
`environments/qa.json`, and a secrets-only `.env` (gitignored automatically).
Fill them in:

1. `config/project.json` — your Azure org/project/team (if you use ADO), the KB
   block (if you use `kb:` steps), and `defaultEnvironment`.
2. `environments/qa.json` — your portal URL, test users, defaults, and the `db` /
   `api` blocks if specs use `db:` / `api:` steps. Copy it to `uat.json` / `live.json`
   for more environments.
3. `.env` — the actual secret values.

## `config/project.json`

| Key | Purpose |
|---|---|
| `name` | Project name. |
| `defaultEnvironment` | Environment used when a run doesn't name one. |
| `azure.org` / `.project` / `.team` / `.assignee` | Azure DevOps settings (see [azure-devops.md](./azure-devops.md)); optional extras: `areaPath`, `iterationPath`, `bugTemplateId`, `testPlanId`, `valueArea`, `environment`, `bugCategory`, `apiVersion`. |
| `kb.baseUrl` / `.project` / `.org` | KB Ask settings (see [ask-kb.md](./ask-kb.md)). |
| `login.mode` | `"session"` = reuse saved optimize-login sessions; `"fresh"` = log in every run. |

## `environments/<env>.json`

| Key | Purpose |
|---|---|
| `portalUrl` | The target under test (required). |
| `defaults` | Non-secret static test values: `otp`, `password` (shared test credential), `captcha`, plus any project-specific keys. |
| `users` | Test accounts keyed by a descriptive handle (`valid_user`, `expired_user`, …) that specs refer to ("login as expired_user"). Fields free-form: `phone`, `role`, `idNumber`, `password`, `notes`, … A user without `password` uses `defaults.password`. |
| `db` | `server`, `port`, `name`, `user`, `password` — for cataloged `db:` steps. |
| `api` | `baseUrl`, `token` — for cataloged `api:` steps. |

Selecting the environment at run time: "run on uat" / `env: uat` in a spec →
`environments/uat.json`; otherwise `defaultEnvironment`. Naming an environment
that has no file is an error (available environments are listed) — never a silent
fallback.

## `.env` — secrets only

| Variable | Purpose |
|----------|---------|
| `AZURE_PAT` | Azure DevOps PAT — export as `AZURE_DEVOPS_EXT_PAT` in your shell; never printed or passed. |
| `SQLCMDPASSWORD` | DB password — read natively by `sqlcmd` from the env; never on a command line. |
| `API_TOKEN` | Bearer token for cataloged `api:` requests. |
| `KB_ASK_API_KEY` | KB Ask shared secret (`x-api-key`). |
| *(your own)* | Any variable referenced by an `{ "envSecret": "…" }` field — e.g. `SQLCMDPASSWORD_UAT`, `QA_TESTER_PASSWORD`. |

## Permissions

Plugin manifests can't ship permission rules. Copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's
`.claude/settings.json` (merge with anything already there). This pre-approves the
safe `playwright-cli` (and `az` / `curl` / `sqlcmd`) commands and denies secret
reads / destructive actions.

## Secret-handling rules

- JSON config files and catalog files hold env-var **names**, never secret values.
- Claude may read config keys but must never print or pass secrets.
- DB and PAT secrets are read from the environment (`SQLCMDPASSWORD`,
  `AZURE_DEVOPS_EXT_PAT`), never placed on a command line.
```

- [ ] **Step 2: Touch up the remaining pages**

- `docs/getting-started.md` line 36: "…and a `.env` file with setting names ready for you to fill in." → "…plus `config/project.json`, a sample `environments/qa.json`, and a secrets-only `.env` ready for you to fill in."; line 83: "— environment variables and secret handling." → "— the three config files (`config/project.json`, `environments/<env>.json`, `.env`) and secret handling."
- `docs/api-db-steps.md` line 42 (`- Env: \`API_BASE_URL\`, \`API_TOKEN\``) → `- Config: the active environment's \`api\` block (\`baseUrl\`, \`token\`); legacy \`API_BASE_URL\`/\`API_TOKEN\` in \`.env\` as fallback`; line 49 similarly → `- Config: the active environment's \`db\` block (\`server\`, \`port\`, \`name\`, \`user\`, \`password\`); legacy \`DB_*\` in \`.env\` as fallback`.
- `test/README.md`, in the "API & DB steps in specs" section, replace the secrets bullet with: `- Secrets are never in the catalog or config files — they name env vars (\`{ "envSecret": "…" }\` / \`tokenEnv\`); values live in \`.env\`/your shell. Connection details live in \`environments/<env>.json\`.`
- `CHANGELOG.md`: add a new top entry titled "Project config files — `.env` becomes secrets-only" summarizing: new `config/project.json` + `environments/<env>.json` (spec link), `{ envSecret }` convention, `--env` flag on the db/api runners, new scaffold, full legacy `.env` fallback.

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md docs/getting-started.md docs/api-db-steps.md test/README.md CHANGELOG.md
git commit -m "docs: rewrite configuration guide around config/project.json + environments/<env>.json"
```

---

### Task 9: Final verification sweep

**Files:** none created — verification only.

- [ ] **Step 1: Run every test file**

```bash
node scripts/lib/project_config.test.js && node skills/db-integration/scripts/run_db.test.js && node skills/api-integration/scripts/run_api.test.js && node skills/ask-kb/scripts/ask_kb.test.js
```

Expected: `15 passed`, `3 passed`, `4 passed`, `13 passed` — all exit 0.

- [ ] **Step 2: End-to-end scaffold check**

Run the Task 5 Step 4 scratch-dir scaffold again on a fresh dir; verify `config/project.json` parses (`node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" "$DIR/config/project.json"`), same for `environments/qa.json`.

- [ ] **Step 3: Stale-reference grep**

```bash
grep -rn "QA_TARGET_URL\|passwordEnv\|tokenEnv" --include="*.md" docs commands skills agents | grep -v "legacy\|fallback\|CHANGELOG\|superpowers"
```

Expected: only lines that intentionally describe the legacy fallback or the catalog's own `tokenEnv` auth format. Fix anything else found.

- [ ] **Step 4: Spec coverage check**

Re-read `docs/superpowers/specs/2026-08-06-project-config-files-design.md` section by section and confirm each maps to a completed task (principle → T8 docs; project.json → T5/T6/T4; environments file → T1-T3, T7; selection rules → T1, T7; skill table → T2, T3, T4, T6, T7; new .env → T5). Note anything missed and fix before closing.

- [ ] **Step 5: Commit (only if fixes were needed)**

```bash
git add -A && git commit -m "chore: post-implementation verification fixes"
```
