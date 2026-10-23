#!/usr/bin/env node
'use strict';
// AgenTeX suite wizard — "project first": find values for the wizard's needs in the project
// itself before anyone opens the application. Deterministic search only; which hit answers
// which need is the agent's judgment.
//
// Usage: node project_values.js --needs <json-file|-> [--env <e>] [--max-files 500]
//          [--max-bytes 1048576] [--max-total-bytes 268435456] [--project <root>]
//   --needs: [{param, in, type, operations?}] or a channel "collect" event ({env, needs: [...]}).
//   --env: the environment the values must belong to (default: the event's env).
// Order: executions/ run folders newest first (folder name, then mtime), then test/. High-signal
// execution files (*.log, suite-result.json, run-summary.json, result.md, report.md) do not count
// toward --max-files. Skips .env*, test/.auth/, .agentex/, node_modules/, dot-folders, secret-named
// keys (a need named like a secret is not searched at all) and JWT-shaped values. Extraction: URL
// paths matched against the needs' operations' path templates ("GET /items/{itemId}" <- /items/98),
// query strings, JSON bodies and test data by key name (plus <stem>.id -> <stem>Id), CSV columns.
// Every hit carries environment, owner and group (null when nothing in the project says; never a
// guess). A hit from another environment is dropped and only counted. environments/<env>.json is
// read for user keys and non-secret string fields (owner attribution), never a secret.
// Lists integration/**/*_db.json queries with "selectOnly" (starts with SELECT/WITH and has no
// write keyword) — run only those, through run_db.js.
// Prints ONE JSON line: {"ok":true,"hits":[{param,value,source:"project",file,path,from,
//   environment,owner,group}],"groups":[{id,file,at,environment,owner,covers,values}],
//   "db":[...],"scanned":{files,bytes,highSignal},"truncated":bool,"truncatedReason"?,
//   "skipped":{"otherEnvironment":n},"skippedNeeds":[...]}. Exit 0, or 2 on bad input.
const fs = require('fs');
const path = require('path');

const MAX_FILES = 500;            // (Q8) counted files: test data and non-evidence execution files
const MAX_BYTES = 1024 * 1024;    // per file (Q8)
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // guard over the whole scan
const MAX_HITS_PER_PARAM = 5;     // distinct values kept per need (Q8)
const MAX_GROUP_ID = 200;
const SECRET_RE = /token|secret|passw|authori|cookie|session|otp/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const WRITE_SQL = /\b(insert|update|delete|merge|drop|truncate|alter|create|exec|execute|grant|revoke|into)\b/i;
const HIGH_SIGNAL_NAMES = new Set(['suite-result.json', 'run-summary.json', 'result.md', 'report.md']);

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const posix = p => p.split(path.sep).join('/');
const isHighSignal = rel => rel.startsWith('executions/') && (rel.endsWith('.log') || HIGH_SIGNAL_NAMES.has(rel.split('/').pop()));

// Every candidate file under root/rel, directory order sorted by name; no cap (the caller caps).
function listFiles(root, rel, exts, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.startsWith('.env')) continue;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      listFiles(root, r, exts, out);
    } else if (e.isFile() && exts.some(x => e.name.toLowerCase().endsWith(x))) out.push(r);
  }
}

function csvRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(c => c.trim()));
  }
  return rows;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
  const emit = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };
  const root = path.resolve(opt('--project', process.cwd()));
  const maxFiles = parseInt(opt('--max-files', MAX_FILES), 10) || MAX_FILES;
  const maxBytes = parseInt(opt('--max-bytes', MAX_BYTES), 10) || MAX_BYTES;
  const src = opt('--needs');
  if (!src) return emit({ ok: false, error: 'usage', message: '--needs <json-file|-> is required' }, 2);
  let needs;
  try {
    const raw = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'));
    needs = Array.isArray(raw) ? raw : raw.needs;
    if (!Array.isArray(needs)) throw new Error('no needs array');
  } catch (e) { return emit({ ok: false, error: 'bad-needs', message: e.message }, 2); }

  const skippedNeeds = needs.filter(n => SECRET_RE.test(n.param)).map(n => n.param);
  const wanted = new Map(needs.filter(n => n && n.param && !SECRET_RE.test(n.param)).map(n => [norm(n.param), n.param]));
  const hits = [];
  const seen = new Set();
  const addHit = (param, value, file, p) => {
    if (value === null || value === undefined || value === '' || typeof value === 'object') return;
    if (typeof value === 'string' && JWT_RE.test(value)) return;
    const key = `${param}\u0000${JSON.stringify(value)}`;
    if (seen.has(key) || hits.filter(h => h.param === param).length >= MAX_HITS_PER_PARAM) return;
    seen.add(key);
    hits.push({ param, value, source: 'project', file, path: p });
  };
  const walk = (o, file, p) => {
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, file, `${p}[${i}]`)); return; }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (SECRET_RE.test(k)) continue;
      const param = wanted.get(norm(k));
      if (param !== undefined) addHit(param, v, file, `${p}.${k}`);
      if (v && typeof v === 'object') walk(v, file, `${p}.${k}`);
    }
  };

  const files = [];
  listFiles(root, 'test', ['.json', '.csv'], files, maxFiles);
  const execFiles = [];
  listFiles(root, 'executions', ['.log', '.json'], execFiles, Math.max(0, maxFiles - files.length));
  const all = [...files.filter(f => !f.startsWith('test/.auth/')), ...execFiles].slice(0, maxFiles);
  const truncated = !!(files.truncated || execFiles.truncated) || files.length + execFiles.length > maxFiles;
  let bytes = 0; let count = 0;
  for (const rel of all) {
    let text;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.size > maxBytes) continue;
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch { continue; }
    count++; bytes += Buffer.byteLength(text);
    if (rel.endsWith('.csv')) {
      const rows = csvRows(text);
      if (rows.length < 2) continue;
      rows[0].forEach((h, col) => {
        const param = SECRET_RE.test(h) ? undefined : wanted.get(norm(h));
        if (param === undefined) return;
        for (let r = 1; r < rows.length; r++) addHit(param, rows[r][col], rel, `row ${r + 1}, column "${h}"`);
      });
    } else if (rel.endsWith('.log')) {
      // run_api.js evidence: "<METHOD> <url>\n\nHTTP_STATUS:<n>\n<headers>\n\n<body>"
      const first = text.split('\n')[0] || '';
      const m = /^[A-Z]+ (\S+)/.exec(first);
      if (m) {
        try {
          for (const [k, v] of new URL(m[1]).searchParams) {
            const param = SECRET_RE.test(k) ? undefined : wanted.get(norm(k));
            if (param !== undefined) addHit(param, v, rel, `query ${k}`);
          }
        } catch { /* not a URL */ }
      }
      const parts = text.split(/\n\n/);
      const body = parts.slice(2).join('\n\n').trim();
      try { walk(JSON.parse(body), rel, '$'); } catch { /* not JSON */ }
    } else {
      try { walk(JSON.parse(text), rel, '$'); } catch { /* not JSON */ }
    }
  }

  // cataloged DB queries
  const dbFiles = [];
  listFiles(root, 'integration', ['_db.json'], dbFiles, 1000);
  const db = [];
  for (const rel of dbFiles) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { continue; }
    for (const q of (j && Array.isArray(j.queries) ? j.queries : [])) {
      const sql = String(q.query || '');
      db.push({ entry: `${j.name}.${q.name}`, file: posix(rel), params: q.params || [], selectOnly: /^\s*(select|with)\b/i.test(sql) && !WRITE_SQL.test(sql),
        ...(q.description ? { description: q.description } : {}), query: sql });
    }
  }
  return emit({ ok: true, hits, db, scanned: { files: count, bytes }, truncated, skippedNeeds }, 0);
}

if (require.main === module) main(process.argv);
module.exports = { norm, csvRows };
