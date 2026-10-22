'use strict';
// The published capability matrix (references/tracker/capabilities.md) must
// match what the adapters DECLARE. Run: node scripts/lib/tracker/capabilities.test.js
//
// The test parses the matrix table: every row names its capability flag(s)
// (a dotted path into adapter.capabilities, or "—" for an op every tracker
// supports) and one cell per provider. A cell starting with "supported" needs
// every named flag truthy on that adapter; a cell starting with "refused" or
// "routed" needs at least one of them falsy. A row whose flag is `query`
// names the query language the adapter declares. Offline: adapters are
// constructed with an injected fetch that is never called.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ado = require('./adapters/ado.js');
const jira = require('./adapters/jira.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const MATRIX = path.join(__dirname, '..', '..', '..', 'references', 'tracker', 'capabilities.md');
const noFetch = async () => { throw new Error('no request expected'); };
function dir(config) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-caps-'));
  fs.mkdirSync(path.join(d, 'config'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', 'project.json'), JSON.stringify(config));
  return d;
}
const ADAPTERS = {
  ADO: ado.createAdapter({ cwd: dir({ azure: { org: 'exampleorg', project: 'Sample Project' } }), fetch: noFetch }).capabilities,
  Jira: jira.createAdapter({ cwd: dir({ jira: { site: 'example', project: 'PROJ' } }), fetch: noFetch }).capabilities,
};

function parseMatrix(md) {
  const lines = md.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\|\s*Operation\s*\|/.test(l));
  assert.ok(head >= 0, 'the matrix table (header "| Operation | Flag | ADO | Jira |") is missing');
  const cols = lines[head].split('|').slice(1, -1).map((c) => c.trim());
  assert.deepStrictEqual(cols, ['Operation', 'Flag', 'ADO', 'Jira']);
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const [op, flag, adoCell, jiraCell] = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ op, flags: flag === '—' ? [] : [...flag.matchAll(/`([^`]+)`/g)].map((m) => m[1]), ADO: adoCell, Jira: jiraCell });
  }
  return rows;
}
const lookup = (caps, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), caps);

const rows = parseMatrix(fs.readFileSync(MATRIX, 'utf8'));

test('the matrix has rows, each with a flag column and both provider cells', () => {
  assert.ok(rows.length >= 15, `only ${rows.length} rows`);
  for (const r of rows) {
    assert.ok(r.op && r.ADO && r.Jira, JSON.stringify(r));
    assert.ok(/^(supported|refused|routed)/.test(r.ADO) && /^(supported|refused|routed)/.test(r.Jira), `cells must start with supported/refused/routed: ${r.op}`);
  }
});

for (const provider of Object.keys(ADAPTERS)) {
  test(`every ${provider} cell matches the ${provider} adapter's declared flags`, () => {
    const caps = ADAPTERS[provider];
    for (const r of rows) {
      const cell = r[provider];
      if (!r.flags.length) {
        assert.ok(cell.startsWith('supported'), `${r.op}: a flagless op is supported everywhere`);
        continue;
      }
      if (r.flags.length === 1 && r.flags[0] === 'query') {
        assert.ok(cell.includes(caps.query), `${r.op}: ${provider} declares query '${caps.query}', the cell says "${cell}"`);
        continue;
      }
      const values = r.flags.map((f) => lookup(caps, f));
      if (cell.startsWith('supported')) {
        assert.ok(values.every(Boolean), `${r.op}: "${cell}" but ${provider} declares ${r.flags.map((f, i) => `${f}=${values[i]}`).join(', ')}`);
      } else {
        assert.ok(values.some((v) => !v), `${r.op}: "${cell}" but ${provider} declares every flag true (${r.flags.join(', ')})`);
        if (cell.startsWith('refused')) assert.ok(r.flags.some((f) => cell.includes(f)), `${r.op}: a refusal names its flag`);
      }
    }
  });
}

test('every op-gating flag the adapters declare appears in the matrix', () => {
  const named = new Set(rows.flatMap((r) => r.flags));
  for (const f of ['batchRead', 'comments', 'mentions', 'sprints', 'transitions', 'testPlans', 'testRuns',
    'relations.parent', 'relations.child', 'relations.related', 'relations.testedBy', 'query']) {
    assert.ok(named.has(f), `flag ${f} has no row`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
