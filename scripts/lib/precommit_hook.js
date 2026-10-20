'use strict';
// AgenTeX opt-in pre-commit hook — the template, its ownership check, hooks-dir
// resolution, and status() / install() / printScript() / engineLine().
// Used by scripts/precommit_hook.js (/init-test step 6) and by migrate.js's
// --install-pre-commit-hook consent flag (/update-agentex).
//
// The installed hook is STATIC POSIX sh: it never bakes a single plugin path it
// depends on, because ${CLAUDE_PLUGIN_ROOT} changes with every plugin version and
// old version folders are orphaned, then deleted. At commit time an embedded
// resolver picks the newest non-orphaned installed AgenTeX version (baked cache
// parent first, then discovery under the plugins roots, then the baked install
// root) and runs its scripts/secret_scan.js --staged. The hook refuses a commit
// ONLY on exit 1 together with the "result":"LEAK" marker; anything else (Node
// missing, plugin gone, scan error) lets the commit through with a loud line.
//
// Stable contract an installed hook relies on: scripts/secret_scan.js, --staged,
// --project, --hook and the "result":"LEAK" marker. A breaking change bumps
// TEMPLATE_VERSION; an older pristine hook then counts as stale and is refreshed.
//
// Ownership: a marker line plus a sha256 checksum of the body. Only a pristine own
// hook is ever rewritten; an edited one is the user's (foreign) and never touched.
// Every line of the body that is not a comment ends in " #", so a copy whose line
// endings were converted to CRLF (a committed core.hooksPath folder checked out on
// Git for Windows with autocrlf) still runs: each carriage return lands in a comment.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const gp = require('./git_plumbing.js');
const { parseInstallPath } = require('../self_update.js');

const TEMPLATE_VERSION = 1;
const MARKER = 'agentex-pre-commit-hook';
const CHECKSUM_TAG = '# agentex-hook-checksum: ';
const DOCS_REL = ['docs', 'putting-your-project-in-git.md'];

// The embedded resolver (R3.2): prints the absolute path of the newest
// non-orphaned AgenTeX version's scripts/secret_scan.js, or nothing. No single
// quotes (it is single-quoted in sh); wrapped so it prints nothing on any error.
const RESOLVER_LINES = [
  '(function(){try{',
  'var fs=require("fs"),path=require("path"),os=require("os");',
  'var a=process.argv.slice(1),cp=a[0]||"",ir=a[1]||"",e=process.env;',
  'function q(d){try{if(!fs.statSync(path.join(d,"scripts","secret_scan.js")).isFile())return null;',
  'if(fs.existsSync(path.join(d,".orphaned_at")))return null;',
  'var m=JSON.parse(fs.readFileSync(path.join(d,".claude-plugin","plugin.json"),"utf8"));',
  'if(m.name!=="agentex")return null;return{d:d,v:String(m.version||"0"),t:fs.statSync(d).mtimeMs};}catch(x){return null;}}',
  'function ls(p){try{return fs.readdirSync(p).map(function(n){return path.join(p,n);});}catch(x){return [];}}',
  'function c(x,y){var u=x.v.split("."),w=y.v.split(".");for(var i=0;i<Math.max(u.length,w.length);i++){',
  'var d=(parseInt(u[i],10)||0)-(parseInt(w[i],10)||0);if(d)return d;}return x.t-y.t;}',
  'function best(l){l=l.filter(Boolean).sort(c);return l.length?l[l.length-1]:null;}',
  'var p=cp?best(ls(cp).map(q)):null;',
  'if(!p){var roots=[];',
  'if(e.CLAUDE_CODE_PLUGIN_CACHE_DIR)roots.push(path.join(e.CLAUDE_CODE_PLUGIN_CACHE_DIR,"cache"),e.CLAUDE_CODE_PLUGIN_CACHE_DIR);',
  'if(e.CLAUDE_CONFIG_DIR)roots.push(path.join(e.CLAUDE_CONFIG_DIR,"plugins","cache"));',
  'roots.push(path.join(os.homedir(),".claude","plugins","cache"));',
  'var all=[];roots.forEach(function(r){ls(r).forEach(function(mk){ls(mk).forEach(function(pl){all=all.concat(ls(pl).map(q));});});});',
  'p=best(all);}',
  'if(!p&&ir)p=q(ir);',
  'if(p)process.stdout.write(path.join(p.d,"scripts","secret_scan.js"));',
  '}catch(x){}})();',
];
const RESOLVER_JS = RESOLVER_LINES.join('');

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fwd = (p) => String(p || '').replace(/\\/g, '/');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function bodyLines({ projectPrefix, cacheParent, installRoot, nodePath }) {
  return [
    `AGENTEX_PROJECT_PREFIX=${shQuote(fwd(projectPrefix))} #`,
    `AGENTEX_CACHE_PARENT=${shQuote(fwd(cacheParent))} #`,
    `AGENTEX_INSTALL_ROOT=${shQuote(fwd(installRoot))} #`,
    `AGENTEX_NODE=${shQuote(fwd(nodePath))} #`,
    '# git passes no arguments; a manual run may pass --tracked to scan every tracked file',
    'mode=--staged; [ "$1" = "--tracked" ] && mode=--tracked #',
    'if [ "$mode" = --tracked ]; then top=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$top"; fi #',
    'loud() { printf \'%s\\n\' "AgenTeX secret scan did NOT run: $1 - this commit proceeds UNSCANNED." >&2; exit 0; } #',
    'node=$(command -v node 2>/dev/null) #',
    '[ -n "$node" ] || { [ -x "$AGENTEX_NODE" ] && node=$AGENTEX_NODE; } #',
    '[ -n "$node" ] || loud "Node.js was not found" #',
    '# Locate the newest installed, non-orphaned AgenTeX version (it changes with every plugin update).',
    ...RESOLVER_LINES.map((l, k) => `r=${k ? '$r' : ''}${shQuote(l)} #`),
    'scanner=$("$node" -e "$r" -- "$AGENTEX_CACHE_PARENT" "$AGENTEX_INSTALL_ROOT" 2>/dev/null) #',
    '[ -n "$scanner" ] || loud "the AgenTeX plugin was not found (uninstalled or moved)" #',
    '# The scan prints its findings on stderr (shown as-is) and one JSON line on stdout (kept).',
    'out=$("$node" "$scanner" "$mode" --project "$AGENTEX_PROJECT_PREFIX" --hook); rc=$? #',
    'case "$rc:$out" in #',
    '  0:*) exit 0 ;; #',
    '  1:*\'"result":"LEAK"\'*) exit 1 ;; #',
    '  *) loud "the scan stopped with an error (exit $rc)" ;; #',
    'esac #',
  ];
}

// The installed hook: marker, body, checksum of everything above the checksum line.
function renderHook(o) {
  const version = o.version === undefined ? TEMPLATE_VERSION : o.version;
  const body = [
    '#!/bin/sh',
    `# ${MARKER} v${version} - installed by AgenTeX. Edits make AgenTeX treat this file as yours.`,
    '# Runs the AgenTeX secret scan on the content staged for this commit. Turn it off: delete this file.',
    '# A leak refuses the commit; warnings are shown and the commit proceeds; if the scan cannot run,',
    '# the commit proceeds and this hook says so. Docs: putting-your-project-in-git.md in the AgenTeX docs.',
    ...bodyLines(o),
  ].join('\n') + '\n';
  return body + CHECKSUM_TAG + sha256(body) + '\n';
}

// The standalone body for a user's own hook (print): same logic, no ownership marker.
function renderStandalone(o) {
  return [
    '#!/bin/sh',
    '# AgenTeX secret scan - standalone copy for calling from your own pre-commit hook.',
    `# Save it as ${fwd(path.join(o.hooksDir || '<hooks folder>', 'agentex-secret-scan'))} and add this line to your hook:`,
    `#   sh ${shQuote(fwd(path.join(o.hooksDir || '<hooks folder>', 'agentex-secret-scan')))} || exit 1`,
    '# It exits 1 only on a leak; warnings and "did NOT run" exit 0.',
    ...bodyLines(o),
  ].join('\n') + '\n';
}

// Is this file our hook, unmodified? → { version, pristine, baked } | null (not ours at all)
function parseOwn(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const mm = t.match(new RegExp(`^# ${MARKER} v(\\d+) `, 'm'));
  if (!mm) return null;
  const at = t.lastIndexOf('\n' + CHECKSUM_TAG);
  let pristine = false;
  if (at >= 0) {
    const hex = t.slice(at + 1 + CHECKSUM_TAG.length).replace(/\n$/, '');
    pristine = /^[0-9a-f]{64}$/.test(hex) && sha256(t.slice(0, at + 1)) === hex;
  }
  const baked = {};
  for (const k of ['PROJECT_PREFIX', 'CACHE_PARENT', 'INSTALL_ROOT', 'NODE']) {
    const m = t.match(new RegExp(`^AGENTEX_${k}='((?:[^']|'\\\\'')*)' #$`, 'm'));
    baked[k] = m ? m[1].replace(/'\\''/g, "'") : '';
  }
  return { version: Number(mm[1]), pristine, baked };
}

// Would a hook with these baked locations find a scanner right now?
function resolves(cacheParent, installRoot) {
  const r = spawnSync(process.execPath, ['-e', RESOLVER_JS, '--', cacheParent || '', installRoot || ''],
    { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() !== '';
}

const posix = (p) => p.split(path.sep).join('/');
function realOr(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function docsFor(pluginRoot, anchor) { return path.join(pluginRoot, ...DOCS_REL) + anchor; }
const defaultPluginRoot = () => path.resolve(__dirname, '..', '..');

// Where does git look for this repository's hooks, and what is there?
function locate(projectRoot) {
  let info;
  try { info = gp.repoInfo(projectRoot); }
  catch (e) { if (e.code === 'not-a-git-repository') return { status: 'not-a-repo' }; throw e; }
  const rel = posix(path.relative(realOr(info.toplevel), realOr(projectRoot)));
  const projectPrefix = rel.startsWith('..') ? '' : rel;
  const hp = gp.hooksPathConfig(projectRoot);
  if (hp && hp.scope === 'global') {
    const hooksDir = path.resolve(info.toplevel, hp.value);
    return { status: 'shared-hooks-path', hooksDir, hookPath: path.join(hooksDir, 'pre-commit'), projectPrefix };
  }
  const hooksDir = hp ? path.resolve(info.toplevel, hp.value) : gp.defaultHooksDir(projectRoot);
  return { status: null, hooksDir, hookPath: path.join(hooksDir, 'pre-commit'), projectPrefix };
}

function status(projectRoot, { pluginRoot = defaultPluginRoot() } = {}) {
  const loc = locate(projectRoot);
  const base = { action: 'status' };
  if (loc.status === 'not-a-repo') return { ...base, status: 'not-a-repo' };
  const out = { ...base, hooksDir: loc.hooksDir, hookPath: loc.hookPath };
  if (loc.status === 'shared-hooks-path') return { ...out, status: 'shared-hooks-path', docs: docsFor(pluginRoot, '#the-hook') };
  let text;
  try { text = fs.readFileSync(loc.hookPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { ...out, status: 'absent' };
    return { ...out, status: 'foreign', docs: docsFor(pluginRoot, '#calling-the-scan-from-an-existing-hook') };
  }
  const own = parseOwn(text);
  if (!own || !own.pristine) return { ...out, status: 'foreign', docs: docsFor(pluginRoot, '#calling-the-scan-from-an-existing-hook') };
  if (own.version < TEMPLATE_VERSION || !resolves(own.baked.CACHE_PARENT, own.baked.INSTALL_ROOT)) return { ...out, status: 'stale' };
  return { ...out, status: 'installed' };
}

function bakedFor(loc, pluginRoot, nodePath) {
  const parsed = parseInstallPath(pluginRoot);
  return {
    projectPrefix: loc.projectPrefix,
    cacheParent: parsed ? path.join(parsed.pluginsHome, 'cache', parsed.marketplace, parsed.plugin) : '',
    installRoot: pluginRoot,
    nodePath: nodePath || process.execPath,
    hooksDir: loc.hooksDir,
  };
}

function install(projectRoot, { pluginRoot = defaultPluginRoot(), nodePath } = {}) {
  const st = status(projectRoot, { pluginRoot });
  const base = { action: 'install' };
  if (st.status === 'not-a-repo') {
    return { ...base, status: 'not-a-repo', exit: 2, message: 'this folder is not a git repository; initialise one first (git init) - nothing was written' };
  }
  if (st.status === 'shared-hooks-path') {
    return { ...base, status: 'refused', reason: 'shared-hooks-path', exit: 1, hooksDir: st.hooksDir, docs: st.docs,
      snippetAvailable: true,
      message: 'core.hooksPath points at a machine-wide hooks folder shared by every repository on this machine - nothing was written; call the scan from your own hook instead' };
  }
  if (st.status === 'foreign') {
    return { ...base, status: 'refused', reason: 'foreign', exit: 1, hookPath: st.hookPath, docs: st.docs, snippetAvailable: true,
      message: 'a pre-commit hook not installed by AgenTeX already exists - it was left untouched; to add the scan to it, see the docs' };
  }
  if (st.status === 'installed') return { ...base, status: 'already-installed', exit: 0, hookPath: st.hookPath, message: 'the AgenTeX pre-commit hook is already installed - nothing changed' };
  const loc = locate(projectRoot);
  const content = renderHook(bakedFor(loc, pluginRoot, nodePath));
  fs.mkdirSync(loc.hooksDir, { recursive: true });
  const tmp = path.join(loc.hooksDir, `.pre-commit.agentex-${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, loc.hookPath);
  const refreshed = st.status === 'stale';
  return { ...base, status: refreshed ? 'refreshed' : 'installed', exit: 0, hookPath: loc.hookPath,
    message: refreshed ? 'the AgenTeX pre-commit hook was refreshed' : 'the AgenTeX pre-commit hook was installed - delete the file to turn it off' };
}

function printScript(projectRoot, { pluginRoot = defaultPluginRoot(), nodePath } = {}) {
  const loc = locate(projectRoot);
  if (loc.status === 'not-a-repo') return { action: 'print', status: 'not-a-repo', exit: 2, message: 'this folder is not a git repository; initialise one first (git init)' };
  return { action: 'print', script: renderStandalone(bakedFor(loc, pluginRoot, nodePath)) };
}

// The single [hook] line migrate.js prints for /update-agentex to relay.
function engineLine(r) {
  const at = r.hookPath ? ` (${r.hookPath})` : '';
  const docs = 'docs/putting-your-project-in-git.md';
  switch (r.status) {
    case 'absent':
      return '[hook] offer - the optional pre-commit secret-scan hook is not installed. Ask the user; only on an explicit yes, re-run with --install-pre-commit-hook';
    case 'stale':
      return `[hook] offer - an older AgenTeX pre-commit hook is installed${at}. Ask the user; only on an explicit yes, re-run with --install-pre-commit-hook to refresh it`;
    case 'installed': return `[hook] installed${at}`;
    case 'already-installed': return `[hook] already installed${at}`;
    case 'refreshed': return `[hook] refreshed${at}`;
    case 'foreign': return `[hook] existing hook left untouched${at} - to add the scan to it see ${docs}#calling-the-scan-from-an-existing-hook`;
    case 'shared-hooks-path': return `[hook] shared hooks folder, not installed - core.hooksPath is machine-wide; see ${docs}#the-hook`;
    case 'refused':
      return r.reason === 'shared-hooks-path'
        ? `[hook] shared hooks folder, not installed - core.hooksPath is machine-wide; see ${docs}#the-hook`
        : `[hook] existing hook left untouched${at} - to add the scan to it see ${docs}#calling-the-scan-from-an-existing-hook`;
    case 'not-a-repo': return '[hook] not a git repository - the hook is unavailable';
    default: return '[hook] status unavailable - the migration continues';
  }
}

module.exports = {
  TEMPLATE_VERSION, RESOLVER_JS,
  renderHook, renderStandalone, parseOwn, status, install, printScript, engineLine,
};
