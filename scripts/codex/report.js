'use strict';
// Codex-only translation to the existing v2 capture schema and HTML renderer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { inspect } = require('./host');
const { pending, mismatch, projectUiReport } = require('./ui_outcomes');
const { COUNT_KEYS } = require('../../skills/test-execution/scripts/write_verdict');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const statuses = { PASS: 'passed', FAIL: 'failed', BLOCKED: 'blocked', NOT_ATTEMPTED: 'notrun', WARNING: 'warning', FLAKY: 'flaky' };
const blocked = code => ({ ok: false, verdict: 'BLOCKED', exitCode: 2,
  coverage: { required: 0, recorded: 0 }, errors: [{ code }] });
const aggregate = rows => rows.some(x => x.verdict === 'FAIL') ? 'FAIL'
  : rows.some(x => x.verdict === 'BLOCKED') ? 'BLOCKED' : 'PASS';
function timing(value) {
  return value && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.endedAt)) &&
    Date.parse(value.endedAt) >= Date.parse(value.startedAt) && Number.isInteger(value.durationMs) &&
    value.durationMs >= 0 && value.durationMs <= Date.parse(value.endedAt) - Date.parse(value.startedAt);
}
function render(summaryFile, htmlFile) {
  const child = spawnSync(process.execPath, [path.resolve(__dirname,
    '../../skills/extent-report/scripts/make_html_report.js'), summaryFile, htmlFile],
  { encoding: 'utf8', windowsHide: true });
  if (child.error || child.status !== 0) throw Error('HTML renderer failed');
}
function report(runRootInput, metadata, options = {}) {
  const runRoot = path.resolve(runRootInput);
  const summaryFile = path.join(runRoot, 'run-summary.json');
  const htmlFile = path.join(runRoot, 'extent-report.html');
  const verdictFile = path.join(runRoot, 'verdict.json');
  let rows = [];
  try {
    const custody = read(path.join(runRoot, 'custody.json'));
    if (custody.runRoot !== runRoot || !Array.isArray(custody.assignments) || !custody.assignments.length ||
        new Set(custody.assignments.map(x => x.assignmentId)).size !== custody.assignments.length) throw Error('invalid custody');
    for (const record of custody.assignments) {
      let checked;
      try { checked = inspect(runRoot, record.assignmentId); }
      catch { checked = { validation: blocked('ingestion-error') }; }
      let validation = checked.validation;
      const validationFile = path.join(runRoot, 'validation', record.assignmentId + '.json');
      if (fs.existsSync(validationFile)) {
        try {
          if (!isDeepStrictEqual(read(validationFile), validation)) throw Error('mismatch');
        } catch {
          // Never demote a freshly validated product FAIL to an infrastructure verdict.
          validation = { ...validation, ok: false, verdict: validation.verdict === 'FAIL' ? 'FAIL' : 'BLOCKED',
            exitCode: validation.verdict === 'FAIL' ? 1 : 2,
            errors: [...validation.errors, { code: 'persisted-validation-mismatch' }] };
        }
      } else write(validationFile, validation);
      rows.push({ ...checked, record, validation, verdict: validation.verdict });
    }
    if (!timing(metadata?.run)) throw Error('observed run timing required');
    const summary = { total: rows.length, ...Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) };
    const testCases = rows.map(({ record, result, validation, deferred }) => {
      const capture = metadata.scenarios?.[record.assignmentId];
      if (!timing(capture)) throw Error('observed scenario timing required');
      const outcome = validation.ok ? result.scenarioOutcome : validation.verdict;
      const uiSteps = validation.ok ? result.steps : [];
      const onlyMismatchBlocking = outcome === 'BLOCKED' && uiSteps.some(mismatch) &&
        !uiSteps.some(step => step.outcome === 'BLOCKED' && !mismatch(step));
      const status = onlyMismatchBlocking ? 'viewMismatch' : statuses[outcome];
      summary[status === 'warning' ? 'warnings' : status]++;
      return { name: record.sourceIdentity, spec: record.sourceIdentity, status,
        startedAt: capture.startedAt, endedAt: capture.endedAt, durationMs: capture.durationMs,
        session: custody.sessionId,
        steps: validation.ok ? result.steps.map(step => ({ desc: step.stepId,
          status: mismatch(step) ? 'viewMismatch' : statuses[step.outcome],
          note: mismatch(step) ? `VIEW MISMATCH ERROR: ${step.uiCheck.reason}` : pending(step)
            ? `needs-user: ${step.uiCheck.question}` : typeof step.note === 'string' ? step.note : '',
          ...(step.uiCheck ? { uiCheck: projectUiReport(step) } : {}),
          evidence: (step.evidence || []).map(ref => ({ path: ref.path, caption: step.stepId })) }))
          : [{ desc: 'Authoritative validation', status, note: validation.errors.map(e => e.code).join(', ') }],
        ...(deferred?.length ? { deferred } : {}),
        validation: { ...validation, assignmentId: record.assignmentId } };
    });
    // Optional caller assertions may detect discrepancies, but can never supply counts.
    if (metadata.summary && !isDeepStrictEqual(metadata.summary, summary)) throw Error('inconsistent reported counts');
    const verdict = aggregate(rows);
    const blockedReasons = rows.flatMap(x => x.validation.ok ? (x.result?.steps || [])
      .filter(pending).map(step => ({ code: 'needs-user', detail: step.uiCheck.question })) : []);
    const output = { ok: rows.every(x => x.validation.ok), verdict, exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[verdict],
      counts: summary, coverage: rows.map(x => ({ assignmentId: x.record.assignmentId, ...x.validation.coverage })),
      ...(blockedReasons.length ? { blockedReasons } : {}) };
    const data = { schemaVersion: 2, title: 'Codex sequential execution', date: metadata.run.startedAt.slice(0, 10),
      run: { startedAt: metadata.run.startedAt, endedAt: metadata.run.endedAt, durationMs: metadata.run.durationMs,
        mode: 'sequential', sessions: rows.map(x => ({ session: custody.sessionId, spec: x.record.sourceIdentity,
          label: x.record.assignmentId })) }, summary, testCases, validation: output };
    for (const key of ['environment', 'targetUrl', 'loginMode', 'tools']) {
      if (metadata.run[key] !== undefined) data.run[key] = metadata.run[key];
    }
    if (data.run.loginMode && !['fresh', 'session'].includes(data.run.loginMode)) throw Error('invalid login mode');
    // Clear an earlier success before attempting any output. A crash cannot leave a current PASS verdict.
    write(verdictFile, { ...blocked('report-incomplete'), counts: summary });
    write(summaryFile, data);
    const md = ['# Codex sequential execution', '', `Verdict: **${verdict}** (exit ${output.exitCode})`, '',
      `Environment: ${data.run.environment || 'not specified'}`, '',
      `Scenarios: ${summary.total}; passed: ${summary.passed}; failed: ${summary.failed}; blocked: ${summary.blocked}; view mismatch: ${summary.viewMismatch}; warnings: ${summary.warnings}; flaky: ${summary.flaky}.`, '',
      '[Run summary (JSON)](./run-summary.json) | [HTML report](./extent-report.html)', '',
      ...testCases.flatMap(tc => [`## ${tc.name}`, '', `Status: ${tc.status}; validation: ${tc.validation.verdict}.`, '',
        ...tc.steps.flatMap(step => [`- ${step.desc}: ${step.status}${step.note ? ' — ' + step.note : ''}`,
          ...(step.evidence || []).map(e => `  - [Evidence](${e.path})`)]), '']),
      ...(summary.flaky ? ['## Unstable results', '', 'FLAKY observations remain separate from passed scenarios.', ''] : []),
      'Required-step coverage is retained separately in verdict.json; counts above are scenarios.', ''];
    fs.writeFileSync(path.join(runRoot, 'report.md'), md.join('\n'));
    (options.render || render)(summaryFile, htmlFile);
    let html = fs.readFileSync(htmlFile, 'utf8');
    // The legacy renderer derives its banner from counts and ambient policy. Codex must
    // display the authoritative per-assignment verdict, including mixed warning/flaky steps.
    const label = { PASS: 'PASSED', FAIL: 'FAILED', BLOCKED: 'BLOCKED' }[verdict];
    const color = { PASS: '#2E9E4F', FAIL: '#D6293E', BLOCKED: '#F2A93B' }[verdict];
    const banner = /<div class="verdict" style="[^"]*">/;
    const labelPattern = /<span class="verdict-label" style="[^"]*">[^<]*<\/span>/;
    if (!banner.test(html) || !labelPattern.test(html)) throw Error('HTML verdict banner unavailable');
    html = html.replace(banner, `<div class="verdict" style="border-color:${color}66;border-left-color:${color}">`)
      .replace(labelPattern, `<span class="verdict-label" style="color:${color}">${label}</span>`);
    fs.writeFileSync(htmlFile, html);
    write(verdictFile, output);
    return output;
  } catch (error) {
    const verdict = aggregate(rows) === 'FAIL' ? 'FAIL' : 'BLOCKED';
    const output = { ok: false, verdict, exitCode: verdict === 'FAIL' ? 1 : 2, errors: [{ code: 'report-generation', detail: error.message }] };
    // Remove partial/stale success reports; keep scenario inputs and validations intact.
    for (const name of ['run-summary.json', 'report.md', 'extent-report.html']) {
      try { fs.unlinkSync(path.join(runRoot, name)); } catch { /* may be absent or inaccessible */ }
    }
    try { write(verdictFile, output); } catch { /* CLI still returns a nonzero verdict */ }
    return output;
  }
}
module.exports = { report };
