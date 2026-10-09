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
const { isDeepStrictEqual } = require('util');
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

// Any environment file at all? The sample environment is scaffolded only into a
// project with none — a project that already has environments (wizard-saved,
// hand-written, or legacy) must never get a sample injected beside them, or it
// survives as a phantom environment the user never configured.
function hasEnvFiles(projectRoot) {
  const dir = path.join(projectRoot, 'environments');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(f => f.endsWith('.json'));
}

// ── .gitignore: the entries a QA project must never commit ───────────────────
// Three run artifacts carry live credentials, not just the .env:
//
//   test/.auth/      the sessions optimize-login saves. A Playwright storage-state
//                    file IS the session — bearer token and auth cookies in plain
//                    JSON. The docs have always called this directory "gitignored
//                    by convention", but nothing ever wrote the entry, so the
//                    convention was the tester's to remember and a `git add -A`
//                    after an optimize-login run committed a working token.
//   .playwright-cli/ the CLI's scratch profile — the same cookies, on disk.
//
// One entry is not a credential at all: test/.ui-baselines/ is the ui-check fallback
// baseline cache — design PNGs the runner re-fetches on demand. It is ignored to keep
// binaries out of a QA repo, and it carries its own comment so the block does not
// claim a cache holds a session. Same for .agentex/cache/ — tracker field metadata
// (picklist allowedValues etc.), safe to delete, rebuilt on demand by the tracker
// scripts. Committing that cache is a documented one-line opt-in: appending
// `!.agentex/cache/` to .gitignore — the negation both re-includes the directory
// and is listed in the entry's covers, so this scaffold (and m05) never re-adds
// the ignore line over the user's opt-in.
//
// Append-only and per-entry: a project that already ignores one of them (under
// any of the spellings below) keeps its own line; only what is genuinely missing
// is added.
const GITIGNORE_ENTRIES = [
  { entry: '.env', covers: ['.env', '/.env', '*.env'] },
  {
    entry: 'test/.auth/',
    covers: ['test/.auth/', 'test/.auth', '/test/.auth/', '/test/.auth', '.auth/', '.auth', '**/.auth/'],
  },
  {
    entry: '.playwright-cli/',
    covers: ['.playwright-cli/', '.playwright-cli', '/.playwright-cli/', '/.playwright-cli'],
  },
  {
    entry: 'test/.ui-baselines/',
    comment: '# and this one is only a cache — ui-check re-fetches these design baselines',
    covers: ['test/.ui-baselines/', 'test/.ui-baselines', '/test/.ui-baselines/',
      '/test/.ui-baselines', '.ui-baselines/', '.ui-baselines'],
  },
  {
    entry: '.agentex/cache/',
    comment: '# and this one is only a cache too — tracker field metadata, safe to delete, rebuilt on demand',
    covers: ['.agentex/cache/', '.agentex/cache', '/.agentex/cache/', '/.agentex/cache',
      '.agentex/', '.agentex', '/.agentex/', '/.agentex',
      // The documented commit opt-in: the user re-included the cache on purpose —
      // never add the ignore line back over it.
      '!.agentex/cache/', '!.agentex/cache'],
  },
];

const GITIGNORE_HEADER = '# AgenTeX — never commit these: they hold live credentials';

// Which required entries does this project's .gitignore not cover yet?
function gitignoreMissing(projectRoot) {
  const gitignore = path.join(projectRoot, '.gitignore');
  const lines = fs.existsSync(gitignore)
    ? fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).map(l => l.trim())
    : [];
  return GITIGNORE_ENTRIES.filter(e => !e.covers.some(p => lines.includes(p)));
}

function ensureGitignore(projectRoot, { dryRun = false } = {}) {
  const gitignore = path.join(projectRoot, '.gitignore');
  const missing = gitignoreMissing(projectRoot);
  const existed = fs.existsSync(gitignore);
  if (!missing.length) {
    return {
      kind: 'skipped',
      path: rel(projectRoot, gitignore),
      note: 'secrets, saved sessions and the caches already gitignored',
    };
  }
  const current = existed ? fs.readFileSync(gitignore, 'utf8') : '';
  // Match the file's own line ending rather than mixing them.
  const eol = /\r\n/.test(current) ? '\r\n' : '\n';
  const header = current.includes(GITIGNORE_HEADER) ? [] : [GITIGNORE_HEADER];
  const block = [...header, ...missing.flatMap(e => (e.comment ? [e.comment, e.entry] : [e.entry])), '']
    .join(eol);
  if (!dryRun) {
    const lead = current === '' || /\n$/.test(current) ? '' : eol;
    fs.writeFileSync(gitignore, current + lead + block, 'utf8');
  }
  const names = missing.map(e => e.entry).join(', ');
  return {
    kind: 'created',
    path: rel(projectRoot, gitignore),
    note: existed ? `${names} appended` : `created with ${names}`,
  };
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
  actions.push(ensureGitignore(projectRoot, { dryRun }));

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

  // 4b. Project config + environments (new layout; .env keeps only secrets).
  // The sample environment lands ONLY in a project with no environment files at
  // all: fresh scaffolds get the editable starting point, while /init-test
  // re-runs and m07 fill-gaps on projects that already have environments never
  // inject a phantom sample beside them.
  copyFileIfAbsent(path.join(pluginRoot, 'templates', 'config', 'project.json'),
                   path.join(projectRoot, 'config', 'project.json'));
  if (hasEnvFiles(projectRoot)) {
    push('skipped', path.join(projectRoot, 'environments'), 'environment file(s) present — sample environment not copied');
  } else {
    copyFileIfAbsent(path.join(pluginRoot, 'templates', 'environments', 'qc.json'),
                     path.join(projectRoot, 'environments', 'qc.json'));
  }

  // 5. CLAUDE.md guidance (append-only)
  actions.push(ensureClaudeMdBullet(projectRoot, { dryRun }));

  return actions;
}

// ── Pristine sample-environment detection ────────────────────────────────────
// A "pristine sample" is an environment file structurally identical (JSON-parse +
// deep-equal; whitespace/key-order insensitive) to a sample template this plugin
// has EVER shipped — it verifiably carries zero user values. That is what turns
// "delete a file" (forbidden by invariant #11) into "remove a plugin artifact,
// announced first": the wizard's save-time reconciliation and migration m10 both
// judge against this one set. A file that differs in any value is user-touched
// and is treated as the user's, always.
//
// HISTORICAL_SAMPLE_ENV_SHAPES holds every shipped revision of
// templates/environments/* from the plugin's git history (currently one: the
// qa.json shipped from 0.11.0 through 0.16.x, byte-equal to today's qc.json).
// When the template changes, append the outgoing shape here — pre-change
// projects still carry it.
const HISTORICAL_SAMPLE_ENV_SHAPES = [
  {
    portalUrl: 'https://example.com',
    defaults: { otp: '0000', password: 'Test@1234' },
    users: {
      valid_user: { phone: '0550000001', role: 'customer' },
      expired_user: { phone: '0550000002', notes: 'for negative login scenarios' },
    },
    db: {
      server: 'localhost', port: 1433, name: 'my-database', user: 'qa_user',
      password: { envSecret: 'SQLCMDPASSWORD' },
    },
    api: { baseUrl: 'https://jsonplaceholder.typicode.com', token: { envSecret: 'API_TOKEN' } },
  },
];

// Every sample-environment shape ever shipped: current template first (read from
// the installed plugin), then the historical revisions.
function sampleEnvShapes(pluginRoot) {
  const shapes = [];
  try {
    shapes.push(JSON.parse(fs.readFileSync(
      path.join(pluginRoot, 'templates', 'environments', 'qc.json'), 'utf8')));
  } catch { /* unreadable template — historical shapes still apply */ }
  return shapes.concat(HISTORICAL_SAMPLE_ENV_SHAPES);
}

// Is this parsed environment JSON structurally identical to a shipped sample?
function isPristineSampleEnv(parsed, pluginRoot) {
  if (!parsed || typeof parsed !== 'object') return false;
  return sampleEnvShapes(pluginRoot).some(shape => isDeepStrictEqual(parsed, shape));
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
  hasSpecFiles, hasEnvFiles, scaffoldProject, hasLegacySignals,
  sampleEnvShapes, isPristineSampleEnv,
  gitignoreMissing, ensureGitignore,
  claudeMdHasBullet, ensureClaudeMdBullet,
  stampPath, readVersionStamp, writeVersionStamp, readPluginVersion,
};
