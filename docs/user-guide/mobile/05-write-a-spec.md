# 5. Write a spec

← [4. Your first run](./04-first-run.md) · [Your path](./README.md) · Next: [6. Run at scale →](./06-run-at-scale.md)

A spec is a short markdown file. This is the `login.md` that ships with AgenTeX, shortened:

```markdown
# Spec: App login
Drivers: mobile

## Acceptance criteria
- Valid user reaches the home screen
- Wrong password → visible error

## Scenarios
1. Log in as `valid_user`; expect the home screen's landmark
2. Wrong password → visible error
3. Empty fields → "required" errors

## Notes: crash / ANR in log = defect
```

| Line | Why it matters |
|------|----------------|
| `Drivers: mobile` | **Always keep this line.** Browser runs and CI skip the spec (BLOCKED) instead of opening a browser. |
| Acceptance criteria | What PASS means: visible outcomes, not internals. |
| `valid_user` | Users by name, defined in `environments/<env>.json`. Passwords are never written in the spec. |
| "landmark" | An element only that screen shows: the proof you are on it. |
| Notes: crash / ANR | Silent crashes still fail the test. ANR is Android's "app not responding". |

> **Make it reliable.** Ask developers for **accessibility ids** (Android `content-desc` /
> `resource-id`, iOS `accessibilityIdentifier`). Claude prefers them over text or XPath.

> **One file = one device session.** Keep steps that depend on each other (log in → act → check)
> in one file, marked "stateful — run in order".

Bonus: a mobile spec can also check the backend with `api:` and `db:` lines, using only the
requests and queries defined in your `integration/` catalog.
