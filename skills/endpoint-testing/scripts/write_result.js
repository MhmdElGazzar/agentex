'use strict';
// AgenTeX endpoint-testing — result.md for a suite run started from the suite editor (no agent
// attached, A8). Deterministic: the same suite-result.json renders the same bytes. Same
// heading, tally and per-case entries as api-executor's result.md, without a severity rating.
//
// Usage: node write_result.js --result <run-dir>/suite-result.json [--out <result.md>]
//          [--project <root>]   (reads each failing case's params from its suite file)
// Prints ONE JSON line: {"ok":true,"out":<path>} or {"ok":false,"error":...}. Exit 0 / 2.
const fs = require('fs');
const path = require('path');

const SEVERITY_LINE = 'Severity: not rated (run from the editor — ask the agent in chat to triage)';

function render(r, opts = {}) {
  const cases = r.cases || [];
  const lines = ['# API tests', ''];
  const meta = [`Run: ${r.startedAt || 'unknown'}`, `Environment: ${r.env || 'project default'}`, `Suite: ${r.suite || 'all suites'}`];
  if (r.case !== undefined) meta.push(`Case: ${r.case}`);
  lines.push(meta.join(' · '), '');
  lines.push('| Total | Passed | Failed | Blocked |', '|---|---|---|---|', `| ${r.total || 0} | ${r.passed || 0} | ${r.failed || 0} | ${r.blocked || 0} |`, '');
  lines.push(SEVERITY_LINE, '');
  if (r.reason && !cases.length) lines.push(`Run BLOCKED: ${r.reason}`, '');
  const fails = cases.filter(c => c.result === 'FAIL');
  lines.push('## Failures', '');
  if (!fails.length) lines.push('None.', '');
  for (const c of fails) {
    const params = opts.params ? opts.params(c.suite, c.index) : null;
    lines.push(`### ${c.name} (FAIL)`);
    lines.push(`- Steps to reproduce: run entry \`${c.entry}\`${params ? ` with params \`${JSON.stringify(params)}\`` : ''} (${c.suite || 'suite'} #${c.index || '?'})`);
    lines.push(`- Expected vs Actual: ${(c.failures && c.failures.length ? c.failures.join('; ') : c.reason || 'see the log')}${c.status !== undefined ? ` (actual status ${c.status})` : ''}`);
    lines.push(`- ${SEVERITY_LINE}`);
    lines.push(`- Evidence: ${c.log || 'no log'}`, '');
  }
  const blocked = cases.filter(c => c.result === 'BLOCKED');
  lines.push('## Blocked (not run)', '');
  if (!blocked.length) lines.push('None.', '');
  for (const c of blocked) lines.push(`- ${c.name} — ${c.reason}${c.suite ? ` (${c.suite} #${c.index})` : ''}`);
  if (blocked.length) lines.push('');
  lines.push(`${r.passed || 0} pass / ${r.failed || 0} fail / ${r.blocked || 0} blocked`);
  return lines.join('\n') + '\n';
}

function paramsFrom(root) {
  const cache = {};
  return (suite, index) => {
    if (!suite || !index) return null;
    try {
      cache[suite] = cache[suite] || JSON.parse(fs.readFileSync(path.join(root, suite), 'utf8'));
      const c = (cache[suite].cases || [])[index - 1];
      return c && c.params ? c.params : null;
    } catch { return null; }
  };
}

function writeResult(resultFile, outFile, root) {
  const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const md = render(r, root ? { params: paramsFrom(root) } : {});
  fs.writeFileSync(outFile, md);
  return outFile;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = k => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const resultFile = get('--result');
  if (!resultFile) { console.log(JSON.stringify({ ok: false, error: 'usage: --result <suite-result.json> [--out <result.md>] [--project <root>]' })); process.exit(2); }
  try {
    const outFile = writeResult(resultFile, get('--out') || path.join(path.dirname(resultFile), 'result.md'), get('--project'));
    console.log(JSON.stringify({ ok: true, out: outFile }));
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(2); }
}

module.exports = { render, writeResult, paramsFrom, SEVERITY_LINE };
