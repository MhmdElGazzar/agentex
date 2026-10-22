'use strict';
// Legacy suite fixture for run_suite.test.js's backward-compatibility test: a suite written
// before the swagger-suite-wizard fields existed (no auth / omit / sources / contains), and a
// deterministic fake service. legacy-suite-snapshot.json is this fixture's per-case outcome
// captured with the runner on main before the new fields were added — it must never change.
const files = (port) => ({
  'integration/api_test_suites/legacy/legacy_api.json': {
    name: 'legacy', baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' },
    requests: [
      { name: 'get-item', method: 'GET', path: '/items/{id}', params: ['id'] },
      { name: 'list-items', method: 'GET', path: '/items', params: ['q'] },
      { name: 'add-item', method: 'POST', path: '/items', params: ['title'], body: { title: '{title}' } },
    ],
  },
  'integration/api_test_suites/legacy/legacy_suite.json': {
    name: 'legacy-suite',
    cases: [
      { name: 'get-200', entry: 'legacy.get-item', params: { id: 1 }, expect: { status: 200, fields: ['title'] } },
      { name: 'get-equals-pass', entry: 'legacy.get-item', params: { id: 1 }, expect: { equals: { title: 'one' } } },
      { name: 'get-equals-fail', entry: 'legacy.get-item', params: { id: 1 }, expect: { equals: { title: 'two' } } },
      { name: 'get-404', entry: 'legacy.get-item', params: { id: 999 }, expect: { status: 404 } },
      { name: 'get-wrong-status', entry: 'legacy.get-item', params: { id: 999 }, expect: { status: 200 } },
      { name: 'list-query', entry: 'legacy.list-items', params: { q: 'a b' }, expect: { status: 200, fields: ['count'] } },
      { name: 'add-skipped', entry: 'legacy.add-item', skip: 'review: write operation — remove this line to enable', params: { title: 'x' }, expect: { status: 201 } },
      { name: 'add-runs', entry: 'legacy.add-item', params: { title: 'x' }, expect: { status: 201, equals: { title: 'x' } } },
      { name: 'no-expect', entry: 'legacy.get-item', params: { id: 1 } },
      { name: 'unknown-entry', entry: 'legacy.nope', expect: { status: 200 } },
      { entry: 'legacy.get-item', expect: { status: 200 } },
      { name: 'missing-param', entry: 'legacy.get-item', expect: { status: 200 } },
    ],
  },
  'integration/api_test_suites/other/other_suite.json': {
    cases: [{ name: 'other-ok', entry: 'legacy.list-items', params: { q: 'z' }, expect: { status: 200 } }],
  },
});

function handler(req, res) {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/items/1') { res.end('{"title":"one"}'); return; }
    if (req.method === 'GET' && req.url.startsWith('/items?')) { res.end('{"count":2}'); return; }
    if (req.method === 'POST' && req.url === '/items') { res.writeHead(201); res.end(body); return; }
    res.writeHead(404); res.end('{"message":"not found"}');
  });
}

// What the snapshot keeps: the outcome, never paths, ports or timings.
function outcome(summary) {
  return {
    result: summary.result, total: summary.total, passed: summary.passed, failed: summary.failed, blocked: summary.blocked,
    cases: summary.cases.map((c) => ({ name: c.name, entry: c.entry, result: c.result, ...(c.status !== undefined ? { status: c.status } : {}), ...(c.skipped ? { skipped: true } : {}) })),
  };
}

module.exports = { files, handler, outcome };
