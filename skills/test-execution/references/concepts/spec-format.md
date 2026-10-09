# Concept: spec format

A spec is one markdown file under `test/<suite>/`. Conventions: `${CLAUDE_PLUGIN_ROOT}/test/README.md` and the `${CLAUDE_PLUGIN_ROOT}/test/suite1/` samples.

## Header (before the first `## ` heading)
| Line | Meaning |
|---|---|
| `Target: <url>` | The page under test. Required when the spec has browser steps; optional otherwise. |
| `Type: <text>` | Free text for the reader. Not machine-read. |
| `env: <name>` | Optional: run this spec against `environments/<name>.json`. |
| `Drivers: <list>` | Optional: the drivers this spec uses, e.g. `Drivers: api, db`. Authoritative when present. |

## Steps
- A numbered step with no prefix is a **browser** step (prose the browser-driver executes).
- A prefixed step goes to its driver: `api:` · `db:` · `kb:` · `ui-check:`. The prefix may follow a number (`2. api: …`), a `Step 4:` label, or a list bullet.
- `ui-check:` compares a live page, so it always implies `browser`.
- Mark a stateful chain in the spec ("stateful — run in order, in one session"). Its scenarios stay in one executor, in order.

## How the drivers of a spec are resolved (`spec_drivers.js`)
1. A `Drivers:` header wins.
2. Otherwise: `browser`, plus every prefix found in the steps. So every spec written before `Drivers:` existed resolves exactly as before.
3. Prefixes inside HTML comments or code fences do not count. `README.md` files and `.auth/` are skipped.
4. An unreadable spec resolves to `browser`, the strictest checks.

An API-only spec therefore declares `Drivers: api`: it needs no browser, no `Target:`, and no `portalUrl`.
