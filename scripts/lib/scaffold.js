'use strict';
// AgenTeX shared scaffold library — the file-scaffolding actions behind /init-test
// (scripts/init.js) and the migration engine's gap-fill step
// (scripts/migrations/07-fill-gaps.js). One routine, so "current scaffold
// conventions" has exactly one definition and init/migrate cannot drift apart.
//
// Every action is idempotent and non-destructive: an existing file is never
// overwritten; CLAUDE.md and .gitignore are append-only. Functions accept
// { dryRun: true } to report what WOULD change without writing, and return action
// objects { kind: 'created'|'skipped', path: <project-relative>, note } instead of
// printing — callers own the report format.
const fs = require('fs');
const path = require('path');
const { ENV_KEY_MAP } = require('./env_key_map.js');

// The executions/ guidance appended to the consumer's CLAUDE.md.
const CLAUDE_MD_BULLET = [
  '- `executions/` holds generated test-run artifacts (reports, screenshots, logs).',
  '  Never read or search it when gathering context — only when explicitly asked',
  '  about a specific run.',
  ''
].join('\n');

const STAMP_REL = '.agentex/version.json';

const rel = (projectRoot, f) => path.relative(projectRoot, f).split(path.sep).join('/');

// Any *.md spec under dir (recursively), README.md excluded?
function hasSpecFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (hasSpecFiles(full)) return true; }
    else if (/\.md$/i.test(entry.name) && entry.name.toLowerCase() !== 'readme.md') return true;
  }
  return false;
}

// ── .gitignore: the .env entry ───────────────────────────────────────────────
function gitignoreHasEnvEntry(projectRoot) {
  const gitignore = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignore)) return false;
  const lines = fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).map(l => l.trim());
  return ['.env', '/.env', '*.env'].some(p => lines.includes(p));
}

function ensureGitignoreEnv(projectRoot, { dryRun = false } = {}) {
  const gitignore = path.join(projectRoot, '.gitignore');
  if (gitignoreHasEnvEntry(projectRoot)) {
    return { kind: 'skipped', path: rel(projectRoot, gitignore), note: '.env already gitignored' };
  }
  if (fs.existsSync(gitignore)) {
    if (!dryRun) {
      const content = fs.readFileSync(gitignore, 'utf8');
      fs.appendFileSync(gitignore, `${content.endsWith('\n') || content === '' ? '' : '\n'}.env\n`);
    }
    return { kind: 'created', path: rel(projectRoot, gitignore), note: '.env line appended' };
  }
  if (!dryRun) fs.writeFileSync(gitignore, '.env\n', 'utf8');
  return { kind: 'created', path: rel(projectRoot, gitignore), note: 'created with .env entry' };
}

// ── CLAUDE.md: the executions/ guidance bullet (append-only) ─────────────────
function claudeMdHasBullet(projectRoot) {
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) return false;
  const content = fs.readFileSync(claudeMd, 'utf8');
  return content.includes('executions/') && content.includes('test-run artifacts');
}

function ensureClaudeMdBullet(projectRoot, { dryRun = false } = {}) {
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    if (claudeMdHasBullet(projectRoot)) {
      return { kind: 'skipped', path: rel(projectRoot, claudeMd), note: 'equivalent guidance already present' };
    }
    if (!dryRun) {
      const content = fs.readFileSync(claudeMd, 'utf8');
      fs.appendFileSync(claudeMd, `${content.endsWith('\n') ? '' : '\n'}\n${CLAUDE_MD_BULLET}`);
    }
    return { kind: 'created', path: rel(projectRoot, claudeMd), note: 'executions/ guidance appended' };
  }
  if (!dryRun) fs.writeFileSync(claudeMd, CLAUDE_MD_BULLET, 'utf8');
  return { kind: 'created', path: rel(projectRoot, claudeMd), note: 'created with executions/ guidance' };
}

// ── Full scaffold — the exact set of actions /init-test performs ─────────────
function scaffoldProject(projectRoot, pluginRoot, { dryRun = false } = {}) {
  const actions = [];
  const push = (kind, f, note) => actions.push({ kind, path: rel(projectRoot, f), note });

  const copyFileIfAbsent = (src, dest) => {
    if (fs.existsSync(dest)) { push('skipped', dest, 'already exists'); return; }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    push('created', dest, undefined);
  };

  // 1. Sample specs (only when the user has none of their own)
  const testDir = path.join(projectRoot, 'test');
  if (hasSpecFiles(testDir)) {
    push('skipped', testDir, 'user specs present, bundled samples not copied');
  } else {
    const suiteSrc = path.join(pluginRoot, 'test', 'suite1');
    for (const name of fs.readdirSync(suiteSrc)) {
      copyFileIfAbsent(path.join(suiteSrc, name), path.join(testDir, 'suite1', name));
    }
    copyFileIfAbsent(path.join(pluginRoot, 'test', 'README.md'), path.join(testDir, 'README.md'));
  }

  // 2. Executions folder
  const execDir = path.join(projectRoot, 'executions');
  if (fs.existsSync(execDir)) {
    push('skipped', execDir, 'already exists');
  } else {
    if (!dryRun) fs.mkdirSync(execDir, { recursive: true });
    push('created', execDir, 'run artifacts land here');
  }

  // 3. .env scaffold (keys only) + .gitignore entry
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    push('skipped', envFile, 'already exists (not touched)');
  } else {
    if (!dryRun) {
      const example = fs.readFileSync(path.join(pluginRoot, '.env.example'), 'utf8');
      const blanked = example.split(/\r?\n/).map(line => {
        if (/^\s*#/.test(line) || /^\s*$/.test(line)) return line;          // comments/blanks kept
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        return m ? `${m[1]}=` : line;                                        // values emptied
      }).join('\n');
      fs.writeFileSync(envFile, blanked, 'utf8');
    }
    push('created', envFile, 'keys only, fill in the values yourself');
  }
  actions.push(ensureGitignoreEnv(projectRoot, { dryRun }));

  // 4. Integration catalog
  const integrationDir = path.join(projectRoot, 'integration');
  if (fs.existsSync(integrationDir)) {
    push('skipped', integrationDir, 'already exists — catalog not touched');
  } else {
    copyFileIfAbsent(path.join(pluginRoot, 'skills', 'api-integration', 'templates', 'sample_api.json'),
                     path.join(integrationDir, 'sample_api.json'));
    copyFileIfAbsent(path.join(pluginRoot, 'skills', 'db-integration', 'templates', 'sample_db.json'),
                     path.join(integrationDir, 'sample_db.json'));
  }

  // 4b. Project config + environments (new layout; .env keeps only secrets)
  copyFileIfAbsent(path.join(pluginRoot, 'templates', 'config', 'project.json'),
                   path.join(projectRoot, 'config', 'project.json'));
  copyFileIfAbsent(path.join(pluginRoot, 'templates', 'environments', 'qc.json'),
                   path.join(projectRoot, 'environments', 'qc.json'));

  // 5. CLAUDE.md guidance (append-only)
  actions.push(ensureClaudeMdBullet(projectRoot, { dryRun }));

  return actions;
}

// ── Legacy signals — does this project predate current conventions? ──────────
// The same signals the migration engine's detectors key on. /init-test must NOT
// stamp a project that shows any of them: a fresh stamp would make /update-agentex
// fast-path it as up to date while legacy conventions remain. Such a project stays
// stamp-less until a migration run finishes and stamps it.
function hasLegacySignals(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'integrations'))) return true;        // pre-0.7 catalog folder
  if (fs.existsSync(path.join(projectRoot, 'agentex.config.json'))) return true; // KB-era root config
  try {
    const env = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && ENV_KEY_MAP[m[1]]) return true;                                    // keys-only .env era
    }
  } catch { /* no .env — no signal */ }
  return false;
}

// ── Version stamp — .agentex/version.json ────────────────────────────────────
// Written at scaffold time (/init-test) and after every migration (/update-agentex)
// so upgrades can compare exact versions. Lives in .agentex/ because that folder is
// committed, plugin-owned, and outside the wizard's rebuild-from-skeleton blast
// radius (a stamp inside config/project.json would be dropped on the next save).
function stampPath(projectRoot) {
  return path.join(projectRoot, ...STAMP_REL.split('/'));
}

// Stamped version string, or null when missing/unreadable (a legacy project).
function readVersionStamp(projectRoot) {
  try {
    const v = JSON.parse(fs.readFileSync(stampPath(projectRoot), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

function writeVersionStamp(projectRoot, version, { dryRun = false } = {}) {
  const file = stampPath(projectRoot);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version }, null, 2) + '\n', 'utf8');
  }
  return { kind: 'created', path: STAMP_REL, note: `version stamp ${version}` };
}

// Installed plugin version from the plugin's own manifest.
function readPluginVersion(pluginRoot) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

module.exports = {
  CLAUDE_MD_BULLET, STAMP_REL,
  hasSpecFiles, scaffoldProject, hasLegacySignals,
  gitignoreHasEnvEntry, ensureGitignoreEnv,
  claudeMdHasBullet, ensureClaudeMdBullet,
  stampPath, readVersionStamp, writeVersionStamp, readPluginVersion,
};
