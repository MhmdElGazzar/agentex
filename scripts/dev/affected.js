'use strict';
// Impact analysis for the plugin repo: picks the script tests and behavioral evals a change
// can affect, so a dev loop or a feature's QA gate runs only those. Maintainer tooling —
// never shipped (scripts/hosts/build_host.js COMMON_EXCLUDES). A release still runs
// everything: `--all --run`.
//
// Usage: node scripts/dev/affected.js [--base <ref>] [--files a,b] [--all] [--run] [--json]
//   Changed files = the merge-base of <ref> (default main) and HEAD, diffed against the
//   working tree, plus untracked files. --files replaces that lookup (comma-separated,
//   repeatable).
//   --run executes the selected script tests in parallel through scripts/run-tests.js's pool
//   (its SERIAL_ONLY files one at a time after); evals are only listed (they run through
//   `claude plugin eval`, slow and paid, so starting them stays a human call).
// Exit: 0 ok · 1 a selected test failed (--run) · 2 usage or git error.
//
// Tests: a test depends on what it require()s and on every path it builds from __dirname
// (or from a constant built that way) — spawned runners, templates, fixture folders — and,
// transitively, on what those .js files depend on. A path with a dynamic tail
// (`path.join(__dirname, name)`) depends on the whole folder before the dynamic part.
// Safety net: a changed code or data file no test reaches selects every script test.
//
// Evals: evals/coverage.json maps each case to the paths it exercises. A changed .js file
// also counts as a change to every file that requires or spawns it. A pattern that names a
// folder (no file extension) covers the prompts, references and data below it, never its
// scripts — a script change selects a case only through a pattern naming that script (or a
// file that requires it); a *.test.js still counts as anything else. Any change to a
// skills/*/SKILL.md or commands/*.md frontmatter selects every trigger-* and negative-* case.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { matcher } = require('../hosts/transforms.js');
const { runPool, partition, SERIAL_ONLY } = require('../run-tests.js');

// Only these paths can change what a test or an eval sees; docs, CHANGELOG and spikes cannot.
const IMPACT_ROOTS = matcher(['skills', 'scripts', 'commands', 'agents', 'templates', 'hosts',
  'references', 'evals', 'test', '.claude-plugin', 'settings.example.json', '.env.example']);
const NEVER_SCANNED = matcher(['.claude', '.git', 'node_modules']);
const DESCRIPTION_SOURCES = matcher(['skills/*/SKILL.md', 'commands/*.md']);
const PROMPT_FILES = matcher(['skills', 'commands', 'agents', 'references']);
const isTest = (f) => f.endsWith('.test.js');
const isJs = (f) => /\.[cm]?js$/.test(f);
const isScript = (f) => isJs(f) && !isTest(f);
// An eval-coverage pattern names a folder when its last segment has no file extension.
const namesFolder = (pattern) => !/\.[A-Za-z0-9]+$/.test(pattern.replace(/\/+$/, '').split('/').pop());
// A case's matcher: a folder pattern never matches a script, a file pattern matches as written.
function caseMatcher(patterns) {
  const each = (patterns || []).map((p) => ({ folder: namesFolder(p), match: matcher([p]) }));
  return (f) => each.some((e) => e.match(f) && !(e.folder && isScript(f)));
}

// ---- git ------------------------------------------------------------------------------
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const lines0 = (out) => out.split('\0').filter(Boolean);
const posix = (f) => f.replace(/\\/g, '/').replace(/^\.\//, '');

function repoFiles(root) {
  return lines0(git(root, ['ls-files', '-co', '--exclude-standard', '-z']))
    .filter((f) => !NEVER_SCANNED(f) && fs.existsSync(path.join(root, f)));
}

function changedFiles(root, base) {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const files = [
    ...lines0(git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase])),
    ...lines0(git(root, ['ls-files', '-o', '--exclude-standard', '-z'])),
  ];
  return { mergeBase, files: [...new Set(files)].filter((f) => !NEVER_SCANNED(f)).sort() };
}

// ---- dependency graph -----------------------------------------------------------------
const LIT = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*"|\`[^\`\\$\n]*\`)`;
const REQUIRE_RE = /require(?:\.resolve)?\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
const CONST_RE = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)((?:\s*,\s*${LIT})*)\s*\)`, 'g');
const CALL_RE = new RegExp(String.raw`path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)((?:\s*,\s*${LIT})*)\s*([,)])`, 'g');
const literals = (args) => [...args.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// Repo-relative join; null when the path leaves the repo.
function within(dir, parts) {
  const p = path.posix.normalize(path.posix.join(dir, ...parts));
  if (p === '.') return '';
  return p.startsWith('../') || p === '..' ? null : p;
}

function makeGraph(root, files) {
  const fileSet = new Set(files);
  const dirSet = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  const cache = new Map();

  // Direct dependencies of one file: { files, dirs } (a dir means everything below it; '' is the repo).
  function direct(file) {
    if (cache.has(file)) return cache.get(file);
    const out = { files: new Set(), dirs: new Set() };
    cache.set(file, out);
    if (!isJs(file)) return out;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    // A folder holding this file (`path.resolve(__dirname, '..', '..')`) is where paths
    // start from, not something the file reads as a whole.
    const holdsFile = (p) => p === '' || dir === p || dir.startsWith(`${p}/`);
    const addExact = (p) => {
      if (p === null) return;
      if (fileSet.has(p)) out.files.add(p);
      else if (dirSet.has(p) && !holdsFile(p)) out.dirs.add(p);
    };

    for (const m of src.matchAll(REQUIRE_RE)) {
      if (!m[2].startsWith('.')) continue;
      const p = within(dir, [m[2]]);
      if (p === null) continue;
      const hit = [p, `${p}.js`, `${p}.json`, `${p}/index.js`].find((c) => fileSet.has(c));
      if (hit) out.files.add(hit);
    }

    // Path constants in source order, so one may build on another. A constant naming a file
    // (`const CLI = path.join(__dirname, 'run.js')`) is a dependency; one naming a folder
    // (`const ROOT = path.resolve(__dirname, '..')`) is only a base for later paths.
    const consts = new Map([['__dirname', dir]]);
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*__dirname\s*[;\n]/g)) consts.set(m[1], dir);
    const definitionSpans = [];
    for (const m of src.matchAll(CONST_RE)) {
      definitionSpans.push([m.index, m.index + m[0].length]);
      if (!consts.has(m[2])) continue;
      const p = within(consts.get(m[2]), literals(m[3]));
      if (p === null) continue;
      consts.set(m[1], p);
      if (fileSet.has(p)) out.files.add(p);
    }
    for (const m of src.matchAll(CALL_RE)) {
      if (definitionSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
      if (!consts.has(m[1])) continue;
      const p = within(consts.get(m[1]), literals(m[2]));
      if (m[3] === ',') { if (p !== null) out.dirs.add(p); } // dynamic tail: the whole folder
      else addExact(p);
    }
    return out;
  }

  // Everything a file reaches, following .js dependencies transitively.
  function closure(file) {
    const seen = new Set([file]); const dirs = new Set(); const queue = [file];
    while (queue.length) {
      const d = direct(queue.shift());
      d.dirs.forEach((x) => dirs.add(x));
      for (const f of d.files) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    }
    return { files: seen, dirs };
  }

  // Every .js file that reaches `file` through require/spawn edges (dirs not followed).
  let reverse = null;
  function dependents(file) {
    if (!reverse) {
      reverse = new Map();
      for (const f of files) if (isJs(f) && !isTest(f)) {
        for (const d of direct(f).files) {
          if (!reverse.has(d)) reverse.set(d, new Set());
          reverse.get(d).add(f);
        }
      }
    }
    const seen = new Set(); const queue = [file];
    while (queue.length) for (const f of reverse.get(queue.shift()) || []) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    return seen;
  }

  return { closure, dependents };
}

const reaches = (c, changed) => changed.files.has(c) || [...changed.dirs].some((d) => d === '' || c === d || c.startsWith(`${d}/`));

// ---- frontmatter ----------------------------------------------------------------------
const frontmatter = (text) => (text.match(/^---\r?\n[\s\S]*?\r?\n---/) || [''])[0];
function descriptionChanged(root, mergeBase, file) {
  if (!mergeBase) return true;
  const abs = path.join(root, file);
  const now = fs.existsSync(abs) ? frontmatter(fs.readFileSync(abs, 'utf8')) : null;
  let before = null;
  try { before = frontmatter(git(root, ['show', `${mergeBase}:${file}`])); } catch { /* new file */ }
  return now !== before;
}

// ---- selection ------------------------------------------------------------------------
function loadCoverage(root) {
  const file = path.join(root, 'evals', 'coverage.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')).cases || {};
}

function select({ root, changed, mergeBase = null, all = false }) {
  const files = repoFiles(root);
  const tests = files.filter(isTest).sort();
  const coverage = loadCoverage(root);
  const cases = Object.keys(coverage).sort();
  const result = {
    changed, tests: { total: tests.length, selected: [], fallback: [] },
    evals: { total: cases.length, selected: [], descriptionChanged: [] },
    noImpact: [], uncoveredByEvals: [],
  };
  if (all) {
    result.tests.selected = tests.map((t) => ({ test: t, because: ['--all'] }));
    result.evals.selected = cases.map((c) => ({ case: c, because: ['--all'] }));
    return result;
  }

  const graph = makeGraph(root, files);
  const testHits = new Map(tests.map((t) => [t, []]));
  const evalHits = new Map(cases.map((c) => [c, []]));
  const caseMatch = new Map(cases.map((c) => [c, caseMatcher(coverage[c])]));
  const closures = new Map(tests.map((t) => [t, graph.closure(t)]));

  for (const c of changed) {
    if (!IMPACT_ROOTS(c)) { result.noImpact.push(c); continue; }

    let reachedByTest = false;
    for (const t of tests) if (reaches(c, closures.get(t))) { testHits.get(t).push(c); reachedByTest = true; }

    let reachedByEval = false;
    const evalCase = c.match(/^evals\/([^/]+)\//);
    if (evalCase && evalHits.has(evalCase[1])) { evalHits.get(evalCase[1]).push(c); reachedByEval = true; }
    const via = isJs(c) ? [c, ...graph.dependents(c)] : [c];
    for (const k of cases) if (via.some((f) => caseMatch.get(k)(f))) { evalHits.get(k).push(c); reachedByEval = true; }
    if (DESCRIPTION_SOURCES(c) && descriptionChanged(root, mergeBase, c)) {
      result.evals.descriptionChanged.push(c);
      for (const k of cases) if (/^(trigger|negative)-/.test(k)) evalHits.get(k).push(c);
      reachedByEval = true;
    }

    if (c.startsWith('evals/')) continue;
    if (c.endsWith('.md')) { if (!reachedByEval && PROMPT_FILES(c)) result.uncoveredByEvals.push(c); continue; }
    if (!reachedByTest) result.tests.fallback.push(c);
  }

  result.tests.selected = result.tests.fallback.length
    ? tests.map((t) => ({ test: t, because: testHits.get(t).length ? [...new Set(testHits.get(t))] : ['fallback'] }))
    : tests.filter((t) => testHits.get(t).length).map((t) => ({ test: t, because: [...new Set(testHits.get(t))] }));
  result.evals.selected = cases.filter((k) => evalHits.get(k).length).map((k) => ({ case: k, because: [...new Set(evalHits.get(k))] }));
  return result;
}

// ---- running and printing ---------------------------------------------------------------
async function runTests(root, selected) {
  const { pool, serial } = partition(selected.map((s) => s.test), SERIAL_ONLY);
  const done = [...await runPool(root, pool, os.cpus().length), ...await runPool(root, serial, 1)];
  return done.map((r) => ({ test: r.file, exit: r.exit === null ? 1 : r.exit, tail: r.tail }))
    .sort((a, b) => a.test.localeCompare(b.test));
}

function print(r, header) {
  const out = [header, ''];
  out.push(`Script tests: ${r.tests.selected.length} of ${r.tests.total}`);
  if (r.tests.fallback.length) {
    out.push('  All selected: no test reaches these changed files (add a test, or this falls back every time):');
    r.tests.fallback.forEach((f) => out.push(`    ${f}`));
  } else r.tests.selected.forEach((s) => out.push(`  node ${s.test}    ← ${s.because.join(', ')}`));
  out.push('', `Evals: ${r.evals.selected.length} of ${r.evals.total}`);
  if (r.evals.descriptionChanged.length) out.push(`  every trigger-* / negative-* case: a description changed in ${r.evals.descriptionChanged.join(', ')}`);
  r.evals.selected.forEach((s) => out.push(`  claude plugin eval . --scaffold --case ${s.case}    ← ${s.because.join(', ')}`));
  if (r.uncoveredByEvals.length) out.push('', 'No eval covers (behavior change here is untested):', ...r.uncoveredByEvals.map((f) => `  ${f}`));
  if (r.noImpact.length) {
    const more = r.noImpact.length > 5 ? `, +${r.noImpact.length - 5} more` : '';
    out.push('', `No test or eval impact (${r.noImpact.length}): ${r.noImpact.slice(0, 5).join(', ')}${more}`);
  }
  console.log(out.join('\n'));
}

function parseArgs(argv) {
  const a = { base: 'main', files: null, all: false, run: false, json: false, root: path.resolve(__dirname, '..', '..') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--all') a.all = true;
    else if (k === '--run') a.run = true;
    else if (k === '--json') a.json = true;
    else if (k === '--base' || k === '--files' || k === '--root') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      if (k === '--base') a.base = v;
      else if (k === '--root') a.root = path.resolve(v);
      else a.files = [...(a.files || []), ...v.split(',').map((f) => posix(f.trim())).filter(Boolean)];
    } else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(`affected: ${e.message}`); return 2; }
  let changed; let mergeBase = null;
  try {
    if (a.files) {
      changed = [...new Set(a.files)].sort();
      // Still compare descriptions against the base when git can name one; without it every
      // given SKILL.md / command counts as a description change.
      try { mergeBase = git(a.root, ['merge-base', a.base, 'HEAD']).trim(); } catch { mergeBase = null; }
    } else ({ mergeBase, files: changed } = changedFiles(a.root, a.base));
  } catch (e) {
    console.error(`affected: git lookup against "${a.base}" failed: ${(e.stderr || e.message).toString().trim()}`);
    return 2;
  }
  const r = select({ root: a.root, changed, mergeBase, all: a.all });
  r.base = a.files ? null : a.base; r.mergeBase = mergeBase;
  const header = a.all ? 'Everything selected (--all).'
    : a.files ? `${changed.length} changed file(s), given with --files.`
      : `${changed.length} changed file(s) since ${a.base} (merge-base ${mergeBase.slice(0, 7)}).`;

  if (!a.run) { if (a.json) console.log(JSON.stringify(r)); else print(r, header); return 0; }

  if (!a.json) print(r, header);
  const started = Date.now();
  r.results = await runTests(a.root, r.tests.selected);
  const failed = r.results.filter((x) => x.exit !== 0);
  if (a.json) console.log(JSON.stringify({ ...r, results: r.results.map(({ test, exit }) => ({ test, exit })) }));
  else {
    failed.forEach((x) => console.log(`\nFAIL node ${x.test} (exit ${x.exit})\n${x.tail}`));
    console.log(`\n${r.results.length - failed.length} passed, ${failed.length} failed — ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return failed.length ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { select, makeGraph, IMPACT_ROOTS };
