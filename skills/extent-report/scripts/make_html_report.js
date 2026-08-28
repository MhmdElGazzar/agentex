// Extent Report HTML generator — produces a standalone, self-contained HTML file
// (dark sidebar, donut chart, expandable per-test-case step list).
//
// Usage: node make_html_report.js <input.json> <output.html>
//
// TWO input shapes, gated on `schemaVersion` (the version gate):
//
// - No `schemaVersion` key = the LEGACY shape (implicit version 1) — rendered by the
//   untouched v1 path below, output byte-identical to before the gate existed:
// {
//   "title": "Suite1+Suite2 Parallel Run",
//   "date": "2026-07-08",
//   "summary": {"total":14,"passed":10,"failed":2,"blocked":2,"naDescoped":0,"notRun":0,
//               "warnings":0,"viewMismatch":0,"flaky":0},
//   "testCases": [
//     {
//       "name": "suite1-product-search",
//       "spec": "test/suite1/product-search.md",
//       "status": "failed",
//       "steps": [ {"desc":"...", "status":"passed|failed|blocked|na|notrun|warning|viewMismatch|flaky", "note":"..."} ]
//     }
//   ]
// }
//
// - `schemaVersion` >= 2 = the ENRICHED run-summary.json shape (full contract:
//   skills/extent-report/references/run-summary-schema.md): adds `run` (execution
//   context + timing), per-scenario/per-step durations, evidence paths (RELATIVE to the
//   input JSON's directory, base64-embedded at render time), ui-check baseline/actual
//   pairs, flaky attempt records, resolved deferrals, integration outcome summaries and
//   a `defects` section. Every enriched field is OPTIONAL to the renderer — absence
//   omits that section/chip/column, never a failure. A missing/unreadable evidence file
//   renders a labeled text placeholder, still exit 0. Unknown fields and higher
//   versions render best-effort.
//
// `warnings` / `viewMismatch` counts and the `warning` / `viewMismatch` statuses are
// first-class ui-check outcomes; `flaky` is the execution outcome for a scenario that
// failed on infrastructure and then passed on its one retry (browser-testing skill,
// "Flake doctrine") — an unstable result, never folded into `passed`. All three carry
// own colors, pills, stat cards and donut segments, and all three are optional — a
// run-summary JSON without them renders exactly as before.
const fs = require('fs');
const path = require('path');

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.error('Usage: node make_html_report.js <input.json> <output.html>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const { title, date, summary, testCases } = data;

// The version gate: absence of `schemaVersion` = the legacy path (today's exact code);
// any schemaVersion >= 2 = the enriched path. Never fail on a higher version.
const isV2 = Number(data.schemaVersion) >= 2;

const COLORS = {
  passed: '#2E9E4F',
  warning: '#EAC54F',
  failed: '#D6293E',
  blocked: '#F2A93B',
  flaky: '#E0619B',
  viewMismatch: '#4D9DE0',
  naDescoped: '#8B5CF6',
  notRun: '#B0B0B0',
};
const LABELS = {
  passed: 'Passed',
  warning: 'Warning',
  failed: 'Failed',
  blocked: 'Blocked',
  flaky: 'Flaky',
  viewMismatch: 'View Mismatch',
  naDescoped: 'N/A - De-scoped',
  notRun: 'Not Run',
};
// Summary counts: the color/label key `warning` is carried as `warnings` in the
// run-summary JSON (owner-approved vocabulary).
function summaryCount(key) {
  return (key === 'warning' ? summary.warnings : summary[key]) || 0;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- donut chart (SVG) ----
const total = summary.total || 1;
const cx = 110, cy = 110, r = 80, rInner = 48;

function polar(angleDeg, radius) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

let cum = 0;
let donutPaths = '';
const order = ['passed', 'warning', 'failed', 'blocked', 'flaky', 'viewMismatch', 'naDescoped', 'notRun'];
for (const key of order) {
  const count = summaryCount(key);
  if (count <= 0) continue;
  const pct = (count / total) * 100;
  const startAngle = cum * 3.6;
  cum += pct;
  let endAngle = cum * 3.6;
  // A full-circle arc (start == end point) renders as zero-length in SVG and the
  // donut disappears (e.g. an all-passed run). Cap just under 360°.
  if (endAngle - startAngle >= 360) endAngle = startAngle + 359.99;
  const [x1, y1] = polar(startAngle, r);
  const [x2, y2] = polar(endAngle, r);
  const [x1i, y1i] = polar(startAngle, rInner);
  const [x2i, y2i] = polar(endAngle, rInner);
  const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
  donutPaths += `<path d="M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x2i.toFixed(2)},${y2i.toFixed(2)} A${rInner},${rInner} 0 ${largeArc} 0 ${x1i.toFixed(2)},${y1i.toFixed(2)} Z" fill="${COLORS[key]}" stroke="#1a2327" stroke-width="1.5"/>\n`;
}

// Exercised = every scenario that actually ran to an outcome (warning, viewMismatch
// and flaky scenarios were executed — they count toward coverage).
const coveragePct = Math.round(((summary.passed || 0) + (summary.failed || 0) + (summary.blocked || 0)
  + (summary.warnings || 0) + (summary.viewMismatch || 0) + (summary.flaky || 0)) / total * 100);

const donutSvg = `<svg width="220" height="220" viewBox="0 0 220 220">
  ${donutPaths}
  <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="26" font-weight="700" fill="#e8edf0">${coveragePct}%</text>
  <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="#8fa3ad">coverage</text>
</svg>`;

// ---- status pills ----
function statusPill(status) {
  const key = status || 'notrun';
  const map = { passed: 'passed', warning: 'warning', failed: 'failed', blocked: 'blocked', flaky: 'flaky', viewMismatch: 'viewMismatch', na: 'naDescoped', notrun: 'notRun' };
  const colorKey = map[key] || 'notRun';
  const label = key === 'na' ? 'N/A'
    : key === 'notrun' ? 'Not Run'
    : key === 'viewMismatch' ? 'View Mismatch'
    : key.charAt(0).toUpperCase() + key.slice(1);
  return `<span class="pill" style="background:${COLORS[colorKey]}22;color:${COLORS[colorKey]};border:1px solid ${COLORS[colorKey]}55;">${esc(label)}</span>`;
}

function rollupColor(status) {
  const map = { passed: COLORS.passed, warning: COLORS.warning, failed: COLORS.failed, blocked: COLORS.blocked, flaky: COLORS.flaky, viewMismatch: COLORS.viewMismatch, na: COLORS.naDescoped, notrun: COLORS.notRun };
  return map[status] || COLORS.notRun;
}

// Legend: the ui-check statuses and flaky appear only when present, so run-summary
// JSONs without them keep the classic 5-row legend.
const legendHtml = order.filter((key) => !['warning', 'viewMismatch', 'flaky'].includes(key) || summaryCount(key) > 0).map((key) => `
  <div class="legend-item">
    <span class="dot" style="background:${COLORS[key]}"></span>
    <span class="legend-label">${LABELS[key]}</span>
    <span class="legend-count">${summaryCount(key)}</span>
  </div>`).join('');

let html;
if (!isV2) {
  // ═══ v1 (legacy) path — the pre-schemaVersion code, output byte-identical ═══════════

  // ---- test case rows ----
  let rowsHtml = '';
  testCases.forEach((tc, i) => {
    const stepRows = (tc.steps || []).map((s, j) => `
    <tr class="step-row">
      <td class="step-num">${j + 1}</td>
      <td>${esc(s.desc)}</td>
      <td>${statusPill(s.status)}</td>
      <td class="step-note">${esc(s.note || '')}</td>
    </tr>`).join('');

    rowsHtml += `
  <div class="tc-card" style="border-left-color:${rollupColor(tc.status)}">
    <div class="tc-header" onclick="toggleTC(${i})">
      <span class="chevron" id="chev-${i}">&#9656;</span>
      <span class="tc-name">${esc(tc.name)}</span>
      <span class="tc-spec">${esc(tc.spec || '')}</span>
      <span class="tc-status">${statusPill(tc.status)}</span>
    </div>
    <div class="tc-body" id="body-${i}" style="display:none;">
      <table class="step-table">
        <thead><tr><th>#</th><th>Step</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </div>
  </div>`;
  });

  html = `<div class="ext-report">
<style>
.ext-report {
  --bg-sidebar: #1a2327;
  --bg-main: #12191c;
  --bg-card: #1e2a2f;
  --text-main: #e8edf0;
  --text-dim: #8fa3ad;
  --border: #2b3a40;
  font-family: 'Segoe UI', Arial, sans-serif;
  color: var(--text-main);
  background: var(--bg-main);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  min-height: 480px;
}
.ext-report * { box-sizing: border-box; }
.ext-sidebar {
  width: 210px;
  background: var(--bg-sidebar);
  padding: 20px 16px;
  flex-shrink: 0;
}
.ext-sidebar h1 {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 4px;
  color: #57d38c;
  letter-spacing: 0.03em;
}
.ext-sidebar .subtitle { font-size: 11px; color: var(--text-dim); margin-bottom: 22px; }
.legend-item { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.legend-item .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-label { flex: 1; color: var(--text-dim); }
.legend-count { font-weight: 700; }
.ext-main { flex: 1; padding: 22px 26px; overflow-x: auto; }
.ext-main h2 { font-size: 17px; margin: 0 0 2px; }
.ext-main .date { font-size: 12px; color: var(--text-dim); margin-bottom: 18px; }
.summary-row { display: flex; align-items: center; gap: 28px; margin-bottom: 22px; flex-wrap: wrap; }
.stat-cards { display: flex; gap: 10px; flex-wrap: wrap; }
.stat-card { background: var(--bg-card); border-radius: 8px; padding: 10px 16px; min-width: 88px; text-align: center; border: 1px solid var(--border); }
.stat-card .n { font-size: 20px; font-weight: 700; }
.stat-card .l { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.tc-card { background: var(--bg-card); border: 1px solid var(--border); border-left: 4px solid #555; border-radius: 6px; margin-bottom: 8px; }
.tc-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; }
.tc-header:hover { background: #24333a; }
.chevron { display: inline-block; transition: transform 0.15s; color: var(--text-dim); }
.chevron.open { transform: rotate(90deg); }
.tc-name { font-weight: 600; font-size: 13.5px; }
.tc-spec { font-size: 11px; color: var(--text-dim); flex: 1; }
.pill { font-size: 10.5px; font-weight: 700; padding: 2px 9px; border-radius: 10px; white-space: nowrap; }
.tc-body { padding: 4px 14px 12px 34px; }
.step-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.step-table th { text-align: left; color: var(--text-dim); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
.step-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.step-num { color: var(--text-dim); width: 22px; }
.step-note { color: var(--text-dim); }
</style>
<div class="ext-sidebar">
  <h1>AgenTeX Report</h1>
  <div class="subtitle">${esc(title)}</div>
  ${donutSvg}
  <div style="margin-top:14px;">${legendHtml}</div>
</div>
<div class="ext-main">
  <h2>${esc(title)}</h2>
  <div class="date">${esc(date)}</div>
  <div class="summary-row">
    <div class="stat-cards">
      <div class="stat-card"><div class="n">${summary.total || 0}</div><div class="l">TOTAL TC</div></div>
      <div class="stat-card" style="border-color:${COLORS.passed}66"><div class="n" style="color:${COLORS.passed}">${summary.passed || 0}</div><div class="l">PASSED</div></div>
      <div class="stat-card" style="border-color:${COLORS.failed}66"><div class="n" style="color:${COLORS.failed}">${summary.failed || 0}</div><div class="l">FAILED</div></div>
      <div class="stat-card" style="border-color:${COLORS.blocked}66"><div class="n" style="color:${COLORS.blocked}">${summary.blocked || 0}</div><div class="l">BLOCKED</div></div>
      ${summary.warnings ? `<div class="stat-card" style="border-color:${COLORS.warning}66"><div class="n" style="color:${COLORS.warning}">${summary.warnings}</div><div class="l">WARNING</div></div>` : ''}
      ${summary.viewMismatch ? `<div class="stat-card" style="border-color:${COLORS.viewMismatch}66"><div class="n" style="color:${COLORS.viewMismatch}">${summary.viewMismatch}</div><div class="l">VIEW MISMATCH</div></div>` : ''}
      ${summary.flaky ? `<div class="stat-card" style="border-color:${COLORS.flaky}66"><div class="n" style="color:${COLORS.flaky}">${summary.flaky}</div><div class="l">FLAKY</div></div>` : ''}
    </div>
  </div>
  ${rowsHtml}
</div>
</div>
<script>
function toggleTC(i) {
  var body = document.getElementById('body-' + i);
  var chev = document.getElementById('chev-' + i);
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chev.classList.toggle('open', !open);
}
</script>`;
} else {
  // ═══ v2 (enriched) path — run-summary.json, references/run-summary-schema.md ════════
  // Every field is optional here: presence checks follow the existing idiom, and a
  // missing field omits its section/chip/column without touching anything else.

  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
  }

  // ---- base64 embedding (deterministic; evidence paths are RELATIVE to the input
  // JSON's directory = the run folder root). Missing/unreadable file or unknown
  // extension → a labeled text placeholder, never a throw, never a broken report.
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const inputDir = path.dirname(path.resolve(inPath));
  function embedImage(relPath) {
    if (!relPath) return null;
    const mime = MIME[path.extname(String(relPath)).toLowerCase()];
    if (!mime) return null;
    try {
      return `data:${mime};base64,${fs.readFileSync(path.resolve(inputDir, String(relPath))).toString('base64')}`;
    } catch {
      return null;
    }
  }
  // Thumbnail with click-to-expand: the SAME data URI, CSS-scaled; expansion toggles a
  // class inline (the report's existing inline-JS pattern). loading="lazy" keeps the
  // initial paint cheap on multi-MB reports.
  function evidenceFig(relPath, caption) {
    const uri = embedImage(relPath);
    if (!uri) return `<span class="ev-missing">evidence not found: ${esc(relPath)}</span>`;
    return `<figure class="ev"><img class="ev-thumb" loading="lazy" src="${uri}" alt="${esc(caption || relPath)}" title="click to expand" onclick="this.classList.toggle('ev-open')">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`;
  }
  function gallery(items) {
    const norm = (items || []).map((it) => (typeof it === 'string' ? { path: it } : (it || {})));
    if (!norm.length) return '';
    return `<div class="ev-gallery">${norm.map((it) => evidenceFig(it.path, it.caption)).join('')}</div>`;
  }

  // ---- context block (text only — no SVG <path fill>: the donut-extraction regex in
  // the tests must keep matching donut segments only) ----
  const run = data.run || {};
  const ctxChip = (label, value) => (value ? `<span class="ctx-chip"><span class="ctx-k">${label}</span>${esc(value)}</span>` : '');
  const toolChips = Object.entries(run.tools || {})
    .filter(([, t]) => t && t.ok)
    .map(([name, t]) => `<span class="ctx-chip ctx-tool"><span class="ctx-k">${esc(name)}</span>${esc(t.version || 'ok')}</span>`).join('');
  const sessionRows = (Array.isArray(run.sessions) ? run.sessions : [])
    .map((s) => `<tr><td>${esc(s.session)}</td><td>${esc(s.spec || '')}</td><td>${esc(s.label || '')}</td></tr>`).join('');
  const ctxChips = [
    ctxChip('Environment', run.environment),
    ctxChip('Target', run.targetUrl),
    ctxChip('Login mode', run.loginMode),
    ctxChip('Run mode', run.mode),
    ctxChip('Started', run.startedAt),
    ctxChip('Ended', run.endedAt),
    ctxChip('Duration', fmtDur(run.durationMs)),
  ].join('') + toolChips;
  const contextHtml = (ctxChips || sessionRows) ? `
  <div class="ctx">${ctxChips ? `
    <div class="ctx-chips">${ctxChips}</div>` : ''}${sessionRows ? `
    <table class="ctx-sessions"><thead><tr><th>Session</th><th>Spec</th><th>Label</th></tr></thead><tbody>${sessionRows}</tbody></table>` : ''}
  </div>` : '';

  // ---- per-step extras (all in the card BODY — headers stay lean) ----
  function integrationHtml(g) {
    return `<span class="int-chip"><span class="int-kind">${esc(g.kind || '')}</span>${esc(g.entry || '')}${g.verdict ? ` · ${esc(g.verdict)}` : ''}${g.result ? ` · ${esc(g.result)}` : ''}${typeof g.durationMs === 'number' ? ` · ${fmtDur(g.durationMs)}` : ''}</span>`;
  }
  function uiCheckHtml(u) {
    const baselineId = u.baseline ? `${u.baseline.source || ''} ${u.baseline.id || ''}`.trim() : '';
    return `<div class="ui-check-block">
        <div class="ui-check-meta">ui-check · mode: ${esc(u.mode || '')}${baselineId ? ` · baseline: ${esc(baselineId)}` : ''}${u.verdict ? ` · verdict: ${esc(u.verdict)}` : ''}</div>${u.cached ? `
        <div class="ui-cached">cached baseline — ${esc(u.cachedReason || '')}</div>` : ''}
        ${gallery([u.baselineImage ? { path: u.baselineImage, caption: 'Baseline' } : null, u.actualImage ? { path: u.actualImage, caption: 'Actual' } : null].filter(Boolean))}
      </div>`;
  }

  // ---- test case rows (enriched) ----
  // The name→pill header markup is byte-identical to the v1 card header; the duration
  // chip APPENDS after the pill, so the release-gate checker's name→pill window is
  // untouched by construction. Images and all heavy content go in the body.
  const anyStepDur = testCases.some((tc) => (tc.steps || []).some((s) => typeof s.durationMs === 'number'));
  const extraColspan = anyStepDur ? 4 : 3;
  let rowsHtml = '';
  testCases.forEach((tc, i) => {
    const stepRows = (tc.steps || []).map((s, j) => {
      const extras = [
        s.integration ? integrationHtml(s.integration) : '',
        s.uiCheck ? uiCheckHtml(s.uiCheck) : '',
        gallery(s.evidence),
      ].filter(Boolean).join('');
      return `
    <tr class="step-row">
      <td class="step-num">${j + 1}</td>
      <td>${esc(s.desc)}</td>
      <td>${statusPill(s.status)}</td>
      <td class="step-note">${esc(s.note || '')}</td>${anyStepDur ? `
      <td class="step-dur">${typeof s.durationMs === 'number' ? fmtDur(s.durationMs) : ''}</td>` : ''}
    </tr>${extras ? `
    <tr class="step-extra">
      <td></td>
      <td colspan="${extraColspan}">${extras}</td>
    </tr>` : ''}`;
    }).join('');

    const durChip = typeof tc.durationMs === 'number' ? `<span class="tc-time">${fmtDur(tc.durationMs)}</span>` : '';
    const timingLine = (tc.startedAt || tc.endedAt) ? `
      <div class="tc-meta">Started ${esc(tc.startedAt || '—')} · Ended ${esc(tc.endedAt || '—')}${tc.session ? ` · Session ${esc(tc.session)}` : ''}</div>` : '';
    const blockedLine = tc.blockedBy ? `
      <div class="tc-blocked-by">Blocked upstream by: ${esc(tc.blockedBy)}</div>` : '';
    const tcGallery = gallery(tc.screenshots);
    const flakyBlock = tc.flaky ? `
      <div class="flaky-block">
        <div class="flaky-title">Flaky — passed only on its one retry</div>${tc.flaky.attempt1Symptom ? `
        <div class="flaky-symptom">Attempt 1: ${esc(tc.flaky.attempt1Symptom)}</div>` : ''}
        ${gallery([
          ...(tc.flaky.attempt1Evidence || []).map((p) => ({ path: p, caption: 'Attempt 1' })),
          ...(tc.flaky.attempt2Evidence || []).map((p) => ({ path: p, caption: 'Attempt 2' })),
        ])}
      </div>` : '';
    // Resolved NEEDS-USER history only — an unresolved NEEDS-USER never reaches a
    // final artifact (browser-testing MERGE resolves them before this JSON is written).
    const deferredBlocks = (tc.deferred || []).map((d) => `
      <div class="deferred-block">
        <div class="deferred-title">Resolved deferred question</div>
        <div class="q">Question: ${esc(d.question || '')}</div>
        <div>Resolution: ${esc(d.resolution || '')}</div>${d.finalStatus ? `
        <div>Final status: ${statusPill(d.finalStatus)}</div>` : ''}
        ${gallery([d.baselineImage ? { path: d.baselineImage, caption: 'Baseline' } : null, d.actualImage ? { path: d.actualImage, caption: 'Actual' } : null].filter(Boolean))}
      </div>`).join('');

    rowsHtml += `
  <div class="tc-card" style="border-left-color:${rollupColor(tc.status)}">
    <div class="tc-header" onclick="toggleTC(${i})">
      <span class="chevron" id="chev-${i}">&#9656;</span>
      <span class="tc-name">${esc(tc.name)}</span>
      <span class="tc-spec">${esc(tc.spec || '')}</span>
      <span class="tc-status">${statusPill(tc.status)}</span>${durChip}
    </div>
    <div class="tc-body" id="body-${i}" style="display:none;">${timingLine}${blockedLine}
      <table class="step-table">
        <thead><tr><th>#</th><th>Step</th><th>Status</th><th>Detail</th>${anyStepDur ? '<th>Duration</th>' : ''}</tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
      ${tcGallery}${flakyBlock}${deferredBlocks}
    </div>
  </div>`;
  });

  // ---- defects section (severity-colored left border, reusing the tc-card pattern) ----
  const SEVERITY_COLORS = { Critical: COLORS.failed, High: COLORS.blocked, Medium: COLORS.warning, Low: COLORS.notRun };
  const defectsHtml = (Array.isArray(data.defects) && data.defects.length) ? `
  <h3 class="defects-h">Defects</h3>${data.defects.map((d) => {
    const sev = SEVERITY_COLORS[d.severity] || COLORS.notRun;
    return `
  <div class="tc-card defect-card" style="border-left-color:${sev}">
    <div class="defect-header">${d.id != null ? `<span class="defect-id">#${esc(d.id)}</span>` : ''}<span class="defect-title">${esc(d.title)}</span>${d.severity ? `<span class="pill" style="background:${sev}22;color:${sev};border:1px solid ${sev}55;">${esc(d.severity)}</span>` : ''}${d.scenario ? `<span class="defect-scenario">${esc(d.scenario)}</span>` : ''}</div>
    <div class="defect-body">${(d.steps || []).length ? `
      <ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}${d.expected ? `
      <div class="defect-ea"><b>Expected:</b> ${esc(d.expected)}</div>` : ''}${d.actual ? `
      <div class="defect-ea"><b>Actual:</b> ${esc(d.actual)}</div>` : ''}
      ${gallery(d.evidence)}
    </div>
  </div>`;
  }).join('')}` : '';

  html = `<div class="ext-report">
<style>
.ext-report {
  --bg-sidebar: #1a2327;
  --bg-main: #12191c;
  --bg-card: #1e2a2f;
  --text-main: #e8edf0;
  --text-dim: #8fa3ad;
  --border: #2b3a40;
  font-family: 'Segoe UI', Arial, sans-serif;
  color: var(--text-main);
  background: var(--bg-main);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  min-height: 480px;
}
.ext-report * { box-sizing: border-box; }
.ext-sidebar {
  width: 210px;
  background: var(--bg-sidebar);
  padding: 20px 16px;
  flex-shrink: 0;
}
.ext-sidebar h1 {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 4px;
  color: #57d38c;
  letter-spacing: 0.03em;
}
.ext-sidebar .subtitle { font-size: 11px; color: var(--text-dim); margin-bottom: 22px; }
.legend-item { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.legend-item .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-label { flex: 1; color: var(--text-dim); }
.legend-count { font-weight: 700; }
.ext-main { flex: 1; padding: 22px 26px; overflow-x: auto; }
.ext-main h2 { font-size: 17px; margin: 0 0 2px; }
.ext-main .date { font-size: 12px; color: var(--text-dim); margin-bottom: 18px; }
.summary-row { display: flex; align-items: center; gap: 28px; margin-bottom: 22px; flex-wrap: wrap; }
.stat-cards { display: flex; gap: 10px; flex-wrap: wrap; }
.stat-card { background: var(--bg-card); border-radius: 8px; padding: 10px 16px; min-width: 88px; text-align: center; border: 1px solid var(--border); }
.stat-card .n { font-size: 20px; font-weight: 700; }
.stat-card .l { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.tc-card { background: var(--bg-card); border: 1px solid var(--border); border-left: 4px solid #555; border-radius: 6px; margin-bottom: 8px; }
.tc-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; }
.tc-header:hover { background: #24333a; }
.chevron { display: inline-block; transition: transform 0.15s; color: var(--text-dim); }
.chevron.open { transform: rotate(90deg); }
.tc-name { font-weight: 600; font-size: 13.5px; }
.tc-spec { font-size: 11px; color: var(--text-dim); flex: 1; }
.pill { font-size: 10.5px; font-weight: 700; padding: 2px 9px; border-radius: 10px; white-space: nowrap; }
.tc-body { padding: 4px 14px 12px 34px; }
.step-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.step-table th { text-align: left; color: var(--text-dim); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
.step-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.step-num { color: var(--text-dim); width: 22px; }
.step-note { color: var(--text-dim); }
.ctx { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 18px; }
.ctx-chip { display: inline-block; background: #24333a; border: 1px solid var(--border); border-radius: 10px; padding: 2px 10px; margin: 2px 6px 2px 0; font-size: 11.5px; }
.ctx-k { color: var(--text-dim); margin-right: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.ctx-sessions { border-collapse: collapse; font-size: 11.5px; margin-top: 8px; }
.ctx-sessions th { text-align: left; color: var(--text-dim); font-weight: 600; padding: 3px 14px 3px 0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
.ctx-sessions td { padding: 3px 14px 3px 0; border-bottom: 1px solid var(--border); }
.tc-time { font-size: 10.5px; color: var(--text-dim); white-space: nowrap; }
.tc-meta { font-size: 11px; color: var(--text-dim); margin: 6px 0 2px; }
.tc-blocked-by { font-size: 12px; color: ${COLORS.blocked}; margin: 6px 0 2px; }
.step-dur { color: var(--text-dim); white-space: nowrap; }
.step-extra > td { padding: 2px 8px 10px; border-bottom: 1px solid var(--border); }
.int-chip { display: inline-block; font-size: 11px; border: 1px solid var(--border); border-radius: 10px; padding: 2px 10px; margin: 4px 6px 4px 0; color: var(--text-dim); }
.int-kind { font-weight: 700; color: var(--text-main); text-transform: uppercase; margin-right: 6px; }
.ev-gallery { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 4px; align-items: flex-start; }
.ev { margin: 0; }
.ev-thumb { display: block; max-width: 180px; max-height: 110px; border: 1px solid var(--border); border-radius: 4px; cursor: zoom-in; }
.ev-thumb.ev-open { max-width: 100%; max-height: none; cursor: zoom-out; }
.ev figcaption { font-size: 10.5px; color: var(--text-dim); margin-top: 3px; max-width: 180px; }
.ev-missing { display: inline-block; font-size: 11px; color: var(--text-dim); border: 1px dashed var(--border); border-radius: 4px; padding: 4px 8px; margin: 4px 0; }
.ui-check-block { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
.ui-check-meta { font-size: 11.5px; color: var(--text-dim); }
.ui-cached { font-size: 11px; color: ${COLORS.warning}; margin-top: 4px; }
.flaky-block { border: 1px solid ${COLORS.flaky}55; border-radius: 6px; padding: 8px 10px; margin: 8px 0 4px; }
.flaky-title { font-size: 11.5px; font-weight: 700; color: ${COLORS.flaky}; }
.flaky-symptom { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.deferred-block { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 8px 0 4px; font-size: 12px; }
.deferred-title { font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.03em; }
.deferred-block .q { margin-top: 4px; }
.defects-h { font-size: 15px; margin: 24px 0 10px; }
.defect-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
.defect-id { color: var(--text-dim); font-weight: 700; }
.defect-title { font-weight: 600; font-size: 13.5px; flex: 1; }
.defect-scenario { font-size: 11px; color: var(--text-dim); }
.defect-body { padding: 0 14px 12px; font-size: 12px; }
.defect-body ol { margin: 6px 0; padding-left: 20px; color: var(--text-dim); }
.defect-ea { margin: 4px 0; }
</style>
<div class="ext-sidebar">
  <h1>AgenTeX Report</h1>
  <div class="subtitle">${esc(title)}</div>
  ${donutSvg}
  <div style="margin-top:14px;">${legendHtml}</div>
</div>
<div class="ext-main">
  <h2>${esc(title)}</h2>
  <div class="date">${esc(date)}</div>${contextHtml}
  <div class="summary-row">
    <div class="stat-cards">
      <div class="stat-card"><div class="n">${summary.total || 0}</div><div class="l">TOTAL TC</div></div>
      <div class="stat-card" style="border-color:${COLORS.passed}66"><div class="n" style="color:${COLORS.passed}">${summary.passed || 0}</div><div class="l">PASSED</div></div>
      <div class="stat-card" style="border-color:${COLORS.failed}66"><div class="n" style="color:${COLORS.failed}">${summary.failed || 0}</div><div class="l">FAILED</div></div>
      <div class="stat-card" style="border-color:${COLORS.blocked}66"><div class="n" style="color:${COLORS.blocked}">${summary.blocked || 0}</div><div class="l">BLOCKED</div></div>
      ${summary.warnings ? `<div class="stat-card" style="border-color:${COLORS.warning}66"><div class="n" style="color:${COLORS.warning}">${summary.warnings}</div><div class="l">WARNING</div></div>` : ''}
      ${summary.viewMismatch ? `<div class="stat-card" style="border-color:${COLORS.viewMismatch}66"><div class="n" style="color:${COLORS.viewMismatch}">${summary.viewMismatch}</div><div class="l">VIEW MISMATCH</div></div>` : ''}
      ${summary.flaky ? `<div class="stat-card" style="border-color:${COLORS.flaky}66"><div class="n" style="color:${COLORS.flaky}">${summary.flaky}</div><div class="l">FLAKY</div></div>` : ''}
      <div class="stat-card" style="border-color:${COLORS.naDescoped}66"><div class="n" style="color:${COLORS.naDescoped}">${summary.naDescoped || 0}</div><div class="l">N/A - DE-SCOPED</div></div>
      <div class="stat-card" style="border-color:${COLORS.notRun}66"><div class="n" style="color:${COLORS.notRun}">${summary.notRun || 0}</div><div class="l">NOT RUN</div></div>
    </div>
  </div>
  ${rowsHtml}${defectsHtml}
</div>
</div>
<script>
function toggleTC(i) {
  var body = document.getElementById('body-' + i);
  var chev = document.getElementById('chev-' + i);
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chev.classList.toggle('open', !open);
}
</script>`;
}

const fullDoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)} — Extent Report</title>
</head>
<body style="margin:0;padding:24px;background:#0d1315;">
${html}
</body>
</html>`;

fs.writeFileSync(outPath, fullDoc, 'utf8');
console.log('wrote', outPath);
