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

const SECRET_FIELD_RE = /token|secret|passw|pwd|authori|cookie|session|otp|key|credential/i;
const SEGMENT_TOKENS = s => s.toLowerCase().split(/[-_.]/).filter(Boolean);
const stripExt = s => s.replace(/\.[A-Za-z0-9]+$/, '');
const readJson = (root, rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } };

// Run folders under executions/, newest first: the timestamp in the folder name, else mtime.
function runFolders(root) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, 'executions'), { withFileTypes: true }); } catch { return []; }
  const keyed = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => {
    const m = /\d{4}-\d{2}-\d{2}[_T]\d{2}-\d{2}-\d{2}/.exec(e.name);
    let k = m ? m[0].replace('T', '_') : '';
    if (!k) { try { k = fs.statSync(path.join(root, 'executions', e.name)).mtime.toISOString().replace('T', '_').replace(/[:.]/g, '-'); } catch { k = ''; } }
    return { name: e.name, k };
  });
  keyed.sort((a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : (a.name < b.name ? 1 : -1)));
  return keyed.map(x => x.name);
}

// "GET /shops/{shopId}/items/{itemId}" -> {re, names} matching the tail of a URL path.
function templateMatcher(op) {
  const m = /^\s*(?:[A-Za-z]+\s+)?(\/\S*)/.exec(String(op));
  if (!m) return null;
  const names = [];
  const body = m[1].split('/').filter(Boolean).map(seg => {
    const parts = seg.split(/(\{[^}]+\})/).map(x => {
      const pm = /^\{([^}]+)\}$/.exec(x);
      if (pm) { names.push(pm[1]); return '([^/]+)'; }
      return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return parts.join('');
  }).join('/');
  if (!names.length) return null;
  return { re: new RegExp('(?:^|/)' + body + '/?$'), names };
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
  const emit = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exitCode = code; };
  const root = path.resolve(opt('--project', process.cwd()));
  const maxFiles = parseInt(opt('--max-files', MAX_FILES), 10) || MAX_FILES;
  const maxBytes = parseInt(opt('--max-bytes', MAX_BYTES), 10) || MAX_BYTES;
  const maxTotal = parseInt(opt('--max-total-bytes', MAX_TOTAL_BYTES), 10) || MAX_TOTAL_BYTES;
  const src = opt('--needs');
  if (!src) return emit({ ok: false, error: 'usage', message: '--needs <json-file|-> is required' }, 2);
  let needs; let eventEnv = null;
  try {
    const raw = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'));
    needs = Array.isArray(raw) ? raw : raw.needs;
    if (!Array.isArray(needs)) throw new Error('no needs array');
    if (!Array.isArray(raw) && typeof raw.env === 'string') eventEnv = raw.env;
  } catch (e) { return emit({ ok: false, error: 'bad-needs', message: e.message }, 2); }
  const targetEnv = opt('--env', eventEnv) || null;

  // environment names and the target environment's users (attribution only; no secret is read)
  const envNames = [];
  try { for (const f of fs.readdirSync(path.join(root, 'environments'))) if (f.endsWith('.json')) envNames.push(f.slice(0, -5)); } catch { /* none */ }
  const envLower = new Map(envNames.map(n => [n.toLowerCase(), n]));
  const userKeys = []; const userValues = new Map(); const ambiguous = new Set();
  for (const en of (targetEnv ? [targetEnv] : envNames)) {
    const j = readJson(root, `environments/${en}.json`);
    const users = j && j.users && typeof j.users === 'object' ? j.users : {};
    for (const [uk, u] of Object.entries(users)) {
      if (!userKeys.includes(uk)) userKeys.push(uk);
      if (!u || typeof u !== 'object') continue;
      for (const [fk, fv] of Object.entries(u)) {
        if (SECRET_FIELD_RE.test(fk) || typeof fv !== 'string' || fv.length < 3) continue;
        if (userValues.has(fv) && userValues.get(fv) !== uk) ambiguous.add(fv); else userValues.set(fv, uk);
      }
    }
  }
  for (const v of ambiguous) userValues.delete(v);
  const userLower = new Map(userKeys.map(k => [k.toLowerCase(), k]));

  const skippedNeeds = needs.filter(n => SECRET_RE.test(n.param)).map(n => n.param);
  const live = needs.filter(n => n && n.param && !SECRET_RE.test(n.param));
  const wanted = new Map(live.map(n => [norm(n.param), n.param]));
  const typeOf = new Map(live.map(n => [n.param, n.type]));
  const matchers = [];
  for (const n of live) for (const op of (Array.isArray(n.operations) ? n.operations : [])) { const t = templateMatcher(op); if (t && !matchers.some(x => x.re.source === t.re.source)) matchers.push(t); }

  const fits = (param, value) => {
    const t = typeOf.get(param);
    if (t === 'integer') return /^-?\d+$/.test(String(value));
    if (t === 'number') return value !== '' && Number.isFinite(Number(value));
    if (t === 'boolean') return /^(true|false)$/i.test(String(value));
    return true;
  };
  const typed = (param, value) => {
    const t = typeOf.get(param);
    if (typeof value === 'string' && (t === 'integer' || t === 'number') && Number.isSafeInteger(Number(value))) return Number(value);
    return value;
  };

  const hits = []; const groups = []; const seen = new Set(); const distinct = new Map();
  let otherEnv = 0;
  const isValue = v => !(v === null || v === undefined || v === '' || typeof v === 'object') && !(typeof v === 'string' && JWT_RE.test(v));
  const newRec = (file, at, ctx, mtime, from, order) => ({ file, at, ctx, mtime, from, order, entries: [] });
  let order = 0;
  // an entry is {param,value,path,from,env,owner}; a record becomes one group
  const record = (rec, param, value, p, from, ctx) => {
    if (!isValue(value)) return;
    const env = ctx.env || null;
    if (env && targetEnv && env.toLowerCase() !== targetEnv.toLowerCase()) { otherEnv++; return; }
    rec.entries.push({ param, value, path: p, from, env, owner: ctx.owner || null });
  };
  const flush = rec => {
    const kept = [];
    for (const e of rec.entries) {
      const dk = `${e.param}\u0000${JSON.stringify(e.value)}`;
      const set = distinct.get(e.param) || new Set();
      if (!set.has(dk) && set.size >= MAX_HITS_PER_PARAM) continue;
      const key = `${dk}\u0000${rec.file}#${rec.at}`;
      if (seen.has(key)) continue;
      seen.add(key); set.add(dk); distinct.set(e.param, set);
      kept.push(e);
    }
    if (!kept.length) return;
    const id = `${rec.file}#${rec.at}`.slice(0, MAX_GROUP_ID);
    const environment = (kept.find(e => e.env) || {}).env || null;
    const owner = (kept.find(e => e.owner) || {}).owner || null;
    const values = {};
    for (const e of kept) if (!(e.param in values)) values[e.param] = e.value;
    groups.push({ id, file: rec.file, at: rec.at, environment, owner, covers: Object.keys(values), values, _mtime: rec.mtime, _order: rec.order++ });
    for (const e of kept) hits.push({ param: e.param, value: e.value, source: 'project', file: rec.file, path: e.path, from: e.from, environment: e.env || environment, owner: e.owner || owner, group: id });
  };

  // URL path -> entries (templates), query strings -> entries; one URL = one record
  const urlRecord = (rel, urlStr, ctx, mtime, at) => {
    let u;
    try { u = new URL(urlStr, 'http://x.invalid'); } catch { return; }
    const rec = newRec(rel, at, ctx, mtime, 'url', order++);
    let pathname = u.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* keep raw */ }
    for (const t of matchers) {
      const m = t.re.exec(pathname);
      if (!m) continue;
      t.names.forEach((nm, i) => {
        const param = wanted.get(norm(nm));
        if (param === undefined || !fits(param, m[i + 1])) return;
        record(rec, param, typed(param, m[i + 1]), `url ${nm}`, 'url-path', ctx);
      });
    }
    for (const [k, v] of u.searchParams) {
      const param = SECRET_RE.test(k) ? undefined : wanted.get(norm(k));
      if (param !== undefined) record(rec, param, v, `query ${k}`, 'query', ctx);
    }
    flush(rec);
  };

  const walkDoc = (doc, rel, baseCtx, mtime, from) => {
    const recs = [];
    const mk = at => { const r = newRec(rel, at, baseCtx, mtime, from, order++); recs.push(r); return r; };
    const root0 = mk('$');
    const walk = (o, p, rec, ctx, inArr) => {
      if (Array.isArray(o)) {
        o.forEach((x, i) => {
          const q = `${p}[${i}]`;
          if (inArr) walk(x, q, rec, ctx, true);
          else walk(x, q, mk(q), ctx, true);
        });
        return;
      }
      if (!o || typeof o !== 'object') return;
      let here = ctx;
      for (const v of Object.values(o)) if (typeof v === 'string' && userValues.has(v)) { here = { ...here, owner: userValues.get(v) }; break; }
      for (const [k, v] of Object.entries(o)) {
        if (SECRET_RE.test(k)) continue;
        let sub = here;
        if (envLower.has(k.toLowerCase()) && v && typeof v === 'object' && !sub.envFixed) sub = { ...sub, env: envLower.get(k.toLowerCase()) };
        if (userLower.has(k.toLowerCase()) && v && typeof v === 'object') sub = { ...sub, owner: userLower.get(k.toLowerCase()) };
        const param = wanted.get(norm(k));
        if (param !== undefined && fits(param, v)) record(rec, param, v, `${p}.${k}`, from, sub);
        if (v && typeof v === 'object') {
          // <stem>.id -> <stem>Id
          if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'id')) {
            const p2 = wanted.get(norm(`${k}Id`));
            if (p2 !== undefined && p2 !== param && fits(p2, v.id)) record(rec, p2, v.id, `${p}.${k}.id`, from, sub);
          }
          walk(v, `${p}.${k}`, rec, sub, inArr);
        } else if (typeof v === 'string' && matchers.length && /^(https?:\/\/|\/)/.test(v) && v.length < 2000) {
          urlRecord(rel, v, sub, mtime, `${p}.${k}`);
        }
      }
    };
    walk(doc, '$', root0, baseCtx, false);
    recs.forEach(flush);
  };

  // ---- the scan list: executions (newest run first), then test/
  const state = { counted: 0, files: 0, bytes: 0, highSignal: 0, truncated: false, reason: undefined };
  const runInfo = new Map();
  const scanFile = (rel, runName) => {
    const high = isHighSignal(rel);
    if (!high && state.counted >= maxFiles) { state.truncated = true; state.reason = state.reason || 'max-files'; return true; }
    let text; let mtime = 0;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.size > maxBytes) return false;
      if (state.bytes + st.size > maxTotal) { state.truncated = true; state.reason = 'max-total-bytes'; return false; }
      mtime = st.mtimeMs;
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch { return true; }
    state.files++; state.bytes += Buffer.byteLength(text);
    if (high) state.highSignal++; else state.counted++;
    // attribution from the project's own data
    const segs = rel.split('/');
    let env = null; let owner = null;
    if (runName) { const info = runInfo.get(runName); env = info ? info.env : null; }
    if (!env) for (const sg of segs.slice(0, -1).concat(stripExt(segs[segs.length - 1]))) if (envLower.has(sg.toLowerCase())) { env = envLower.get(sg.toLowerCase()); break; }
    for (const sg of segs.slice(0, -1).concat(stripExt(segs[segs.length - 1]))) if (userLower.has(sg.toLowerCase())) { owner = userLower.get(sg.toLowerCase()); break; }
    if (!owner && runName) {
      const found = new Set();
      for (const sg of segs.slice(2)) for (const tk of SEGMENT_TOKENS(stripExt(sg))) if (userLower.has(tk)) found.add(userLower.get(tk));
      if (found.size === 1) owner = [...found][0];
    }
    const ctx = { env, owner, envFixed: !!(runName && env) };
    const base = rel.startsWith('executions/') ? 'body' : 'test-data';
    if (rel.endsWith('.csv')) {
      const rows = csvRows(text);
      if (rows.length < 2) return false;
      for (let r = 1; r < rows.length; r++) {
        const rec = newRec(rel, `row ${r + 1}`, ctx, mtime, 'csv', order++);
        rows[0].forEach((h, col) => {
          const param = SECRET_RE.test(h) ? undefined : wanted.get(norm(h));
          if (param !== undefined && fits(param, rows[r][col])) record(rec, param, rows[r][col], `row ${r + 1}, column "${h}"`, 'csv', ctx);
        });
        flush(rec);
      }
    } else if (rel.endsWith('.log')) {
      // run_api.js evidence: "<METHOD> <url>\n\nHTTP_STATUS:<n>\n<headers>\n\n<body>"
      const m = /^[A-Z]+ (\S+)/.exec(text.split('\n')[0] || '');
      if (m) urlRecord(rel, m[1], ctx, mtime, 'url');
      const body = text.split(/\n\n/).slice(2).join('\n\n').trim();
      try { walkDoc(JSON.parse(body), rel, ctx, mtime, 'body'); } catch { /* not JSON */ }
    } else if (rel.endsWith('.md')) {
      const seenUrls = new Set();
      for (const um of text.matchAll(/(?:https?:\/\/[^\s)"'`<>|]+|(?<![\w.])\/[A-Za-z0-9_\-.~%/]{2,})/g)) {
        const u = um[0].replace(/[.,;:]+$/, '');
        if (seenUrls.has(u) || !matchers.length) continue;
        seenUrls.add(u);
        urlRecord(rel, u, ctx, mtime, `url ${u}`);
      }
    } else {
      try { walkDoc(JSON.parse(text), rel, ctx, mtime, base); } catch { /* not JSON */ }
    }
    return false;
  };

  let stop = false;
  for (const run of runFolders(root)) {
    const list = [];
    listFiles(root, `executions/${run}`, ['.log', '.json', '.md'], list);
    const files = list.filter(r => !r.endsWith('.md') || HIGH_SIGNAL_NAMES.has(r.split('/').pop()));
    let env = null;
    for (const nm of ['suite-result.json', 'run-summary.json']) {
      const rel = files.filter(r => r.split('/').pop() === nm).sort((a, b) => a.split('/').length - b.split('/').length)[0];
      const j = rel && readJson(root, rel);
      const v = j && (nm === 'suite-result.json' ? (j.env || j.environment) : (j.environment || j.env));
      if (typeof v === 'string' && v) { env = v; break; }
    }
    runInfo.set(run, { env });
    for (const rel of files) { if (scanFile(rel, run) === true && state.reason === 'max-files') { /* keep going for high-signal */ } }
    if (state.reason === 'max-total-bytes') { stop = true; break; }
  }
  const loose = [];
  listFiles(root, 'executions', ['.log', '.json'], loose);
  if (!stop) for (const rel of loose.filter(r => r.split('/').length === 2)) scanFile(rel, null);
  const testFiles = [];
  if (!stop) listFiles(root, 'test', ['.json', '.csv'], testFiles);
  if (!stop) for (const rel of testFiles.filter(f => !f.startsWith('test/.auth/'))) { scanFile(rel, null); if (state.reason === 'max-total-bytes') break; }

  // cataloged DB queries
  const dbFiles = [];
  listFiles(root, 'integration', ['_db.json'], dbFiles);
  const db = [];
  for (const rel of dbFiles) {
    const j = readJson(root, rel);
    if (!j) continue;
    for (const q of (Array.isArray(j.queries) ? j.queries : [])) {
      const sql = String(q.query || '');
      db.push({ entry: `${j.name}.${q.name}`, file: posix(rel), params: q.params || [], selectOnly: /^\s*(select|with)\b/i.test(sql) && !WRITE_SQL.test(sql),
        ...(q.description ? { description: q.description } : {}), query: sql });
    }
  }
  // groups: same environment, then unknown; then more needs covered; then newest file
  const rank = g => (targetEnv && g.environment && g.environment.toLowerCase() === targetEnv.toLowerCase() ? 0 : g.environment ? 0 : 1);
  groups.sort((a, b) => rank(a) - rank(b) || b.covers.length - a.covers.length || b._mtime - a._mtime || a._order - b._order);
  for (const g of groups) { delete g._mtime; delete g._order; }
  const out = { ok: true, hits, groups, db, scanned: { files: state.files, bytes: state.bytes, highSignal: state.highSignal }, truncated: state.truncated, ...(state.reason ? { truncatedReason: state.reason } : {}), skipped: { otherEnvironment: otherEnv }, skippedNeeds };
  return emit(out, 0);
}

if (require.main === module) main(process.argv);
module.exports = { norm, csvRows, templateMatcher };
