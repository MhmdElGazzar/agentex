// Extent Report v3 HTML generator — standalone, self-contained report.
// Same input contract as the original extent-report generator (drop-in compatible),
// richer layout: an audience-tiered page (manager verdict banner + coverage donut,
// per-status stat cards, expandable per-test-case step tables with a "failures only"
// filter), light/dark aware, print/PDF friendly. No timing fields required.
//
// Usage: node make_html_report_v3.js <input.json> <output.html>
//
// Input JSON shape (identical to the original extent-report):
// {
//   "title": "Suite1+Suite2 Parallel Run",
//   "date": "2026-07-08",
//   "summary": {"total":14,"passed":10,"failed":2,"blocked":2,"naDescoped":0,"notRun":0},
//   "testCases": [
//     {
//       "name": "suite1-product-search",
//       "spec": "test/suite1/product-search.md",
//       "status": "failed",
//       "steps": [ {"desc":"...", "status":"passed|failed|blocked|na|notrun", "note":"..."} ]
//     }
//   ]
// }
const fs = require('fs');

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.error('Usage: node make_html_report_v3.js <input.json> <output.html>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const { title, date, summary, testCases } = data;

const S = {
  passed:     { label: 'Passed',          color: '#4FBF87', tint: '#16281F', line: '#2E5C45', short: 'Pass' },
  failed:     { label: 'Failed',          color: '#F0705A', tint: '#2E1B17', line: '#6E362B', short: 'Fail' },
  blocked:    { label: 'Blocked',         color: '#E0A93E', tint: '#2C2412', line: '#6A5220', short: 'Blocked' },
  naDescoped: { label: 'N/A – De-scoped', color: '#9B7BE0', tint: '#221B33', line: '#4A3A6E', short: 'N/A' },
  notRun:     { label: 'Not Run',         color: '#8A968F', tint: '#1D2823', line: '#33413A', short: 'Not Run' },
};
// step-level status key -> summary key
const STEP_KEY = { passed: 'passed', failed: 'failed', blocked: 'blocked', na: 'naDescoped', notrun: 'notRun' };
const ORDER = ['passed', 'failed', 'blocked', 'naDescoped', 'notRun'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const sum = {
  total: summary.total || 0,
  passed: summary.passed || 0,
  failed: summary.failed || 0,
  blocked: summary.blocked || 0,
  naDescoped: summary.naDescoped || 0,
  notRun: summary.notRun || 0,
};
const total = sum.total || 1;
const coverage = Math.round(((sum.passed + sum.failed + sum.blocked) / total) * 100);
const passRate = (sum.passed + sum.failed) > 0 ? Math.round((sum.passed / (sum.passed + sum.failed)) * 100) : 0;
const runFailed = sum.failed > 0 || sum.blocked > 0;

// ---- icons ----
const ICO = {
  pass: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fail: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  blocked: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.6"/></svg>',
  na: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  notrun: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const STEP_ICON = { passed: ICO.pass, failed: ICO.fail, blocked: ICO.blocked, na: ICO.na, notrun: ICO.notrun };

// ---- donut (SVG stroke-dasharray arcs) ----
const R = 52, C = 60, STROKE = 16, CIRC = 2 * Math.PI * R;
let offset = 0;
let arcs = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="${STROKE}"/>`;
for (const key of ORDER) {
  const val = sum[key];
  if (val <= 0) continue;
  const len = (val / total) * CIRC;
  arcs += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${S[key].color}" stroke-width="${STROKE}" stroke-dasharray="${len.toFixed(2)} ${(CIRC - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
  offset += len;
}

// ---- status legend + stat cards ----
const legendHtml = ORDER.map((key) => {
  const val = sum[key];
  return `<div class="status-row${val === 0 ? ' zero' : ''}">
    <span class="dot" style="background:${S[key].color}"></span>
    <span class="name">${S[key].label}</span>
    <span class="count num" style="color:${val > 0 ? S[key].color : ''}">${val}</span>
  </div>`;
}).join('');

const statCards = ORDER.map((key) => {
  const val = sum[key];
  return `<div class="stat${val === 0 ? ' zero' : ''}" style="--c:${S[key].color};--ct:${S[key].tint};--cl:${S[key].line}">
    <div class="stat-ico">${STEP_ICON[{ passed: 'passed', failed: 'failed', blocked: 'blocked', naDescoped: 'na', notRun: 'notrun' }[key]]}</div>
    <div class="stat-body"><div class="stat-n num">${val}</div><div class="stat-l">${S[key].label}</div></div>
  </div>`;
}).join('');

// ---- test case cards ----
const casesHtml = testCases.map((tc, i) => {
  const c = { passed: 0, failed: 0, blocked: 0, na: 0, notrun: 0 };
  (tc.steps || []).forEach((s) => { c[s.status] = (c[s.status] || 0) + 1; });
  const rollup = tc.status || (c.failed ? 'failed' : c.blocked ? 'blocked' : 'passed');
  const rollKey = STEP_KEY[rollup] || (rollup === 'failed' ? 'failed' : rollup === 'blocked' ? 'blocked' : 'passed');
  const isBad = rollup === 'failed' || rollup === 'blocked';

  const rows = (tc.steps || []).map((s, j) => {
    const meta = S[STEP_KEY[s.status]] || S.notRun;
    const trace = s.status === 'failed' && (s.error || s.trace)
      ? `<tr class="trace-row"><td colspan="4"><div class="trace"><div class="t-lab">Failure detail</div>${esc(s.error || s.trace)}</div></td></tr>`
      : '';
    return `<tr>
      <td class="st-num r num">${j + 1}</td>
      <td>${esc(s.desc)}</td>
      <td><span class="status-tag" style="color:${meta.color}">${STEP_ICON[s.status] || ''}${meta.short}</span></td>
      <td class="note">${esc(s.note || '')}</td>
    </tr>${trace}`;
  }).join('');

  const counts = ORDER.map((k) => {
    const stepK = { passed: 'passed', failed: 'failed', blocked: 'blocked', naDescoped: 'na', notRun: 'notrun' }[k];
    return c[stepK] || 0;
  });
  const badgeMeta = S[rollKey];

  return `<div class="tc-card ${isBad ? 'bad' : 'good'}" data-bad="${isBad}" style="--rc:${badgeMeta.color};--rt:${badgeMeta.tint};--rl:${badgeMeta.line}">
    <div class="tc-head" role="button" tabindex="0" aria-expanded="false">
      <span class="tc-chevron">${ICO.chev}</span>
      <div class="tc-id"><div class="name">${esc(tc.name)}</div><div class="spec">${esc(tc.spec || '')}</div></div>
      <div class="tc-metrics">
        <div class="tc-metric hide-sm"><div class="m-val num">${(tc.steps || []).length}</div><div class="m-lab">Steps</div></div>
        <div class="tc-metric hide-sm"><div class="m-val num" style="color:${S.passed.color}">${c.passed || 0}</div><div class="m-lab">Pass</div></div>
        <div class="tc-metric hide-sm"><div class="m-val num" style="color:${(c.failed||c.blocked) ? S.failed.color : 'var(--ink-3)'}">${(c.failed || 0) + (c.blocked || 0)}</div><div class="m-lab">Issues</div></div>
        <span class="tc-pill" style="color:${badgeMeta.color};background:${badgeMeta.tint};border-color:${badgeMeta.line}">${STEP_ICON[{passed:'passed',failed:'failed',blocked:'blocked',naDescoped:'na',notRun:'notrun'}[rollKey]]}${badgeMeta.label}</span>
      </div>
    </div>
    <div class="tc-body"><div class="table-scroll"><table>
      <thead><tr><th class="r">#</th><th>Step</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
  </div>`;
}).join('');

const verdictKey = runFailed ? (sum.failed > 0 ? 'failed' : 'blocked') : 'passed';
const vMeta = S[verdictKey];
const summaryLine = runFailed
  ? `<b>${sum.failed} failed</b>${sum.blocked ? ` · <b>${sum.blocked} blocked</b>` : ''} of ${sum.total} steps. Coverage ${coverage}%. Review the flagged test cases below.`
  : `All <b>${sum.passed} of ${sum.total}</b> steps passed. Coverage ${coverage}% — <b>no defects</b> detected in this run.`;

const html = `<div class="wrap">

  <div class="band"><h2>Executive Summary</h2><span class="who">Managers</span></div>

  <div class="verdict ${runFailed ? 'is-fail' : ''}" style="--vc:${vMeta.color};--vt:${vMeta.tint};--vl:${vMeta.line}">
    <div class="verdict-top">
      <div class="verdict-title">
        <div class="eyebrow">AgenTeX QA Report</div>
        <h1>${esc(title)}</h1>
      </div>
      <div class="status-badge" style="color:${vMeta.color};background:${vMeta.tint};border-color:${vMeta.line}">
        ${STEP_ICON[{passed:'passed',failed:'failed',blocked:'blocked'}[verdictKey]]}<span>${vMeta.label.toUpperCase()}</span>
      </div>
    </div>
    <p class="summary-line">${summaryLine}</p>
    <div class="stat-cards">${statCards}</div>
  </div>

  <div class="card coverage-card">
    <div class="donut-wrap">
      <div class="donut">
        <svg viewBox="0 0 120 120" role="img" aria-label="Coverage donut">${arcs}</svg>
        <div class="donut-center"><span class="pct num" style="color:${vMeta.color}">${coverage}%</span><span class="lab">Coverage</span></div>
      </div>
      <div class="donut-sub">${sum.passed + sum.failed + sum.blocked} of ${sum.total} scenarios executed</div>
    </div>
    <div>
      <div class="mini-kpis">
        <div class="mini"><div class="mini-n num" style="color:${passRate === 100 ? S.passed.color : 'var(--ink)'}">${passRate}%</div><div class="mini-l">Pass rate</div></div>
        <div class="mini"><div class="mini-n num">${sum.total}</div><div class="mini-l">Total steps</div></div>
        <div class="mini"><div class="mini-n num" style="color:${sum.failed ? S.failed.color : 'var(--ink)'}">${sum.failed}</div><div class="mini-l">Failed</div></div>
        <div class="mini"><div class="mini-n num">${testCases.length}</div><div class="mini-l">Test case${testCases.length !== 1 ? 's' : ''}</div></div>
      </div>
      <div class="status-list">${legendHtml}</div>
    </div>
  </div>

  <div class="band"><h2>Step-by-Step Evidence</h2><span class="who">Testers &amp; Developers</span></div>

  <div class="toolbar">
    <span class="toolbar-hint">Click a test case to expand its steps</span>
    <div class="spacer"></div>
    <label class="toggle"><input type="checkbox" id="failOnly"><span class="track"></span>Issues only</label>
  </div>
  <div id="cases">${casesHtml}</div>
  <div id="emptyState" class="empty-state" style="display:none;">No failed or blocked test cases in this run.</div>

  <footer>
    <div class="rec">
      <span><b>Run:</b> ${esc(title)}</span>
      <span><b>Date:</b> ${esc(date)}</span>
      <span><b>Test cases:</b> ${testCases.length}</span>
      <span><b>Total steps:</b> ${sum.total}</span>
    </div>
    Generated by AgenTeX extent-report v3. Coverage = (Passed + Failed + Blocked) ÷ Total. This document is an evidence record of a single execution.
  </footer>
</div>

<script>
  (function () {
    document.querySelectorAll('.tc-head').forEach(function (head) {
      var card = head.closest('.tc-card');
      function toggle() { var open = card.classList.toggle('open'); head.setAttribute('aria-expanded', String(open)); }
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    var fo = document.getElementById('failOnly');
    if (fo) fo.addEventListener('change', function (e) {
      var any = false;
      document.querySelectorAll('.tc-card').forEach(function (c) {
        var hide = e.target.checked && c.dataset.bad !== 'true';
        c.classList.toggle('hidden', hide);
        if (!hide) any = true;
      });
      document.getElementById('emptyState').style.display = any ? 'none' : 'block';
    });
  })();
</script>`;

const css = `
  :root {
    --bg:#0E1412; --surface:#17201C; --surface-2:#1D2823; --surface-3:#243029;
    --ink:#ECF2EE; --ink-2:#C3CFC9; --ink-3:#8A968F; --border:#263029; --border-2:#33413A;
    --accent:#4FBF87; --radius:14px; --radius-sm:9px;
    --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 28px rgba(0,0,0,.28);
    --mono:"SFMono-Regular","JetBrains Mono",Consolas,ui-monospace,monospace;
    --sans:"Inter","Segoe UI",-apple-system,system-ui,sans-serif;
    --serif:Georgia,"Iowan Old Style","Palatino Linotype",serif;
  }
  :root[data-theme="light"]{
    --bg:#F4F6F4; --surface:#FFF; --surface-2:#F5F7F5; --surface-3:#EDF0EE;
    --ink:#14201A; --ink-2:#3A473F; --ink-3:#6A776F; --border:#E1E6E2; --border-2:#D2D9D4;
    --accent:#1F7A50; --shadow:0 1px 2px rgba(20,32,26,.05),0 6px 22px rgba(20,32,26,.06);
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;font-size:15px;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:1080px;margin:0 auto;padding:40px 26px 60px;}
  h1{font-family:var(--serif);font-size:clamp(23px,3vw,30px);font-weight:600;letter-spacing:-.015em;line-height:1.12;margin:0;text-wrap:balance;}
  h2{font-size:13px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2);margin:0;}
  h3{font-size:15.5px;font-weight:650;margin:0;}
  .num{font-variant-numeric:tabular-nums;}
  .band{display:flex;align-items:center;gap:12px;margin:38px 0 16px;}
  .band:first-child{margin-top:0;}
  .band h2{white-space:nowrap;}
  .band .who{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);background:var(--surface-2);border:1px solid var(--border);padding:3px 9px;border-radius:100px;}
  .band::after{content:"";flex:1;height:1px;background:var(--border);}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);}
  .verdict{border:1px solid var(--vl);background:linear-gradient(180deg,var(--vt),transparent 70%),var(--surface);border-radius:var(--radius);padding:26px 28px;box-shadow:var(--shadow);position:relative;overflow:hidden;}
  .verdict::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--vc);}
  .verdict-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;}
  .eyebrow{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:9px;}
  .status-badge{display:inline-flex;align-items:center;gap:9px;font-size:15px;font-weight:700;border:1px solid;padding:9px 16px 9px 13px;border-radius:100px;white-space:nowrap;}
  .status-badge svg{width:16px;height:16px;}
  .summary-line{font-size:16px;color:var(--ink);margin:18px 0 0;max-width:70ch;}
  .summary-line b{color:var(--vc);font-weight:650;}
  .stat-cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:24px;}
  .stat{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--c);border-radius:var(--radius-sm);padding:13px 14px;}
  .stat.zero{opacity:.5;border-left-color:var(--border-2);}
  .stat-ico{width:24px;height:24px;flex-shrink:0;color:var(--c);}
  .stat-ico svg{width:100%;height:100%;}
  .stat-n{font-size:22px;font-weight:700;line-height:1;}
  .stat-l{font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3);margin-top:3px;}
  .coverage-card{margin-top:18px;display:grid;grid-template-columns:240px 1fr;gap:32px;align-items:center;}
  .donut-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;}
  .donut{position:relative;width:190px;height:190px;}
  .donut svg{width:100%;height:100%;transform:rotate(-90deg);}
  .donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .donut-center .pct{font-size:40px;font-weight:700;line-height:1;letter-spacing:-.02em;}
  .donut-center .lab{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-top:4px;}
  .donut-sub{font-size:12px;color:var(--ink-3);text-align:center;}
  .mini-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;}
  .mini{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;}
  .mini-n{font-size:20px;font-weight:700;line-height:1;}
  .mini-l{font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3);margin-top:5px;}
  .status-list{display:flex;flex-direction:column;}
  .status-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border);}
  .status-row:last-child{border-bottom:none;}
  .status-row .dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;}
  .status-row .name{flex:1;font-size:13.5px;font-weight:550;color:var(--ink-2);}
  .status-row .count{font-size:16px;font-weight:700;}
  .status-row.zero{opacity:.5;}
  .toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px;}
  .toolbar-hint{font-size:12.5px;color:var(--ink-3);}
  .toolbar .spacer{flex:1;}
  .toggle{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink-2);cursor:pointer;user-select:none;}
  .toggle input{position:absolute;opacity:0;width:0;height:0;}
  .toggle .track{width:34px;height:19px;border-radius:100px;background:var(--surface-3);border:1px solid var(--border-2);position:relative;transition:.15s;flex-shrink:0;}
  .toggle .track::after{content:"";position:absolute;top:1.5px;left:1.5px;width:14px;height:14px;border-radius:50%;background:var(--ink-3);transition:.15s;}
  .toggle input:checked + .track{background:var(--vt,#16281F);border-color:var(--accent);}
  .toggle input:checked + .track::after{transform:translateX(15px);background:var(--accent);}
  .toggle input:focus-visible + .track{outline:2px solid var(--accent);outline-offset:2px;}
  .tc-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:12px;overflow:hidden;}
  .tc-card.hidden{display:none;}
  .tc-head{display:flex;align-items:center;gap:15px;padding:15px 20px;cursor:pointer;user-select:none;border-left:4px solid var(--rc);transition:background .12s;}
  .tc-head:hover{background:var(--surface-2);}
  .tc-head:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
  .tc-chevron{width:28px;height:28px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);color:var(--ink-3);transition:transform .2s ease,background .12s,color .12s,border-color .12s;}
  .tc-chevron svg{width:13px;height:13px;}
  .tc-head:hover .tc-chevron,.tc-card.open .tc-chevron{background:var(--rt);color:var(--rc);border-color:var(--rl);}
  .tc-card.open .tc-chevron{transform:rotate(90deg);}
  .tc-id{min-width:0;flex:1;}
  .tc-id .name{font-weight:650;font-size:15px;}
  .tc-id .spec{font-size:12px;color:var(--ink-3);margin-top:1px;font-family:var(--mono);}
  .tc-metrics{display:flex;align-items:center;gap:22px;}
  .tc-metric{text-align:right;}
  .tc-metric .m-val{font-size:14px;font-weight:700;}
  .tc-metric .m-lab{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);}
  .tc-pill{font-size:11px;font-weight:700;letter-spacing:.03em;padding:5px 13px 5px 10px;border-radius:100px;border:1px solid;display:inline-flex;gap:6px;align-items:center;white-space:nowrap;}
  .tc-pill svg{width:12px;height:12px;}
  .tc-body{border-top:1px solid var(--border);}
  .tc-card:not(.open) .tc-body{display:none;}
  .table-scroll{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:520px;}
  thead th{text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:11px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);}
  th.r,td.r{text-align:right;}
  tbody td{padding:10px 20px;border-bottom:1px solid var(--border);vertical-align:middle;}
  tbody tr:last-child td{border-bottom:none;}
  tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--surface-2) 45%,transparent);}
  tbody tr:hover td{background:var(--surface-2);}
  .st-num{color:var(--ink-3);width:34px;}
  .status-tag{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:650;}
  .status-tag svg{width:13px;height:13px;}
  .note{color:var(--ink-3);font-size:12px;font-family:var(--mono);}
  .trace-row td{background:${S.failed.tint} !important;padding:0 20px 14px;}
  .trace{border:1px dashed ${S.failed.line};border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:12px;color:var(--ink-2);}
  .trace .t-lab{color:${S.failed.color};font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10.5px;margin-bottom:6px;font-family:var(--sans);}
  .empty-state{text-align:center;padding:30px;color:var(--ink-3);font-size:13.5px;background:var(--surface);border:1px dashed var(--border-2);border-radius:var(--radius);}
  footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);font-size:12px;color:var(--ink-3);line-height:1.7;}
  footer .rec{display:flex;flex-wrap:wrap;gap:6px 20px;margin-bottom:8px;}
  footer .rec b{color:var(--ink-2);font-weight:600;}
  @media (max-width:820px){.stat-cards{grid-template-columns:repeat(2,1fr);}.coverage-card{grid-template-columns:1fr;gap:24px;}.mini-kpis{grid-template-columns:repeat(2,1fr);}.tc-metrics .tc-metric.hide-sm{display:none;}}
  @media (max-width:520px){.wrap{padding:28px 16px 44px;}.toolbar-hint{display:none;}.stat-cards{grid-template-columns:1fr;}}
  @media (prefers-reduced-motion:reduce){*{transition:none !important;}}
  @media print{
    :root{--bg:#fff;--surface:#fff;--surface-2:#f4f6f4;--surface-3:#eef1ef;--ink:#111;--ink-2:#333;--ink-3:#666;--border:#ccc;--border-2:#bbb;--shadow:none;}
    body{background:#fff;font-size:11.5px;} .wrap{max-width:none;padding:0;}
    .toolbar,.tc-chevron{display:none;} .tc-card:not(.open) .tc-body{display:block !important;}
    .card,.tc-card,.verdict{break-inside:avoid;box-shadow:none;}
  }`;

const fullDoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Extent Report</title>
<style>${css}</style>
</head>
<body>
${html}
</body>
</html>`;

fs.writeFileSync(outPath, fullDoc, 'utf8');
console.log('wrote', outPath);
