'use strict';
// Release-gate reporting-lane verifier (design: release-e2e-gate).
//
// Asserts the run's executions/execu_<ts>/ directory carries BOTH report
// artifacts — report.md and extent-report.html — and that each reflects the
// run: every expected scenario name appears in both files, with its verdict
// ADJACENT to it (same row/card — a bounded window after the name), never
// merely somewhere in the file.
//
// Usage: node verify-reports.js <throwaway-dir> --scenarios <file.json> [--exec <execu_dir_name>]
//   scenarios file: [{ "name": "...", "verdict": "PASS|FAIL|BLOCKED" }, ...]
//   --exec: explicit executions/<name>; default = newest execu_* by mtime.
// Output: one JSON line {ok, execution, findings}. Exit 0 clean · 1 findings · 2 usage.
const fs = require('node:fs');
const path = require('node:path');

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

function newestExecution(executionsDir) {
  let best = null;
  for (const entry of fs.readdirSync(executionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('execu_')) continue;
    const full = path.join(executionsDir, entry.name);
    const mtime = fs.statSync(full).mtimeMs;
    if (!best || mtime > best.mtime || (mtime === best.mtime && entry.name > best.name)) {
      best = { full, mtime, name: entry.name };
    }
  }
  return best && best.full;
}

// A verdict only counts when it sits with its OWN scenario (wrong-PASS vector:
// "PASS" appearing anywhere — another scenario's verdict, prose — must never
// satisfy scenario A). The verdict must appear as a whole word inside a bounded
// window AFTER an occurrence of the scenario's name, cut short at the next
// occurrence of any expected scenario name (so a table row / report card only
// vouches for its own scenario). Any occurrence of the name may carry it.
const VERDICT_WINDOW = 240;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verdictAdjacentToName(text, name, verdict, allNames) {
  const verdictRe = new RegExp(`\\b${escapeRegExp(verdict)}\\b`);
  let at = text.indexOf(name);
  while (at !== -1) {
    const start = at + name.length;
    let end = Math.min(text.length, start + VERDICT_WINDOW);
    for (const other of allNames) {
      const next = text.indexOf(other, start);
      if (next !== -1 && next < end) end = next;
    }
    if (verdictRe.test(text.slice(start, end))) return true;
    at = text.indexOf(name, start);
  }
  return false;
}

function verifyReports({ dir, scenarios, exec } = {}) {
  if (!dir) throw usageError('a throwaway project dir is required');
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw usageError('at least one expected {name, verdict} scenario is required — an empty expectation could only produce a wrong PASS');
  }
  const findings = [];
  const executionsDir = path.join(dir, 'executions');
  if (!fs.existsSync(executionsDir)) {
    return { ok: false, execution: null, findings: ['executions/ does not exist — the run produced no output tree'] };
  }
  const execution = exec ? path.join(executionsDir, exec) : newestExecution(executionsDir);
  if (!execution || !fs.existsSync(execution)) {
    return { ok: false, execution: null, findings: [`no ${exec || 'execu_*'} directory under executions/`] };
  }

  const texts = {};
  for (const name of ['report.md', 'extent-report.html']) {
    const file = path.join(execution, name);
    if (!fs.existsSync(file)) { findings.push(`${name} is missing from ${path.basename(execution)}`); continue; }
    texts[name] = fs.readFileSync(file, 'utf8');
  }

  const expectedNames = scenarios.map((s) => s && s.name).filter(Boolean);
  for (const [name, text] of Object.entries(texts)) {
    for (const s of scenarios) {
      if (!s || !s.name || !s.verdict) throw usageError('every scenario needs {name, verdict}');
      if (!text.includes(s.name)) { findings.push(`scenario "${s.name}" not reflected in ${name}`); continue; }
      if (!verdictAdjacentToName(text, s.name, s.verdict, expectedNames)) {
        findings.push(`verdict ${s.verdict} (scenario "${s.name}") not adjacent to its scenario in ${name}`);
      }
    }
  }

  return { ok: findings.length === 0, execution, findings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const dir = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null;
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw usageError(`bad flag pair near ${argv[i]}`);
      flags[argv[i].slice(2)] = argv[i + 1];
    }
    if (!flags.scenarios) throw usageError('--scenarios <file.json> is required');
    const scenarios = JSON.parse(fs.readFileSync(flags.scenarios, 'utf8'));
    const result = verifyReports({ dir, scenarios, exec: flags.exec });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = { verifyReports };
