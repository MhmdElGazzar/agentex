'use strict';
// Host-build guards — checks a finished host tree must pass before anything is
// published. Each guard returns findings ({ guard, path?, message }); any finding fails
// the build. Guards only read the tree; they never fix it.
const T = require('./transforms.js');

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Every folder directly under skills/ is a skill: it has a SKILL.md whose frontmatter
// carries a name and a description within the host's limits.
function skills(files, params) {
  const out = [];
  const dirs = new Set([...files.keys()]
    .map((p) => p.match(/^skills\/([^/]+)\//)).filter(Boolean).map((m) => m[1]));
  for (const dir of [...dirs].sort()) {
    const p = `skills/${dir}/SKILL.md`;
    const file = files.get(p);
    if (!file) { out.push({ path: `skills/${dir}/`, message: 'skill folder has no SKILL.md' }); continue; }
    const { data } = T.parseFrontmatter(T.text(file));
    if (!data) { out.push({ path: p, message: 'no frontmatter' }); continue; }
    if (!data.name) out.push({ path: p, message: 'frontmatter has no name' });
    else {
      if (!NAME_RE.test(data.name)) out.push({ path: p, message: `name "${data.name}" is not lowercase-hyphenated` });
      if (params.nameMax && data.name.length > params.nameMax) out.push({ path: p, message: `name is ${data.name.length} chars (max ${params.nameMax})` });
      if (params.nameMatchesFolder && data.name !== dir) out.push({ path: p, message: `name "${data.name}" does not match its folder "${dir}"` });
    }
    if (!data.description) out.push({ path: p, message: 'frontmatter has no description' });
    else if (params.descriptionMax && data.description.length > params.descriptionMax) {
      out.push({ path: p, message: `description is ${data.description.length} chars (max ${params.descriptionMax})` });
    }
  }
  return out;
}

// Text that must not survive a conversion, e.g. `${CLAUDE_PLUGIN_ROOT}` on a host
// that never expands it. params: [{ pattern, why?, paths? }] — `paths` limits the check
// to matching files (default: every text file).
function forbiddenText(files, params) {
  const out = [];
  for (const { pattern, why, paths } of params) {
    const re = new RegExp(pattern);
    const inScope = paths ? T.matcher(paths) : () => true;
    for (const [p, file] of files) {
      if (inScope(p) && T.isText(file) && re.test(T.text(file))) out.push({ path: p, message: `contains ${pattern}${why ? ` (${why})` : ''}` });
    }
  }
  return out;
}

// Paths a store rejects outright. params: [patterns].
function forbiddenPaths(files, params) {
  const hit = T.matcher(params);
  return [...files.keys()].filter(hit).map((p) => ({ path: p, message: 'path not allowed on this host' }));
}

function maxFiles(files, params) {
  return files.size > params
    ? [{ message: `tree has ${files.size} files; the limit is ${params}` }] : [];
}

// The host manifest exists, is JSON, and carries the required fields.
// params: { path, required: [field] }.
function manifest(files, params) {
  const file = files.get(params.path);
  if (!file) return [{ path: params.path, message: 'manifest missing' }];
  let data;
  try { data = JSON.parse(T.text(file)); } catch (e) { return [{ path: params.path, message: `manifest is not JSON: ${e.message}` }]; }
  return (params.required || []).filter((k) => data[k] === undefined || data[k] === '')
    .map((k) => ({ path: params.path, message: `manifest has no "${k}"` }));
}

const GUARDS = { skills, forbiddenText, forbiddenPaths, maxFiles, manifest };

function runGuards(files, config) {
  const findings = [];
  for (const [name, params] of Object.entries(config || {})) {
    const fn = GUARDS[name];
    if (!fn) throw new Error(`unknown guard: ${name}`);
    for (const f of fn(files, params)) findings.push({ guard: name, ...f });
  }
  return findings;
}

module.exports = { GUARDS, runGuards };
