#!/usr/bin/env node
'use strict';
// AgenTeX structural lint — the mechanical half of a feature's QA gate, run on the plugin
// repo itself (plugin-tester's check A consumes the JSON).
//
//   node scripts/lint_plugin.js [--root <dir>] [--json]
//
//   --root  the plugin repo to scan (default: the repo this script lives in)
//   --json  print only the JSON line (no human summary on stderr)
//
// Files: what git tracks under --root (`git ls-files`; `git add` a new file before it is
// seen); outside a git repo, every file except .git/ and node_modules/. One walk, every
// check reads from it.
//
// Errors (exit 1):
//   frontmatter  every skills/*/SKILL.md, commands/*.md, agents/*.md has a frontmatter block
//                that parses, the keys its surface needs, and no plain scalar a YAML parser
//                would misread (an unquoted ": " — the 0.12.0 invisible-skill bug — or " #").
//   paths        every plugin path those files and references/**/*.md name in backticks,
//                in a fenced block via ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_SKILL_DIR}, or as a
//                link target, exists. URLs, placeholders, globs and consumer-project paths
//                (CONSUMER_DIRS) are skipped; a skill-local path (references/x.md) resolves
//                against the naming skill, the repo root, the file's folder, then any skill
//                ("the ask-kb skill's `references/kb-ask-api.md`").
//   version      .claude-plugin/plugin.json version = the README version badge (and the
//                marketplace entry, when .claude-plugin/marketplace.json exists).
//   env          every process.env.X read in scripts/** and skills/*/scripts/** (non-test)
//                is a name in .env.example (a KEY= line, or a name in its comments), unless
//                listed in RUNTIME_ENV / INTERNAL_ENV below.
//   secrets      a secret-shaped value (private-key block, GitHub, AWS, Atlassian token) in
//                any file. Tests build such values at runtime from parts, so they never match.
//   denylist     a term from the optional, gitignored .agentex-lint-denylist (one term per
//                line, # comments) anywhere, case-insensitive. The term is never printed.
// Warnings (reported, exit 0):
//   changelog    CHANGELOG.md's top released section differs from plugin.json (an
//                [Unreleased] section on top is fine).
//   tests        a script under scripts/ (not scripts/dev/) or skills/*/scripts/ with no
//                sibling <name>.test.js or <name>.<anything>.test.js (test fixtures —
//                golden/, fixtures/, *.fixture.js — are not scripts).
//
// Output: exactly ONE JSON line on stdout —
//   {ok, errors:[{check,file,line,message}], warnings:[...], checks:{<check>:{errors,warnings}}}
// — and a human summary on stderr. Exit 0 ok/warnings only · 1 any error · 2 could not run
// ({ok:false, error}). Read-only. Never prints a secret value or a denylist term.
// Maintainer tooling: never shipped by any host (scripts/hosts/build_host.js COMMON_EXCLUDES).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseFrontmatter } = require('./hosts/transforms.js');

const USAGE = 'usage: lint_plugin.js [--root <dir>] [--json]';
const CHECKS = ['frontmatter', 'paths', 'version', 'env', 'secrets', 'denylist', 'changelog', 'tests'];
const DENYLIST_FILE = '.agentex-lint-denylist';
const MAX_BYTES = 2 * 1024 * 1024;

// Paths that live in the consumer's project (where the plugin runs), not in this repo — a
// skill naming them is describing the user's tree. Never checked, even when this repo has a
// folder of the same name (test/, executions/).
const CONSUMER_DIRS = new Set(['config', 'environments', 'executions', 'test', 'integration', 'bugs', '.agentex',
  '.playwright-cli', 'mobile-sessions', 'browser-sessions', 'logs', 'screenshots', '.auth', 'node_modules', '.claude',
  '.env', 'specs', '.github', '.git']);
// Folders inside a skill that a SKILL.md names relative to itself.
const SKILL_LOCAL_DIRS = ['scripts', 'references', 'templates', 'assets', 'agents'];

// Environment variables a script may read without a .env.example key. Every entry has a reason.
const RUNTIME_ENV = new Set([
  // set by the OS, the shell or CI
  'CI', 'HOME', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SHELL', 'TERM', 'LANG',
  'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR', 'GITHUB_ACTIONS',
  // set by Claude Code
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SKILL_DIR',
  // Playwright's own switches (browser cache, channel, headed mode) — tool settings, not secrets
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_CHANNEL', 'HEADED',
]);
const INTERNAL_ENV = new Set([
  // set by ci_gate.js for the run it spawns (the CI handshake), never by the user
  'AGENTEX_CI', 'AGENTEX_VERDICT_PATH', 'AGENTEX_CI_POLICY',
  // test seams: a script's tests point it at a fake (probe command, retry delay, API base)
  'AGENTEX_CI_RETRY_DELAY_MS', 'AGENTEX_PWCLI_PROBE_CMD', 'AGENTEX_SQLCMD_PROBE_CMD', 'FIGMA_API_BASE',
]);

// Secret shapes. Written so this file's own source never matches them.
const SECRET_SHAPES = [
  { name: 'a private-key block', re: /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}/ },
  { name: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'an AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'an Atlassian API token', re: /\bATATT3[A-Za-z0-9_=-]{20,}/ },
];

// ---- args / output ------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { root: path.resolve(__dirname, '..'), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return null;
      o.root = path.resolve(v);
    } else return null;
  }
  return o;
}
function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exitCode = 2;
}

// ---- the walk -------------------------------------------------------------------------------
function listFiles(root) {
  let rels = null;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    rels = out.split('\0').filter(Boolean);
  } catch { /* not a git repo (or no git): walk */ }
  if (rels === null) {
    rels = [];
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r); else if (e.isFile()) rels.push(r);
      }
    })('');
  }
  return rels.filter((r) => {
    try { return fs.lstatSync(path.join(root, r)).isFile(); } catch { return false; }
  }).sort();
}
function makeReader(root) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) {
      let t = null;
      try {
        const buf = fs.readFileSync(path.join(root, rel));
        if (buf.length <= MAX_BYTES && !buf.subarray(0, 8192).includes(0)) t = buf.toString('utf8');
      } catch { /* unreadable: skipped */ }
      cache.set(rel, t);
    }
    return cache.get(rel);
  };
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---- 1. frontmatter -------------------------------------------------------------------------
const REQUIRED = [
  { re: /^skills\/[^/]+\/SKILL\.md$/, keys: ['name', 'description'] },
  { re: /^commands\/[^/]+\.md$/, keys: ['description'] },
  { re: /^agents\/[^/]+\.md$/, keys: ['name', 'description'] },
];
function checkFrontmatter(rel, text, err) {
  const req = REQUIRED.find((r) => r.re.test(rel));
  if (!req) return;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return err(rel, 1, 'no frontmatter block (--- ... --- at the top of the file)');
  const lines = m[1].split(/\r?\n/);
  const seen = new Set();
  let mode = 'top';   // top · block (inside > or |) · nested (after `key:` with no value) · plain (multi-line plain scalar)
  let key = null;
  const plainProblem = (s) => (/:(?:\s|$)/.test(s) ? 'an unquoted ": "' : /\s#/.test(s) ? 'an unquoted " #" (the rest is read as a comment)' : null);
  lines.forEach((raw, i) => {
    const line = i + 2;
    if (raw.trim() === '' || /^\s*#/.test(raw)) return;
    if (/^\s/.test(raw)) {
      if (mode === 'top') return err(rel, line, `indented line with no key above it: frontmatter does not parse`);
      if (mode === 'plain') {
        const p = plainProblem(raw.trim());
        if (p) err(rel, line, `"${key}" has ${p} in its plain (unquoted) value — quote the value or use "${key}: >"`);
      }
      return;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):(?:[ \t]+(.*?))?\s*$/);
    if (!kv) { mode = 'top'; return err(rel, line, 'line is not "key: value": frontmatter does not parse'); }
    key = kv[1];
    const val = kv[2] || '';
    if (seen.has(key)) err(rel, line, `duplicate key "${key}"`);
    seen.add(key);
    if (val === '') { mode = 'nested'; return; }
    if (/^[>|][0-9+-]*$/.test(val)) { mode = 'block'; return; }
    mode = 'top';
    if (val[0] === '"') {
      if (!/^"(?:[^"\\]|\\.)*"(?:\s+#.*)?$/.test(val)) err(rel, line, `"${key}" has an unclosed or malformed double-quoted value`);
      return;
    }
    if (val[0] === "'") {
      if (!/^'(?:[^']|'')*'(?:\s+#.*)?$/.test(val)) err(rel, line, `"${key}" has an unclosed or malformed single-quoted value`);
      return;
    }
    if (val[0] === '[' || val[0] === '{') {
      if (!/^(\[.*\]|\{.*\})$/.test(val)) err(rel, line, `"${key}" has an unclosed flow collection`);
      return;
    }
    if (/^[@`%&*!]/.test(val)) return err(rel, line, `"${key}" starts with the reserved YAML character "${val[0]}" — quote the value`);
    const p = plainProblem(val);
    if (p) return err(rel, line, `"${key}" has ${p} in its plain (unquoted) value — quote the value or use "${key}: >"`);
    mode = 'plain';
  });
  const { data } = parseFrontmatter(text);
  for (const k of req.keys) {
    if (!data || typeof data[k] !== 'string' || data[k].trim() === '') err(rel, 1, `frontmatter has no "${k}" (required for ${rel.split('/')[0]})`);
  }
}

// ---- 2. referenced paths --------------------------------------------------------------------
const PATH_SOURCES = /^(?:skills\/[^/]+\/SKILL\.md|commands\/[^/]+\.md|agents\/[^/]+\.md|references\/.+\.md|skills\/[^/]+\/references\/.+\.md)$/;
const ROOT_VARS = [/^\$\{?CLAUDE_PLUGIN_ROOT\}?\//, /^\$\{?CLAUDE_SKILL_DIR\}?\//];
const PLACEHOLDER = /[<>{}*?[\]…$|=()\\]|\.\.\.|^-/;

function makePathChecker(root, files) {
  const fileSet = new Set(files);
  const dirSet = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  const exists = (rel) => rel !== null && (fileSet.has(rel) || dirSet.has(rel) || fs.existsSync(path.join(root, rel)));
  const skillDirs = [...dirSet].filter((d) => /^skills\/[^/]+$/.test(d));
  const topDirs = new Set([...dirSet].filter((d) => !d.includes('/')).filter((d) => !CONSUMER_DIRS.has(d)));
  const join = (base, p) => {
    const j = path.posix.normalize(path.posix.join(base, p)).replace(/\/$/, '');
    return j.startsWith('..') ? null : (j === '.' ? '' : j);
  };
  return function check(rel, text, err) {
    const dir = path.posix.dirname(rel);
    const skill = (rel.match(/^skills\/[^/]+/) || [])[0] || null;
    // Returns a finding message, or null when the token is fine or not a plugin path.
    function verify(token, { fenced }) {
      let t = token.replace(/^["'(]+/, '').replace(/[,;:)"'.]+$/, '');
      if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;   // URL / scheme
      let bases;
      if (ROOT_VARS[0].test(t)) { bases = ['']; t = t.replace(ROOT_VARS[0], ''); }
      else if (ROOT_VARS[1].test(t)) { if (!skill) return null; bases = [skill]; t = t.replace(ROOT_VARS[1], ''); }
      else if (fenced) return null;
      else if (t.startsWith('../')) bases = [dir];
      else {
        t = t.replace(/^\.\//, '');
        if (!t.includes('/')) return null;
        const first = t.split('/')[0];
        if (CONSUMER_DIRS.has(first)) return null;
        if (!topDirs.has(first) && !(skill && SKILL_LOCAL_DIRS.includes(first))) return null;
        bases = [skill, '', dir].filter((b) => b !== null);
        // "the ask-kb skill's `references/kb-ask-api.md`": a skill-local path named from
        // outside that skill counts when some skill has it.
        if (SKILL_LOCAL_DIRS.includes(first)) bases.push(...skillDirs);
      }
      if (!t || PLACEHOLDER.test(t)) return null;
      if (bases.some((b) => exists(join(b, t)))) return null;
      return `\`${token}\` does not exist in the plugin`;
    }
    function verifyLink(target) {
      let t = target.replace(/^<|>$/g, '');
      if (!t || t.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
      t = t.replace(/[#?].*$/, '');
      if (!t || PLACEHOLDER.test(t)) return null;
      const r = t.startsWith('/') ? join('', t.slice(1)) : join(dir, t);
      return exists(r) ? null : `link target \`${target}\` does not exist`;
    }
    let fence = null;
    text.split('\n').forEach((raw, i) => {
      const line = i + 1;
      const f = raw.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        return;
      }
      const found = [];
      if (fence) {
        for (const m of raw.matchAll(/\S+/g)) found.push([m.index, verify(m[0], { fenced: true })]);
      } else {
        for (const m of raw.matchAll(/`([^`]+)`/g)) {
          for (const w of m[1].matchAll(/\S+/g)) found.push([m.index + 1 + w.index, verify(w[0], { fenced: false })]);
        }
        const prose = raw.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
        for (const m of prose.matchAll(/\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) found.push([m.index, verifyLink(m[1])]);
      }
      found.sort((a, b) => a[0] - b[0]).forEach(([, msg]) => { if (msg) err(rel, line, msg); });
    });
  };
}

// ---- 3. version / 6. changelog --------------------------------------------------------------
function checkVersions(root, files, read, err, warn) {
  const manifestRel = '.claude-plugin/plugin.json';
  let manifest;
  try { manifest = JSON.parse(read(manifestRel)); } catch { return err('version', manifestRel, 1, 'plugin.json does not parse as JSON'); }
  const version = manifest && manifest.version;
  if (typeof version !== 'string' || !version) return err('version', manifestRel, 1, 'plugin.json has no "version"');

  const readme = files.includes('README.md') ? read('README.md') : null;
  if (readme === null) err('version', 'README.md', null, 'no README.md to carry the version badge');
  else {
    const m = readme.match(/img\.shields\.io\/badge\/version-([^-\s)]+)-/i);
    if (!m) err('version', 'README.md', null, `no version badge (img.shields.io/badge/version-<x>-...) in README.md; plugin.json says ${version}`);
    else if (m[1] !== version) err('version', 'README.md', lineOf(readme, m.index), `README badge says ${m[1]}, plugin.json says ${version}`);
  }

  const marketRel = '.claude-plugin/marketplace.json';
  if (files.includes(marketRel)) {
    let market = null;
    try { market = JSON.parse(read(marketRel)); } catch { err('version', marketRel, 1, 'marketplace.json does not parse as JSON'); }
    const entry = market && Array.isArray(market.plugins) ? market.plugins.find((p) => p && p.name === manifest.name) : null;
    if (entry && entry.version !== undefined && entry.version !== version) {
      err('version', marketRel, 1, `marketplace entry "${manifest.name}" says ${entry.version}, plugin.json says ${version}`);
    }
  }

  const log = files.includes('CHANGELOG.md') ? read('CHANGELOG.md') : null;
  if (log !== null) {
    const top = [...log.matchAll(/^##\s+\[?v?([^\]\s]+)\]?/gm)].find((m) => !/^unreleased$/i.test(m[1]));
    if (top && top[1] !== version) warn('changelog', 'CHANGELOG.md', lineOf(log, top.index), `top released section is ${top[1]}, plugin.json says ${version}`);
  }
}

// ---- 4. env ---------------------------------------------------------------------------------
const SCRIPT_RE = /^(?:scripts\/.+|skills\/[^/]+\/scripts\/.+)\.[cm]?js$/;
const isTestFile = (rel) => /\.test\.[cm]?js$/.test(rel);
function documentedEnv(text) {
  const names = new Set();
  for (const line of (text || '').split(/\r?\n/)) {
    const kv = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (kv) names.add(kv[1]);
    if (/^\s*#/.test(line)) for (const m of line.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) names.add(m[0]);
  }
  return names;
}
function checkEnv(rel, text, documented, err) {
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return;
    const names = [];
    for (const m of raw.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g)) names.push(m[1] || m[2]);
    for (const m of raw.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (n) names.push(n[1]);
      }
    }
    for (const n of [...new Set(names)]) {
      if (!documented.has(n) && !RUNTIME_ENV.has(n) && !INTERNAL_ENV.has(n)) {
        err(rel, i + 1, `process.env.${n} is read but .env.example has no ${n} key (add it, or allowlist it in lint_plugin.js with a reason)`);
      }
    }
  });
}

// ---- 5. secrets + denylist ------------------------------------------------------------------
function readDenylist(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, DENYLIST_FILE), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
}
function checkSecrets(rel, text, terms, err) {
  text.split('\n').forEach((raw, i) => {
    for (const s of SECRET_SHAPES) if (s.re.test(raw)) err('secrets', rel, i + 1, `${s.name} shape (value not shown) — build test values at runtime from parts`);
    if (terms.length) {
      const low = raw.toLowerCase();
      terms.forEach((t, n) => { if (low.includes(t)) err('denylist', rel, i + 1, `denylisted term #${n + 1} of ${DENYLIST_FILE} (term not shown)`); });
    }
  });
}

// ---- 7. sibling tests -----------------------------------------------------------------------
function checkTests(files, warn) {
  const set = new Set(files);
  for (const rel of files) {
    if (!SCRIPT_RE.test(rel) || isTestFile(rel) || rel.startsWith('scripts/dev/')) continue;
    if (/(^|\/)(golden|fixtures)\//.test(rel) || /\.fixture\.[cm]?js$/.test(rel)) continue;   // test data, not scripts
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel).replace(/\.[cm]?js$/, '');
    const prefix = `${dir}/${base}.`;
    const tested = set.has(`${prefix}test.js`) || files.some((f) => f.startsWith(prefix) && isTestFile(f) && path.posix.dirname(f) === dir);
    if (!tested) warn('tests', rel, null, `no sibling ${base}.test.js`);
  }
}

// ---- main -----------------------------------------------------------------------------------
function lint(root) {
  const errors = []; const warnings = [];
  const err = (check, file, line, message) => errors.push({ check, file, line, message });
  const warn = (check, file, line, message) => warnings.push({ check, file, line, message });
  const files = listFiles(root);
  const read = makeReader(root);
  const checkPaths = makePathChecker(root, files);
  const documented = documentedEnv(read('.env.example'));
  const terms = readDenylist(root);

  for (const rel of files) {
    const text = read(rel);
    if (text === null) continue;
    checkFrontmatter(rel, text, (f, l, m) => err('frontmatter', f, l, m));
    if (PATH_SOURCES.test(rel)) checkPaths(rel, text, (f, l, m) => err('paths', f, l, m));
    if (SCRIPT_RE.test(rel) && !isTestFile(rel)) checkEnv(rel, text, documented, (f, l, m) => err('env', f, l, m));
    if (rel !== DENYLIST_FILE) checkSecrets(rel, text, terms, err);
  }
  checkVersions(root, files, read, err, warn);
  checkTests(files, warn);

  const order = (a, b) => CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0);
  errors.sort(order); warnings.sort(order);
  const checks = Object.fromEntries(CHECKS.map((c) => [c, {
    errors: errors.filter((f) => f.check === c).length, warnings: warnings.filter((f) => f.check === c).length,
  }]));
  return { ok: errors.length === 0, errors, warnings, checks };
}

function summary(result) {
  const rows = [
    ...result.errors.map((f) => ['error', f]),
    ...result.warnings.map((f) => ['warning', f]),
  ].map(([sev, f]) => `  ${sev.padEnd(7)} ${f.check.padEnd(11)} ${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}`);
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return [...rows, `lint_plugin: ${n(result.errors.length, 'error')}, ${n(result.warnings.length, 'warning')}`].join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) { process.stderr.write(USAGE + '\n'); return fail(USAGE); }
  let st = null;
  try { st = fs.statSync(opts.root); } catch { /* missing */ }
  if (!st || !st.isDirectory()) return fail(`--root is not a directory: ${opts.root}`);
  if (!fs.existsSync(path.join(opts.root, '.claude-plugin', 'plugin.json'))) return fail(`not a plugin root (no .claude-plugin/plugin.json): ${opts.root}`);
  let result;
  try { result = lint(opts.root); } catch (e) { return fail(`could not run: ${e.message}`); }
  if (!opts.json) process.stderr.write(summary(result));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = { lint, CONSUMER_DIRS, RUNTIME_ENV, INTERNAL_ENV };
