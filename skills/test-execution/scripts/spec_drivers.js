'use strict';
// AgenTeX spec drivers — which drivers a set of test specs needs, so a run (and the CI
// preflight) only demands the tools those drivers use. An API-only spec needs no browser.
//
// Usage: node spec_drivers.js <spec file | folder>... | --all      (run from the project root)
// Prints ONE JSON line: {"drivers":["api","browser"],"perSpec":{"test/a.md":["api","browser"]},"unreadable":[]}
// Exit: 0 = resolved, 2 = usage error (no paths, or a named path does not exist).
//
// Rules, per spec:
//   1. An optional header line `Drivers: api, db` (before the first `## ` heading) is authoritative.
//   2. Without it: `browser` (unprefixed prose steps have always been browser steps), plus every
//      step prefix found: `api:` `db:` `kb:` `ui-check:` — as a list item, `2. api:`, or `Step 4: api:`.
//   3. `ui-check` needs a live page, so it always adds `browser`.
//   4. An unreadable spec resolves to `browser` (the strictest checks) and is listed in `unreadable`.
// Folders are walked recursively for *.md; README.md files and anything under .auth/ are skipped.
const fs = require('node:fs');
const path = require('node:path');

const KNOWN = ['browser', 'api', 'db', 'kb', 'ui-check'];
const STEP_PREFIX = /^\s*(?:[-*+]\s+|\d+[.)]\s+|step\s*\d+\s*[:.)-]\s*)?(api|db|kb|ui-check)\s*:/gim;

function listSpecs(target) {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(target, e.name);
    if (e.isDirectory()) return e.name === '.auth' ? [] : listSpecs(p);
    return e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md' ? [p] : [];
  });
}

function driversOfText(text) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  const head = clean.split(/^##\s/m)[0];
  const declared = head.match(/^\s*Drivers\s*:\s*(.+)$/im);
  const set = new Set();
  if (declared) {
    for (const d of declared[1].split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) set.add(d);
  } else {
    set.add('browser');
    for (const m of clean.matchAll(STEP_PREFIX)) set.add(m[1].toLowerCase());
  }
  if (set.has('ui-check')) set.add('browser');
  return [...set].sort();
}

function specDrivers(targets, cwd = process.cwd()) {
  const perSpec = {};
  const unreadable = [];
  for (const t of targets) {
    const abs = path.resolve(cwd, t);
    for (const f of listSpecs(abs)) {
      const key = path.relative(cwd, f).split(path.sep).join('/');
      try { perSpec[key] = driversOfText(fs.readFileSync(f, 'utf8')); }
      catch { perSpec[key] = ['browser']; unreadable.push(key); }
    }
  }
  const drivers = [...new Set(Object.values(perSpec).flat())].sort();
  const unknown = drivers.filter((d) => !KNOWN.includes(d));
  return { drivers: drivers.length ? drivers : ['browser'], perSpec, unreadable, ...(unknown.length ? { unknown } : {}) };
}

function main(argv) {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const targets = argv.includes('--all') ? ['test'] : argv;
  if (!targets.length) { out({ error: 'usage: spec_drivers.js <spec file | folder>... | --all' }); return 2; }
  const missing = targets.filter((t) => !fs.existsSync(t));
  if (missing.length) { out({ error: `not found: ${missing.join(', ')}` }); return 2; }
  out(specDrivers(targets));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { specDrivers, driversOfText, KNOWN };
