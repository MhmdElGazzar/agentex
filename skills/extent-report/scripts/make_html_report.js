// Extent Report HTML generator — produces a standalone, self-contained HTML file
// (dark sidebar, donut chart, expandable per-test-case step list).
//
// Usage: node make_html_report.js <input.json> <output.html>
//
// Input JSON shape:
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
// `warnings` / `viewMismatch` counts and the `warning` / `viewMismatch` statuses are
// first-class ui-check outcomes; `flaky` is the execution outcome for a scenario that
// failed on infrastructure and then passed on its one retry (browser-testing skill,
// "Flake doctrine") — an unstable result, never folded into `passed`. All three carry
// own colors, pills, stat cards and donut segments, and all three are optional — a
// run-summary JSON without them renders exactly as before.
const fs = require('fs');

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.error('Usage: node make_html_report.js <input.json> <output.html>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const { title, date, summary, testCases } = data;

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

// Legend: the ui-check statuses and flaky appear only when present, so run-summary
// JSONs without them keep the classic 5-row legend.
const legendHtml = order.filter((key) => !['warning', 'viewMismatch', 'flaky'].includes(key) || summaryCount(key) > 0).map((key) => `
  <div class="legend-item">
    <span class="dot" style="background:${COLORS[key]}"></span>
    <span class="legend-label">${LABELS[key]}</span>
    <span class="legend-count">${summaryCount(key)}</span>
  </div>`).join('');

const html = `<div class="ext-report">
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
