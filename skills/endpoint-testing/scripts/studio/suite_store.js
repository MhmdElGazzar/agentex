'use strict';
// AgenTeX suite studio — suite files under integration/api_test_suites/ (searched recursively):
// listing with counts, filters, last results, and the hash-checked Save merge (#11).
//
// Save never overwrites a change it has not seen: the page sends its edits together with the
// sha-256 of the file as it loaded it. A different hash on disk → "conflict", nothing written.
// Otherwise each edit is applied to the parsed ON-DISK object, touching only the keys the
// editor manages (name, auth, params, sources, omit, expect.status / fields / one message
// path, skip; add; delete), so unknown fields, review notes and the order of untouched cases
// survive by construction. The write is temp file + rename, with the hash checked once more
// just before the rename. A file that is not 2-space JSON needs one consent first (A10).
// Catalogs (*_api.json) are never loaded or written here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUITES_DIR = 'integration/api_test_suites';
const RUNS_SCANNED = 50; // newest suite-result.json files read for "last result" (Q8)
const CASE_KEYS = ['name', 'entry', 'kind', 'auth', 'params', 'sources', 'omit', 'expect', 'skip', 'review'];

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const posix = p => p.split(path.sep).join('/');
const canonicalText = obj => JSON.stringify(obj, null, 2) + '\n';

function resolveSuite(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('not a suite file: no path given');
  const base = path.resolve(root, SUITES_DIR);
  const full = path.resolve(root, rel);
  let real = full;
  try { real = fs.realpathSync(full); } catch { /* new or missing file */ }
  let realBase = base;
  try { realBase = fs.realpathSync(base); } catch { /* no suites folder */ }
  if (!full.endsWith('_suite.json') || !(full.startsWith(base + path.sep) && (real === full || real.startsWith(realBase + path.sep)))) {
    throw new Error(`not a suite file under ${SUITES_DIR}: ${rel}`);
  }
  return full;
}

function findSuiteFiles(dir) {
  let found = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) found = found.concat(findSuiteFiles(full)); }
    else if (e.isFile() && e.name.endsWith('_suite.json')) found.push(full);
  }
  return found;
}

function load(root, rel) {
  const full = resolveSuite(root, rel);
  const buf = fs.readFileSync(full);
  const json = JSON.parse(buf.toString('utf8'));
  return { path: posix(path.relative(root, full)), json, etag: sha(buf), canonical: buf.toString('utf8') === canonicalText(json) };
}

// The one "Needs review" predicate (not skipped, still a placeholder value), shared with the wizard.
const { needsReview } = require(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'swagger_model.js'));

// The newest result per case index of one suite, from executions/*/api-tests/suite-result.json.
function lastResults(root, rel, limit = RUNS_SCANNED) {
  const execDir = path.join(root, 'executions');
  let runs = [];
  try {
    for (const d of fs.readdirSync(execDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(execDir, d.name, 'api-tests', 'suite-result.json');
      try { runs.push({ f, dir: d.name, t: fs.statSync(f).mtimeMs }); } catch { /* no result */ }
    }
  } catch { return {}; }
  runs.sort((a, b) => b.t - a.t || b.dir.localeCompare(a.dir));
  runs = runs.slice(0, limit);
  const out = {};
  for (const r of runs) {
    let j;
    try { j = JSON.parse(fs.readFileSync(r.f, 'utf8')); } catch { continue; }
    for (const c of j.cases || []) {
      if (c.suite !== rel || !c.index || out[c.index]) continue;
      out[c.index] = { name: c.name, result: c.result, status: c.status, ms: c.ms, reason: c.reason, reasonCode: c.reasonCode,
        failures: c.failures, log: c.log, skipped: c.skipped, run: `executions/${r.dir}/api-tests`, at: j.startedAt };
    }
  }
  return out;
}
const lastFor = (c, index, last) => (last[index] && last[index].name === c.name ? last[index] : null);

function matchesFilter(c, last, filter) {
  switch (filter) {
    case 'needs-review': return needsReview(c);
    case 'failing': return !!last && last.result === 'FAIL';
    case 'skipped': return !!c.skip;
    default: return true;
  }
}

function countsOf(json, last) {
  const cases = Array.isArray(json.cases) ? json.cases : [];
  return {
    endpoints: new Set(cases.map(c => c.entry)).size,
    cases: cases.length,
    needsReview: cases.filter(needsReview).length,
    skipped: cases.filter(c => c.skip).length,
    failing: cases.filter((c, i) => { const l = lastFor(c, i + 1, last); return l && l.result === 'FAIL'; }).length,
  };
}

function listSuites(root) {
  return findSuiteFiles(path.join(root, SUITES_DIR)).map(f => posix(path.relative(root, f))).sort().map(rel => {
    try {
      const { json } = load(root, rel);
      return { path: rel, name: json.name || path.basename(rel, '_suite.json'), ...countsOf(json, lastResults(root, rel)) };
    } catch (e) { return { path: rel, name: path.basename(rel, '_suite.json'), error: e.message }; }
  });
}

// ---- the edit model ----
function applyUpdate(c, u) {
  if (typeof u.name === 'string' && u.name.trim()) c.name = u.name.trim();
  if ('auth' in u) { if (u.auth === 'none') c.auth = 'none'; else delete c.auth; }
  if (u.params && typeof u.params === 'object') {
    c.params = c.params || {};
    for (const [k, v] of Object.entries(u.params)) c.params[k] = v;
  }
  if (u.sources && typeof u.sources === 'object') {
    c.sources = c.sources || {};
    for (const [k, v] of Object.entries(u.sources)) { if (v == null) delete c.sources[k]; else c.sources[k] = v; }
    if (!Object.keys(c.sources).length) delete c.sources;
  }
  if ('omit' in u) { if (Array.isArray(u.omit) && u.omit.length) c.omit = u.omit.map(String); else delete c.omit; }
  if (u.expect && typeof u.expect === 'object') {
    const e = c.expect = c.expect || {};
    if ('status' in u.expect) { if (u.expect.status === null || u.expect.status === '') delete e.status; else e.status = Number(u.expect.status); }
    if ('fields' in u.expect) { if (Array.isArray(u.expect.fields) && u.expect.fields.length) e.fields = u.expect.fields.map(String); else delete e.fields; }
    if ('message' in u.expect) {
      const m = u.expect.message || {};
      const from = m.from !== undefined ? m.from : m.path;
      for (const map of ['equals', 'contains']) if (e[map] && from) delete e[map][from];
      if (m.path && typeof m.text === 'string' && m.text !== '') {
        const map = m.match === 'contains' ? 'contains' : 'equals';
        e[map] = e[map] || {};
        e[map][m.path] = m.text;
      }
      for (const map of ['equals', 'contains']) if (e[map] && !Object.keys(e[map]).length) delete e[map];
    }
  }
  if ('skip' in u) { if (u.skip) c.skip = String(u.skip); else delete c.skip; }
}
function newCase(src) {
  const c = {};
  for (const k of CASE_KEYS) if (src && src[k] !== undefined) c[k] = src[k];
  if (!c.name || !c.entry) throw new Error('a new case needs a name and an entry');
  return c;
}
function applyEdits(obj, edits) {
  if (!obj || typeof obj !== 'object') throw new Error('suite file is not a JSON object');
  const cases = Array.isArray(obj.cases) ? obj.cases : (obj.cases = []);
  const orig = cases.slice();
  const ref = i => {
    const c = orig[Number(i) - 1];
    if (!c) throw new Error(`an edit refers to case ${i}, but the suite has ${orig.length} cases`);
    return c;
  };
  const deleted = new Set();
  for (const e of edits || []) {
    if (e.op === 'update') applyUpdate(ref(e.index), e.case || {});
    else if (e.op === 'delete') deleted.add(ref(e.index));
    else if (e.op === 'add') {
      const c = newCase(e.case);
      let at = -1;
      cases.forEach((x, i) => { if (x.entry === (e.entry || c.entry)) at = i; });
      if (at === -1) cases.push(c); else cases.splice(at + 1, 0, c);
    } else throw new Error(`unknown edit op ${JSON.stringify(e.op)}`);
  }
  obj.cases = cases.filter(c => !deleted.has(c));
  return obj;
}

function save(root, rel, etag, edits, opts = {}) {
  const full = resolveSuite(root, rel);
  const buf = fs.readFileSync(full);
  if (sha(buf) !== etag) return { status: 'conflict' };
  const json = JSON.parse(buf.toString('utf8'));
  if (buf.toString('utf8') !== canonicalText(json) && !opts.acceptFormat) return { status: 'needs-format-consent' };
  let next;
  try { next = applyEdits(json, edits); } catch (e) { return { status: 'invalid', error: e.message }; }
  const text = canonicalText(next);
  const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    if (opts.beforeRename) opts.beforeRename(tmp);
    if (sha(fs.readFileSync(full)) !== etag) { fs.unlinkSync(tmp); return { status: 'conflict' }; }
    fs.renameSync(tmp, full);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return { status: 'ok', etag: sha(Buffer.from(text)) };
}

module.exports = { SUITES_DIR, RUNS_SCANNED, sha, canonicalText, resolveSuite, findSuiteFiles, load, listSuites, lastResults, lastFor, matchesFilter, countsOf, needsReview, applyEdits, save };
