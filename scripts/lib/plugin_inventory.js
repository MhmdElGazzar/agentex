'use strict';
// The installed plugin's inventory and fork detection (field-feedback-loop S-1;
// spec appendix A6). Read-only: it lists skill and command names, reads the manifest,
// and scans a project's .claude/skills/ for copies of plugin skills. No process
// spawning, no network, zero npm dependencies.
//
//   skills    skills/*/SKILL.md frontmatter `name` (the folder name when absent)
//   commands  commands/*.md basenames
//   forks     <project>/.claude/skills/*/SKILL.md, symlinks never followed. A project
//             skill is a fork of plugin skill P when
//               (a) its folder name or frontmatter `name` equals P (case-insensitive), or
//               (b) its description, or its first 60 lines, contain
//                   override|overrides|fork of|replaces AND a word-boundaried P or agentex:P.
//             The plugin skill name P is what leaves the machine; the project's folder
//             name and path stay local.
const fs = require('node:fs');
const path = require('node:path');

const FORK_HEAD_LINES = 60;   // tunable default (Q8)
const KEYWORD_RE = /\b(?:overrides?|fork of|replaces)\b/i;

const defaultPluginRoot = () => path.resolve(__dirname, '..', '..');

function readManifest(pluginRoot = defaultPluginRoot()) {
  const file = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('could not read .claude-plugin/plugin.json of the installed plugin'); }
  if (!m || typeof m.version !== 'string' || !m.version) throw new Error('.claude-plugin/plugin.json has no version');
  return { name: m.name, version: m.version, repository: typeof m.repository === 'string' && m.repository ? m.repository : undefined };
}

// Top-level `key: value` pairs of a leading `---` block. `>` and `|` block scalars are
// folded (space) or kept (newline); one pair of surrounding quotes is stripped.
function parseFrontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, raw] = m;
    const block = /^([>|])[+-]?$/.exec(raw.trim());
    if (block) {
      const body = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '') && lines[i + 1] !== '---') body.push(lines[++i].trim());
      out[key] = (block[1] === '>' ? body.join(' ') : body.join('\n')).replace(/\s+$/, '').replace(/^\s+/, '');
      continue;
    }
    let v = raw.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    out[key] = v;
  }
  return out;
}

function loadInventory(pluginRoot = defaultPluginRoot()) {
  const skills = []; const commands = [];
  const skillsDir = path.join(pluginRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = path.join(skillsDir, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      skills.push(parseFrontmatter(fs.readFileSync(file, 'utf8')).name || e.name);
    }
  }
  const cmdDir = path.join(pluginRoot, 'commands');
  if (fs.existsSync(cmdDir)) {
    for (const e of fs.readdirSync(cmdDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) commands.push(e.name.slice(0, -3));
    }
  }
  skills.sort(); commands.sort();
  return { skills, commands, names: new Set([...skills, ...commands]) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(?<![\\w-])(?:agentex:)?${escapeRe(name)}(?![\\w-])`, 'i').test(text);

// -> [{ plugin, rule: 'name'|'self-described', path: '.claude/skills/<folder>/' }]
function detectForks(projectRoot, inventory = loadInventory()) {
  const dir = path.join(projectRoot, '.claude', 'skills');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const forks = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const rel = `.claude/skills/${e.name}/`;
    const byName = inventory.skills.find((p) => p.toLowerCase() === e.name.toLowerCase() || p.toLowerCase() === String(fm.name || '').toLowerCase());
    if (byName) { forks.push({ plugin: byName, rule: 'name', path: rel }); continue; }
    const head = text.split(/\r?\n/).slice(0, FORK_HEAD_LINES).join('\n');
    const hay = `${fm.description || ''}\n${head}`;
    if (!KEYWORD_RE.test(hay)) continue;
    const named = inventory.skills.find((p) => mentions(hay, p));
    if (named) forks.push({ plugin: named, rule: 'self-described', path: rel });
  }
  return forks;
}

module.exports = { defaultPluginRoot, readManifest, parseFrontmatter, loadInventory, detectForks, FORK_HEAD_LINES };
