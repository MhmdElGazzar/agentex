'use strict';
// Host-build transforms — pure functions over an in-memory plugin tree.
//
// A tree is a Map<path, File>, File = { mode, sha, buf }. `sha` is the source blob id
// while the content is untouched; anything that rewrites a file sets `buf` and clears
// `sha`, so the builder knows which blobs to write. Every transform takes
// (files, params, ctx) and mutates `files`; ctx = { host, version, label }.
//
// Transforms never guess: input they cannot convert (a command with no description,
// a name collision they can't resolve) throws, and the host build fails instead of
// shipping a half-converted plugin.

const ROOT_TOKEN = '<agentex-root>';
const CLAUDE_ROOT = '${CLAUDE_PLUGIN_ROOT}';

function makeFile(content, mode = '100644') {
  return { mode, sha: null, buf: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') };
}
function isText(file) {
  return file.mode !== '120000' && !file.buf.subarray(0, 8000).includes(0);
}
function text(file) {
  return file.buf.toString('utf8');
}
function setText(file, content) {
  file.buf = Buffer.from(content, 'utf8');
  file.sha = null;
}

// ---- path patterns ------------------------------------------------------------------
// A pattern without `*` matches that exact path or anything below it (`evals` matches
// `evals/a/b.md`). With `*`: `*` stays inside one segment, `**/` spans any depth.
function patternToRegExp(pattern) {
  const p = pattern.replace(/\/+$/, '');
  if (!p.includes('*')) {
    const lit = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${lit}(?:/.*)?$`);
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    if (p.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; }
    else if (p.startsWith('**', i)) { re += '.*'; i += 1; }
    else if (p[i] === '*') re += '[^/]*';
    else re += p[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function matcher(patterns) {
  const res = (patterns || []).map(patternToRegExp);
  return (path) => res.some((r) => r.test(path));
}

// ---- frontmatter ----------------------------------------------------------------------
// Just enough YAML for SKILL.md / agent / command headers: `key: value`, single- and
// double-quoted values, and `>` / `|` block scalars. Unknown shapes keep their raw text.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, body: content };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*?)\s*$/);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[>|][+-]?$/.test(val)) {
      const folded = val[0] === '>';
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].trim());
      }
      val = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^".*"$/.test(val)) {
      try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
    } else if (/^'.*'$/.test(val)) {
      val = val.slice(1, -1).replace(/''/g, "'");
    }
    data[key] = val;
  }
  return { data, body: content.slice(m[0].length) };
}
// Identifier-like strings stay bare; anything else is JSON-quoted, which is a valid YAML
// double-quoted scalar, so values round-trip.
function renderFrontmatter(data) {
  const scalar = (v) => (typeof v !== 'string' ? String(v) : /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) ? v : JSON.stringify(v));
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${scalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// ---- transforms -----------------------------------------------------------------------

// Write the host's plugin manifest from the Claude one. params: { source, target,
// pick?: [fields], fields?: {extra}, removeSource?: bool }. Without `pick` every source
// field is kept; `$schema` is dropped unless `fields` sets one.
function manifest(files, params) {
  const source = params.source || '.claude-plugin/plugin.json';
  const src = files.get(source);
  if (!src) throw new Error(`manifest: ${source} not found`);
  const data = JSON.parse(text(src));
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === '$schema') continue;
    if (params.pick && !params.pick.includes(k)) continue;
    out[k] = v;
  }
  Object.assign(out, params.fields || {});
  if (params.removeSource && params.target !== source) files.delete(source);
  files.set(params.target, makeFile(`${JSON.stringify(out, null, 2)}\n`));
}

// `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code only. mode "placeholder" swaps it
// for `<agentex-root>` — a literal the shell cannot silently expand to an empty string —
// and the `preamble` transform tells the model what it stands for.
function pluginRoot(files, params) {
  if ((params.mode || 'placeholder') === 'keep') return;
  const token = params.token || ROOT_TOKEN;
  for (const file of files.values()) {
    if (!isText(file)) continue;
    const t = text(file);
    if (t.includes(CLAUDE_ROOT)) setText(file, t.split(CLAUDE_ROOT).join(token));
  }
}

// Slash commands become skills: commands/<n>.md → skills/<n>/SKILL.md, or
// skills/<n>-command/ when a skill of that name exists. `$ARGUMENTS` (substituted by
// Claude Code only) becomes a plain reference to what the user typed.
function commandsToSkills(files) {
  const commands = [...files.keys()].filter((p) => /^commands\/[^/]+\.md$/.test(p)).sort();
  for (const p of commands) {
    const base = p.slice('commands/'.length, -'.md'.length);
    const { data, body } = parseFrontmatter(text(files.get(p)));
    if (!data || !data.description) throw new Error(`commandsToSkills: ${p} has no description`);
    let name = base;
    if ([...files.keys()].some((k) => k.startsWith(`skills/${name}/`))) name = `${base}-command`;
    if ([...files.keys()].some((k) => k.startsWith(`skills/${name}/`))) {
      throw new Error(`commandsToSkills: cannot place ${p}: skills/${base}/ and skills/${name}/ both exist`);
    }
    const newBody = body
      .replace(/`\$ARGUMENTS`/g, 'the arguments')
      .replace(/\$ARGUMENTS/g, "(the arguments the user typed after the command's name)");
    const head = renderFrontmatter({
      name,
      description: data.description,
      'argument-hint': data['argument-hint'],
      'disable-model-invocation': true,
    });
    files.delete(p);
    files.set(`skills/${name}/SKILL.md`, makeFile(head + newBody));
  }
}

// Move bundled agent definitions somewhere a host that cannot load plugin agents
// still ships them as plain files. params: { to }.
function moveAgents(files, params) {
  const to = (params.to || 'references/agents').replace(/\/+$/, '');
  for (const p of [...files.keys()].filter((k) => /^agents\/[^/]+\.md$/.test(k))) {
    files.set(`${to}/${p.slice('agents/'.length)}`, files.get(p));
    files.delete(p);
  }
}

// Claude's structured question tool → the host's equivalent, in prose. params:
// { replacement } — the phrase that replaces `AskUserQuestion` (with or without backticks).
function askUser(files, params) {
  if (!params.replacement) throw new Error('askUser: replacement is required');
  for (const file of files.values()) {
    if (!isText(file)) continue;
    const t = text(file);
    if (!t.includes('AskUserQuestion')) continue;
    setText(file, t.replace(/`AskUserQuestion`|AskUserQuestion/g, params.replacement));
  }
}

// Insert a host note right after the frontmatter of every matching file. `{root}` in the
// text becomes the relative path from that file's folder to the plugin root.
function preamble(files, params, ctx) {
  const isTarget = matcher(params.targets || ['skills/*/SKILL.md']);
  for (const [p, file] of files) {
    if (!isTarget(p) || !isText(file)) continue;
    const depth = p.split('/').length - 1;
    const root = depth === 0 ? '.' : Array(depth).fill('..').join('/');
    const note = params.text.replace(/\{root\}/g, root).replace(/\{host\}/g, ctx.label || ctx.host);
    const t = text(file);
    const fm = t.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    const head = fm ? fm[0] : '';
    setText(file, `${head}\n${note.trimEnd()}\n\n${t.slice(head.length).replace(/^\n+/, '')}`);
  }
}

const TRANSFORMS = { manifest, pluginRoot, commandsToSkills, moveAgents, askUser, preamble };

function applyTransforms(files, list, ctx) {
  for (const entry of list || []) {
    const [name, params = {}] = Array.isArray(entry) ? entry : [entry, {}];
    const fn = TRANSFORMS[name];
    if (!fn) throw new Error(`unknown transform: ${name}`);
    fn(files, params, ctx);
  }
}

module.exports = {
  TRANSFORMS, applyTransforms, makeFile, isText, text, setText,
  matcher, patternToRegExp, parseFrontmatter, renderFrontmatter, ROOT_TOKEN, CLAUDE_ROOT,
};
