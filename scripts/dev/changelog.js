#!/usr/bin/env node
'use strict';
// Changelog fragments — a feature adds changelog.d/<slug>.md instead of editing
// CHANGELOG.md, so merges into a moving main never conflict there; the release folds the
// fragments into CHANGELOG.md. Maintainer tooling — never shipped (scripts/hosts/build_host.js
// COMMON_EXCLUDES, which also drops changelog.d).
//
//   node scripts/dev/changelog.js --check
//   node scripts/dev/changelog.js --assemble <X.Y.Z> [--date YYYY-MM-DD] [--dry-run]
//   [--root <dir>]   the folder holding CHANGELOG.md and changelog.d/ (default: the repo root)
//
// A fragment holds only `### Added`, `### Changed` and `### Fixed` sections, each followed by
// `- ` bullets (a bullet's continuation and nested lines are indented). --assemble inserts
// `## [X.Y.Z] — <date>` under the intro, merging an existing `## [Unreleased]` section and
// every fragment (filename order) in the order Added, Changed, Fixed; it then removes the
// `[Unreleased]` heading and deletes the fragment files (changelog.d/.gitkeep stays).
// --dry-run prints the section without writing anything.
//
// Output: exactly ONE JSON line on stdout; a short human summary on stderr.
// Exit 0 ok · 1 a fragment is invalid (the file is named) · 2 usage error, a version that
// already has a section, or nothing to assemble. Read-only except --assemble (no --dry-run).
const fs = require('node:fs');
const path = require('node:path');

const HEADINGS = ['Added', 'Changed', 'Fixed'];
const USAGE = 'usage: changelog.js (--check | --assemble <X.Y.Z> [--date YYYY-MM-DD] [--dry-run]) [--root <dir>]';

function emit(result, code, human) {
  console.log(JSON.stringify(result));
  if (human) console.error(human);
  return code;
}
const lines = (text) => text.split(/\r?\n/);
const trimBlank = (ls) => {
  let a = 0; let b = ls.length;
  while (a < b && ls[a].trim() === '') a++;
  while (b > a && ls[b - 1].trim() === '') b--;
  return ls.slice(a, b);
};

// Splits lines at `### ` headings: text before the first one, then [{ name, body }].
function sections(ls) {
  const pre = []; const out = [];
  for (const l of ls) {
    const m = l.match(/^###[ \t]+(.*?)\s*$/);
    if (m) out.push({ name: m[1], body: [] });
    else (out.length ? out[out.length - 1].body : pre).push(l);
  }
  return { pre, sections: out.map((s) => ({ name: s.name, body: trimBlank(s.body) })) };
}

// Errors for one fragment's text; empty when valid.
function validate(text) {
  const errors = [];
  const { pre, sections: secs } = sections(lines(text));
  if (pre.some((l) => l.trim() !== '')) errors.push('text before the first ### heading');
  if (!secs.length) errors.push('no ### Added / ### Changed / ### Fixed section');
  for (const s of secs) {
    if (!HEADINGS.includes(s.name)) { errors.push(`heading "### ${s.name}" is not one of ### ${HEADINGS.join(', ### ')}`); continue; }
    if (!s.body.length || !s.body[0].startsWith('- ')) errors.push(`"### ${s.name}" is not followed by "- " bullets`);
    s.body.forEach((l) => {
      if (/^##(?!#)/.test(l)) errors.push(`"## " heading inside "### ${s.name}"`);
      else if (l.trim() !== '' && !/^\s/.test(l) && !l.startsWith('- ')) errors.push(`line under "### ${s.name}" is neither a "- " bullet nor indented: ${l.slice(0, 40)}`);
    });
  }
  return errors;
}

function readFragments(root) {
  const dir = path.join(root, 'changelog.d');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ file: `changelog.d/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function parseArgs(argv) {
  const a = { mode: null, version: null, date: null, dryRun: false, root: path.resolve(__dirname, '..', '..') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--check' || k === '--assemble') {
      if (a.mode) throw new Error('give one of --check or --assemble');
      a.mode = k.slice(2);
      if (k === '--assemble') {
        a.version = argv[++i];
        if (a.version === undefined) throw new Error('--assemble needs a version');
      }
    } else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--date' || k === '--root') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      if (k === '--date') a.date = v; else a.root = path.resolve(v);
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.mode) throw new Error('give --check or --assemble <X.Y.Z>');
  if (a.mode === 'assemble') {
    if (!/^\d+\.\d+\.\d+$/.test(a.version)) throw new Error(`"${a.version}" is not a version (X.Y.Z)`);
    if (a.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error(`"${a.date}" is not a date (YYYY-MM-DD)`);
  }
  return a;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function checkFragments(fragments) {
  return fragments.flatMap((f) => validate(f.text).map((error) => ({ file: f.file, error })));
}
const humanErrors = (errors) => errors.map((e) => `${e.file}: ${e.error}`).join('\n');

function assemble(a, fragments) {
  const file = path.join(a.root, 'CHANGELOG.md');
  if (!fs.existsSync(file)) throw Object.assign(new Error(`${file} not found`), { exit2: true });
  const all = lines(fs.readFileSync(file, 'utf8'));
  const isRelease = (l) => /^## \[/.test(l);
  const escaped = a.version.replace(/\./g, '\\.');
  if (all.some((l) => new RegExp(`^## \\[${escaped}\\]`).test(l))) {
    throw Object.assign(new Error(`CHANGELOG.md already has a section for ${a.version}`), { exit2: true });
  }

  // Take the [Unreleased] section out, wherever it is.
  const u = all.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  let unreleased = [];
  let rest = all;
  if (u !== -1) {
    let end = u + 1;
    while (end < all.length && !isRelease(all[end])) end++;
    unreleased = all.slice(u + 1, end);
    rest = [...all.slice(0, u), ...all.slice(end)];
  }
  const parsedU = sections(unreleased);
  if (parsedU.pre.some((l) => l.trim() !== '')) {
    throw Object.assign(new Error('[Unreleased] has text outside a ### subsection; move it under one first'), { exit2: true });
  }

  // Merge: Unreleased first, then each fragment in filename order.
  const merged = new Map();
  const add = (name, body) => {
    if (!body.length) return;
    if (!merged.has(name)) merged.set(name, []);
    merged.get(name).push(...body);
  };
  parsedU.sections.forEach((s) => add(s.name, s.body));
  fragments.forEach((f) => sections(lines(f.text)).sections.forEach((s) => add(s.name, s.body)));
  if (!merged.size) throw Object.assign(new Error('nothing to assemble: no fragments and no [Unreleased] content'), { exit2: true });

  const names = [...HEADINGS.filter((h) => merged.has(h)), ...[...merged.keys()].filter((n) => !HEADINGS.includes(n))];
  const date = a.date || today();
  const section = [`## [${a.version}] — ${date}`, ...names.flatMap((n) => [`### ${n}`, ...merged.get(n)])].join('\n');

  const at = rest.findIndex(isRelease);
  const head = trimBlank(at === -1 ? rest : rest.slice(0, at));
  const tail = at === -1 ? [] : rest.slice(at);
  const text = `${[...head, '', section, ...(tail.length ? ['', ...tail] : [])].join('\n').replace(/\n*$/, '')}\n`;
  return { section, text, date, file };
}

function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return emit({ ok: false, error: e.message }, 2, `changelog: ${e.message}\n${USAGE}`); }
  const fragments = readFragments(a.root);
  const errors = checkFragments(fragments);
  if (errors.length) return emit({ ok: false, mode: a.mode, errors }, 1, `changelog: invalid fragment(s)\n${humanErrors(errors)}`);
  const files = fragments.map((f) => f.file);
  if (a.mode === 'check') return emit({ ok: true, mode: 'check', files }, 0, `changelog: ${files.length} fragment(s) valid`);

  let built;
  try { built = assemble(a, fragments); } catch (e) {
    if (e.exit2) return emit({ ok: false, mode: 'assemble', error: e.message }, 2, `changelog: ${e.message}`);
    throw e;
  }
  const result = { ok: true, mode: 'assemble', version: a.version, date: built.date, dryRun: a.dryRun, files, section: built.section };
  if (a.dryRun) return emit(result, 0, `changelog: dry run, nothing written (${files.length} fragment(s))`);
  const tmp = `${built.file}.tmp`;
  fs.writeFileSync(tmp, built.text);
  fs.renameSync(tmp, built.file);
  files.forEach((f) => fs.rmSync(path.join(a.root, f)));
  return emit(result, 0, `changelog: ${a.version} assembled from ${files.length} fragment(s)`);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validate, sections };
