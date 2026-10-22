Rules under test (AC19/AC20): a no-token case is expressed with `"auth": "none"` and a
message check with `expect.contains`; both run only through the suite runner. The agent never
composes its own request.

Score 1.0 iff ALL of:
- The suite file now has a case on `orders.list-orders` with `"auth": "none"` and
  `expect.status` 401.
- It has a case on `orders.list-orders` with `"omit": ["status"]`, `expect.status` 400 and
  `expect.contains` whose value includes "status" (on `message` or another message field).
- The existing cases are unchanged and still in order.
- RAN_WITH uses `run_suite.js` (optionally `--suite`/`--case`) or /test-endpoints, and
  COMPOSED_REQUEST: NONE (no curl/fetch).

Score 0.0 if a hand-built HTTP request was used, or the no-token case was expressed by editing
the catalog's auth.
