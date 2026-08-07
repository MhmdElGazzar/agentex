// AgenTeX project scaffolder — the file-scaffolding steps of /init-test in a single call.
//
// Usage: node init.js [projectDir]   (default: current working directory)
// Idempotent and non-destructive: never overwrites an existing file; CLAUDE.md and
// .gitignore are append-only. Prints one [created]/[skipped] line per action and a
// final summary. Exit 0 on success, 1 on error.
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(process.argv[2] || process.cwd());

if (projectRoot === pluginRoot) {
  console.error('[error] refusing to scaffold inside the AgenTeX plugin itself — run from your project root');
  process.exit(1);
}

let created = 0, skipped = 0;
const rel = f => path.relative(projectRoot, f).split(path.sep).join('/');
const logCreated = (f, note) => { created++; console.log(`[created] ${rel(f)}${note ? ` — ${note}` : ''}`); };
const logSkipped = (f, note) => { skipped++; console.log(`[skipped] ${rel(f)}${note ? ` — ${note}` : ''}`); };

// Copy one file unless the destination already exists.
function copyFileIfAbsent(src, dest) {
  if (fs.existsSync(dest)) { logSkipped(dest, 'already exists'); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  logCreated(dest);
}

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

// ── 1. Sample specs ──────────────────────────────────────────────────────────
const testDir = path.join(projectRoot, 'test');
if (hasSpecFiles(testDir)) {
  logSkipped(testDir, 'user specs present, bundled samples not copied');
} else {
  const suiteSrc = path.join(pluginRoot, 'test', 'suite1');
  for (const name of fs.readdirSync(suiteSrc)) {
    copyFileIfAbsent(path.join(suiteSrc, name), path.join(testDir, 'suite1', name));
  }
  copyFileIfAbsent(path.join(pluginRoot, 'test', 'README.md'), path.join(testDir, 'README.md'));
}

// ── 2. Executions folder ─────────────────────────────────────────────────────
const execDir = path.join(projectRoot, 'executions');
if (fs.existsSync(execDir)) {
  logSkipped(execDir, 'already exists');
} else {
  fs.mkdirSync(execDir, { recursive: true });
  logCreated(execDir, 'run artifacts land here');
}

// ── 3. .env scaffold (keys only) + .gitignore ────────────────────────────────
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) {
  logSkipped(envFile, 'already exists (not touched)');
} else {
  const example = fs.readFileSync(path.join(pluginRoot, '.env.example'), 'utf8');
  const blanked = example.split(/\r?\n/).map(line => {
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) return line;          // comments/blanks kept
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return m ? `${m[1]}=` : line;                                        // values emptied
  }).join('\n');
  fs.writeFileSync(envFile, blanked, 'utf8');
  logCreated(envFile, 'keys only, fill in the values yourself');
}

const gitignore = path.join(projectRoot, '.gitignore');
const giLines = fs.existsSync(gitignore)
  ? fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).map(l => l.trim())
  : null;
if (giLines && ['.env', '/.env', '*.env'].some(p => giLines.includes(p))) {
  logSkipped(gitignore, '.env already gitignored');
} else if (giLines) {
  const content = fs.readFileSync(gitignore, 'utf8');
  fs.appendFileSync(gitignore, `${content.endsWith('\n') || content === '' ? '' : '\n'}.env\n`);
  logCreated(gitignore, '.env line appended');
} else {
  fs.writeFileSync(gitignore, '.env\n', 'utf8');
  logCreated(gitignore, 'created with .env entry');
}

// ── 4. Integration catalog ───────────────────────────────────────────────────
const integrationDir = path.join(projectRoot, 'integration');
if (fs.existsSync(integrationDir)) {
  logSkipped(integrationDir, 'already exists — catalog not touched');
} else {
  copyFileIfAbsent(path.join(pluginRoot, 'skills', 'api-integration', 'templates', 'sample_api.json'),
                   path.join(integrationDir, 'sample_api.json'));
  copyFileIfAbsent(path.join(pluginRoot, 'skills', 'db-integration', 'templates', 'sample_db.json'),
                   path.join(integrationDir, 'sample_db.json'));
}

// ── 4b. Project config + environments (new layout; .env keeps only secrets) ──
copyFileIfAbsent(path.join(pluginRoot, 'templates', 'config', 'project.json'),
                 path.join(projectRoot, 'config', 'project.json'));
copyFileIfAbsent(path.join(pluginRoot, 'templates', 'environments', 'qa.json'),
                 path.join(projectRoot, 'environments', 'qa.json'));

// ── 5. CLAUDE.md guidance (append-only) ──────────────────────────────────────
const BULLET = [
  '- `executions/` holds generated test-run artifacts (reports, screenshots, logs).',
  '  Never read or search it when gathering context — only when explicitly asked',
  '  about a specific run.',
  ''
].join('\n');
const claudeMd = path.join(projectRoot, 'CLAUDE.md');
if (fs.existsSync(claudeMd)) {
  const content = fs.readFileSync(claudeMd, 'utf8');
  if (content.includes('executions/') && content.includes('test-run artifacts')) {
    logSkipped(claudeMd, 'equivalent guidance already present');
  } else {
    fs.appendFileSync(claudeMd, `${content.endsWith('\n') ? '' : '\n'}\n${BULLET}`);
    logCreated(claudeMd, 'executions/ guidance appended');
  }
} else {
  fs.writeFileSync(claudeMd, BULLET, 'utf8');
  logCreated(claudeMd, 'created with executions/ guidance');
}

console.log(`\nAgenTeX scaffold done: ${created} created, ${skipped} skipped (existing files are never overwritten).`);
