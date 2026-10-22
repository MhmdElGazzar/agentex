'use strict';
// Behaviour tests for the consumer secret scan CLI (scripts/secret_scan.js) — the
// backlog's scanner acceptance criteria, in temp git repos with sentinel values.
// Run: node scripts/secret_scan.test.js
// Every invocation's stdout+stderr is collected; the last test asserts that no
// sentinel value and no remote URL ever reached either stream.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'secret_scan.js');
const S = {
  token: 'EVAL_SENTINEL_SCAN_token_7q2m',
  pat: 'EVAL_SENTINEL_SCAN_pat_9f4x',
  ref: 'EVAL_SENTINEL_SCAN_ref_3k8v',
  shell: 'EVAL_SENTINEL_SCAN_shell_5x1z',
  field: 'EVAL_SENTINEL_SCAN_field_2b6n',
  remote: 'EVAL_SENTINEL_SCAN_remote_8w3t',
  json: 'EVAL_SENTINEL_SCAN_json_4h9p',
  baseUrl: 'https://EVAL-SENTINEL-SCAN-baseurl-6c1r.example.test/v2',
};
const SHORT = '482913';
const REMOTE_HOST = 'git.example.test';
const ALL_OUTPUT = [];

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// The tests own the environment: no inherited git hook variables, no user git
// config, and none of the plugin's canonical secret names from the developer's shell.
const EMPTY_GLOBAL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-scan-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_')) continue;
    if (/^(AZURE_|JIRA_|SQLCMD|API_|KB_|FIGMA_|DEFAULT_|MY_)/.test(k)) continue;
    env[k] = v;
  }
  // No test may ever wait on the developer's real terminal: the --hook confirmation
  // sees "no terminal" unless a test points the seam at an answer file.
  return { ...env, GIT_CONFIG_GLOBAL: EMPTY_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', AGENTEX_SECRET_SCAN_TTY: 'none', ...extra };
}

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-scan-'))); }
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=qa@example.test', '-c', 'user.name=QA Test',
    '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', env: baseEnv() });
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + '\n');
}
// A project repo: `files` committed, `.env` written but never committed (it is gitignored).
function repo({ env = null, files = {}, commit = true, gitignore = '.env\n' } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  if (gitignore !== null) write(dir, '.gitignore', gitignore);
  for (const [rel, c] of Object.entries(files)) write(dir, rel, c);
  git(dir, 'add', '-A');
  if (commit) git(dir, 'commit', '-qm', 'fixture', '--allow-empty');
  if (env !== null) write(dir, '.env', env);
  return dir;
}

function scan(dir, mode, { args = [], env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [CLI, `--${mode}`, ...args], { cwd: cwd || dir, encoding: 'utf8', env: baseEnv(env) });
  ALL_OUTPUT.push(r.stdout, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines[0]); } catch { /* asserted by callers */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines, json };
}
const kinds = (r) => r.json.findings.map(f => f.kind);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function treeSnapshot(dir) {
  const map = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'objects' && e.name !== 'logs') walk(full); }
      else map[path.relative(dir, full)] = sha1(fs.readFileSync(full));
    }
  })(dir);
  return map;
}

// ── Values in files ──────────────────────────────────────────────────────────
test('a .env key\'s value in a tracked file → exit 1, finding names file, line and key (both modes)', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'test/suite1/login.md': `# Login\n\nuse ${S.token} here\n` } });
  for (const mode of ['tracked', 'staged']) {
    if (mode === 'staged') { write(dir, 'test/suite1/new.md', `x\n${S.token}\n`); git(dir, 'add', 'test/suite1/new.md'); }
    const r = scan(dir, mode);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.strictEqual(r.json.result, 'LEAK');
    assert.strictEqual(r.json.mode, mode);
    const f = r.json.findings.find(x => x.kind === 'secret-value');
    assert.deepStrictEqual(f, mode === 'tracked'
      ? { severity: 'leak', kind: 'secret-value', file: 'test/suite1/login.md', line: 3, key: 'API_TOKEN' }
      : { severity: 'leak', kind: 'secret-value', file: 'test/suite1/new.md', line: 2, key: 'API_TOKEN' });
    assert.ok(r.stderr.includes('API_TOKEN'));
  }
});

test('an envSecret-referenced value → exit 1, from .env and from the shell environment (NU-7)', () => {
  const files = { 'environments/qc.json': { api: { token: { envSecret: 'MY_REF' } } }, 'notes.md': `ref ${S.ref}\nshell ${S.shell}\n` };
  const fromFile = scan(repo({ env: `MY_REF=${S.ref}\n`, files }), 'tracked');
  assert.strictEqual(fromFile.status, 1);
  assert.deepStrictEqual(fromFile.json.findings.map(f => [f.file, f.line, f.key]), [['notes.md', 1, 'MY_REF']]);
  const fromShell = scan(repo({ env: null, files }), 'tracked', { env: { MY_REF: S.shell } });
  assert.strictEqual(fromShell.status, 1);
  assert.deepStrictEqual(fromShell.json.findings.map(f => [f.file, f.line, f.key]), [['notes.md', 2, 'MY_REF']]);
});

test('.env tracked → exit 1 (both modes), contents never read for output', () => {
  const dir = repo({ files: { '.env': `AZURE_PAT=${S.pat}\n` }, gitignore: null });
  for (const mode of ['tracked', 'staged']) {
    const r = scan(dir, mode);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.deepStrictEqual(r.json.findings.filter(f => f.kind === 'env-file-tracked'), [{ severity: 'leak', kind: 'env-file-tracked', file: '.env' }]);
    assert.ok(!kinds(r).includes('secret-value'), 'the .env itself is not value-scanned');
    assert.ok(r.stderr.includes('git rm --cached .env'));
  }
});

test('.env staged but not committed → exit 1 in staged mode', () => {
  const dir = repo({ env: `AZURE_PAT=${S.pat}\n`, gitignore: null });
  git(dir, 'add', '.env');
  const r = scan(dir, 'staged');
  assert.strictEqual(r.status, 1);
  assert.ok(kinds(r).includes('env-file-tracked'));
});

test('a credential in a remote url / pushurl → exit 1 naming the remote only; ssh, scp and username-only are not flagged', () => {
  const dir = repo({ env: '' });
  git(dir, 'remote', 'add', 'origin', `https://qa:${S.remote}@${REMOTE_HOST}/team/repo.git`);
  git(dir, 'remote', 'add', 'mirror', `https://${REMOTE_HOST}/team/repo.git`);
  git(dir, 'config', 'remote.mirror.pushurl', `https://qa:${S.remote}@${REMOTE_HOST}/push.git`);
  git(dir, 'remote', 'add', 'ssh', `ssh://git@${REMOTE_HOST}/team/repo.git`);
  git(dir, 'remote', 'add', 'scp', `git@${REMOTE_HOST}:team/repo.git`);
  git(dir, 'remote', 'add', 'org', `https://myorg@${REMOTE_HOST}/team/repo.git`);
  for (const mode of ['staged', 'tracked']) {
    const r = scan(dir, mode);
    assert.strictEqual(r.status, 1);
    assert.deepStrictEqual(r.json.findings.filter(f => f.kind === 'remote-credential').map(f => `${f.remote}.${f.field}`).sort(),
      ['mirror.pushurl', 'origin.url']);
    for (const f of r.json.findings) assert.deepStrictEqual(Object.keys(f).sort(), ['field', 'kind', 'remote', 'severity']);
    assert.ok(!(r.stdout + r.stderr).includes(REMOTE_HOST), 'never the URL');
  }
});

test('a username equal to a known secret value is a credential (NU-3 a)', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n` });
  git(dir, 'remote', 'add', 'origin', `https://${S.token}@${REMOTE_HOST}/r.git`);
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings.map(f => f.kind), ['remote-credential']);
});

// ── Plain-string fields ──────────────────────────────────────────────────────
test('a plain-string secret field → warn with file/line/field/suggestion, exit 0, the file byte-identical', () => {
  const env = '{\n  "portalUrl": "https://example.com",\n  "api": {\n    "baseUrl": "https://api.example.com",\n    "token": "' + S.field + '"\n  }\n}\n';
  const dir = repo({ env: '', files: { 'environments/uat.json': env } });
  const before = fs.readFileSync(path.join(dir, 'environments/uat.json'));
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(r.json.result, 'WARN');
  assert.deepStrictEqual(r.json.findings, [{ severity: 'warn', kind: 'plain-secret-field', file: 'environments/uat.json', line: 5, field: 'api.token', suggest: { envSecret: 'API_TOKEN' } }]);
  assert.ok(fs.readFileSync(path.join(dir, 'environments/uat.json')).equals(before));
});

test('a plain-string defaults.password warns with DEFAULT_PASSWORD whatever the project schema says (A-2, RD-10)', () => {
  const dir = repo({ env: '', files: {
    'config/project.json': { defaultsFields: [{ key: 'password', label: 'Password' }] },
    'environments/qc.json': { defaults: { password: 'Plain@Text1', otp: '0000' } },
  } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.json.findings.map(f => [f.field, f.suggest]), [['defaults.password', { envSecret: 'DEFAULT_PASSWORD' }]]);
});

test('a plain-string field equal to a .env value — a short one too — is a leak, not a warning', () => {
  const dir = repo({ env: `SQLCMDPASSWORD=${S.field}\nDEFAULT_PASSWORD=${SHORT}\n`, files: {
    'environments/qc.json': { db: { password: S.field }, defaults: { password: SHORT } },
  } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings.map(f => [f.kind, f.field, f.key]).sort(),
    [['secret-value', 'db.password', 'SQLCMDPASSWORD'], ['secret-value', 'defaults.password', 'DEFAULT_PASSWORD']]);
});

test('plain-string warnings in staged mode come only from env/catalog files in this commit\'s delta (RD-5)', () => {
  const dir = repo({ env: '', files: { 'environments/qc.json': { api: { token: 'old-plain' } } } });
  write(dir, 'test/a.md', 'unrelated\n'); git(dir, 'add', 'test/a.md');
  assert.strictEqual(scan(dir, 'staged').json.result, 'CLEAN');
  assert.strictEqual(scan(dir, 'tracked').json.result, 'WARN');
});

test('invalid env JSON containing a sentinel → unparseable-config warning, the sentinel never echoed', () => {
  const dir = repo({ env: '', files: { 'environments/bad.json': `{ "api": { "token": ${S.json} }` } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.json.findings, [{ severity: 'warn', kind: 'unparseable-config', file: 'environments/bad.json' }]);
  assert.ok(!(r.stdout + r.stderr).includes(S.json));
});

// ── Skips ────────────────────────────────────────────────────────────────────
test('no .env → loud "value check skipped", structural checks still run, exit 0', () => {
  const dir = repo({ files: { 'a.md': 'x\n' } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual([r.json.valueCheck.status, r.json.valueCheck.reason], ['skipped', 'no-env-file']);
  assert.match(r.stderr, /value check SKIPPED/);
  git(dir, 'remote', 'add', 'origin', `https://u:${S.remote}@${REMOTE_HOST}/r.git`);
  assert.strictEqual(scan(dir, 'tracked').status, 1, 'remote check still runs');
});

test('a keys-only .env straight from the scaffold → value check skipped (no-values), exit 0', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')
    .split(/\r?\n/).map(l => (/^\s*#/.test(l) || !l.includes('=') ? l : l.replace(/=.*/, '='))).join('\n');
  const r = scan(repo({ env: example, files: { 'a.md': 'x\n' } }), 'staged');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual([r.json.valueCheck.status, r.json.valueCheck.reason], ['skipped', 'no-values']);
});

test('A= followed by B=<sentinel> → findings name B only', () => {
  const r = scan(repo({ env: `A=\nB=${S.token}\n`, files: { 'x.md': `${S.token}\n` } }), 'tracked');
  assert.deepStrictEqual(r.json.findings.map(f => f.key), ['B']);
});

test('non-secret config keys are not needles and are named', () => {
  const r = scan(repo({ env: 'QA_URL=https://example.com/app\nAZURE_AREA_PATH=Proj\\Area\n', files: { 'r.md': 'https://example.com/app Proj\\Area\n' } }), 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.json.valueCheck.notChecked.nonSecretKeys, ['AZURE_AREA_PATH', 'QA_URL']);
  assert.match(r.stderr, /non-secret config key/);
});

test('<NAME>_BASE_URL in .env and its URL in a staged environment file → CLEAN, key named as not value-checked, no "move to config"', () => {
  const dir = repo({ env: `PETSTORE_BASE_URL=${S.baseUrl}\nAZURE_TEAM=Team A\n` });
  write(dir, 'environments/qc.json', { name: 'qc', api: { baseUrl: S.baseUrl } });
  write(dir, 'executions/api-tests/report.md', `# API run\n\nbase: ${S.baseUrl}\n`);
  git(dir, 'add', '-A');
  const r = scan(dir, 'staged', { args: ['--hook', '--project', ''] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.result, 'CLEAN');
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.valueCheck.notChecked.baseUrlKeys, ['PETSTORE_BASE_URL']);
  assert.ok(!r.json.valueCheck.notChecked.nonSecretKeys.includes('PETSTORE_BASE_URL'));
  const baseLine = r.stderr.split('\n').find(l => l.includes('PETSTORE_BASE_URL'));
  assert.match(baseLine, /1 base-URL key\(s\) in \.env not value-checked \(not secrets\): PETSTORE_BASE_URL$/);
  assert.ok(!/move[^\n]*config/.test(baseLine), 'never told to move a base-URL key to config');
  assert.match(r.stderr, /non-secret config key\(s\)[^\n]*AZURE_TEAM - move them to config/, 'the config-key line keeps its wording');
});

test('a real secret beside a <NAME>_BASE_URL key still LEAKs; the base URL itself never does', () => {
  const dir = repo({ env: `PETSTORE_BASE_URL=${S.baseUrl}\nAPI_TOKEN=${S.token}\n` });
  write(dir, 'environments/qc.json', { api: { baseUrl: S.baseUrl } });
  write(dir, 'notes.md', `url ${S.baseUrl}\ntoken ${S.token}\n`);
  git(dir, 'add', '-A');
  const r = scan(dir, 'staged', { args: ['--hook', '--project', ''] });
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings, [{ severity: 'leak', kind: 'secret-value', file: 'notes.md', line: 2, key: 'API_TOKEN' }]);
  assert.match(r.stderr, /commit REFUSED/);
  const baseLine = r.stderr.split('\n').find(l => l.includes('PETSTORE_BASE_URL'));
  assert.ok(baseLine, 'the base-URL key is named');
  assert.ok(!/move[^\n]*config/.test(baseLine));
});

test('binary (NUL) and oversize (--max-file-bytes) files are skipped and counted; a symlink is not followed', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: {
    'shot.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x01]), Buffer.from(S.token)]),
    'big.log': 'x'.repeat(200) + S.token + '\n',
    'ok.md': 'fine\n',
  } });
  const outside = path.join(tmp(), 'outside.md');
  fs.writeFileSync(outside, `${S.token}\n`);
  fs.symlinkSync(outside, path.join(dir, 'link.md'));
  git(dir, 'add', 'link.md'); git(dir, 'commit', '-qm', 'link');
  for (const mode of ['tracked', 'staged']) {
    if (mode === 'staged') { git(dir, 'rm', '-q', '--cached', 'shot.png', 'big.log', 'link.md'); git(dir, 'commit', '-qm', 'rm'); git(dir, 'add', 'shot.png', 'big.log', 'link.md'); }
    const r = scan(dir, mode, { args: ['--max-file-bytes', '100'] });
    assert.strictEqual(r.status, 0, r.stdout);
    assert.deepStrictEqual(r.json.counts.skipped, { binary: 1, oversize: 1, symlink: 1, submodule: 0 }, mode);
    assert.match(r.stderr, /1 binary/);
  }
  const unlimited = scan(dir, 'tracked');
  assert.strictEqual(unlimited.status, 1, 'the default size cut-off admits the 200-byte file');
});

// ── Staged vs tracked ────────────────────────────────────────────────────────
test('staged mode checks staged content, not the working tree', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'a.md': 'clean\n' } });
  write(dir, 'a.md', `working copy only ${S.token}\n`);
  assert.strictEqual(scan(dir, 'staged').json.result, 'CLEAN', 'unstaged secret → no finding');
  git(dir, 'add', 'a.md');
  write(dir, 'a.md', 'cleaned in the working copy\n');
  const r = scan(dir, 'staged');
  assert.strictEqual(r.status, 1, 'staged secret then removed from the working copy → a finding');
  assert.strictEqual(r.json.findings[0].file, 'a.md');
});

test('tracked mode covers every tracked file and names the mode', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'a/one.md': `${S.token}\n`, 'b/c/two.txt': `x ${S.token}\n`, 'clean.md': 'x\n' } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.json.mode, 'tracked');
  assert.deepStrictEqual(r.json.findings.map(f => f.file).sort(), ['a/one.md', 'b/c/two.txt']);
  assert.strictEqual(r.json.counts.filesConsidered, 4);
});

test('tracked mode reads a locally deleted tracked file from its index blob', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'gone.md': `${S.token}\n` } });
  fs.unlinkSync(path.join(dir, 'gone.md'));
  assert.strictEqual(scan(dir, 'tracked').status, 1);
});

test('before the first commit: staged mode scans every staged entry', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'first.md': `${S.token}\n` }, commit: false });
  const r = scan(dir, 'staged');
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.findings[0].file, 'first.md');
});

test('a project in a subfolder: .env and config resolve from --project; paths stay repo-relative', () => {
  const dir = repo({ files: { 'qa/test/a.md': `${S.token}\n`, 'qa/environments/qc.json': { api: { token: 'plain' } } }, gitignore: 'qa/.env\n' });
  write(dir, 'qa/.env', `API_TOKEN=${S.token}\n`);
  const r = scan(dir, 'tracked', { args: ['--project', 'qa'] });
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings.map(f => [f.kind, f.file]),
    [['secret-value', 'qa/test/a.md'], ['plain-secret-field', 'qa/environments/qc.json']]);
  const fromInside = scan(dir, 'tracked', { cwd: path.join(dir, 'qa') });
  assert.strictEqual(fromInside.status, 1);
});

test('a linked worktree is scanned like the main one', () => {
  const dir = repo({ files: { 'a.md': `${S.token}\n` } });
  const wt = path.join(tmp(), 'wt');
  git(dir, 'worktree', 'add', '-q', wt);
  write(wt, '.env', `API_TOKEN=${S.token}\n`);
  const r = scan(wt, 'tracked');
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.findings[0].file, 'a.md');
});

test('commit -a through a real pre-commit hook: the hook\'s temporary index (GIT_INDEX_FILE) is honoured', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'a.md': 'clean\n' } });
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" --staged\n`);
  fs.chmodSync(hook, 0o755);
  write(dir, 'a.md', `modified, not staged by hand ${S.token}\n`);
  const r = spawnSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA', 'commit', '-a', '-m', 'x'],
    { cwd: dir, encoding: 'utf8', env: baseEnv() });
  ALL_OUTPUT.push(r.stdout, r.stderr);
  assert.notStrictEqual(r.status, 0, 'the commit is refused');
  assert.match(r.stderr, /a\.md:1/);
});

// ── A-1: short known values after a password label ───────────────────────────
const SHORT_ENV = `DEFAULT_PASSWORD=${SHORT}\n`;

test('A-1 negative: phone, IBAN, VAT, spaced phone and order id give no finding; the key is named not checked', () => {
  const text = `call 0555${SHORT}\nIBAN XX0380000000608010${SHORT}\nVAT 300${SHORT}000003\nphone +00 5${SHORT} 01\norder ORD-${SHORT}5\n`;
  const r = scan(repo({ env: SHORT_ENV, files: { 'test/contacts.md': text } }), 'tracked');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.valueCheck.notChecked.shortValue, ['DEFAULT_PASSWORD']);
  assert.deepStrictEqual(r.json.valueCheck.labelChecked, ['DEFAULT_PASSWORD']);
});

test('A-1 negative: a label before an unknown value, or before a longer token, or a non-label word', () => {
  const text = 'password: 777111\npassword: 4829130\npassport: 482913\nbypass: 482913\n';
  const r = scan(repo({ env: SHORT_ENV, files: { 'n.md': text } }), 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.json.findings, []);
});

test('A-1 positive (text): each labelled form → exit 1 with file, line, label and key', () => {
  const lines = [`password: ${SHORT}`, `Password = "${SHORT}"`, `**Pwd:** \`${SHORT}\``, `PASS=${SHORT}`,
    `db_pwd: '${SHORT}'`, `passcode:${SHORT}.`, `DEFAULT_PASSWORD=${SHORT}`];
  const r = scan(repo({ env: SHORT_ENV, files: { 'test/login.md': lines.join('\n') + '\n' } }), 'tracked');
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings.map(f => [f.kind, f.file, f.line, f.label, f.key]), lines.map((_, k) =>
    ['short-value-labeled', 'test/login.md', k + 1, ['password', 'password', 'pwd', 'pass', 'pwd', 'passcode', 'password'][k], 'DEFAULT_PASSWORD']));
});

test('A-1 positive (Arabic): labels through RLM, NBSP and tatweel; stderr stays ASCII', () => {
  const text = `كلمة المرور: ${SHORT}\nكلمة السر = ${SHORT}\nكلمـة المرور الافتراضية: ‏${SHORT}‏\n`;
  const r = scan(repo({ env: SHORT_ENV, files: { 'test/ar.md': text } }), 'tracked');
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.json.findings.map(f => [f.line, f.label]), [[1, 'ar-password'], [2, 'ar-secret-word'], [3, 'ar-password']]);
  assert.ok(/^[\x00-\x7F]*$/.test(r.stderr), 'stderr is ASCII');
});

test('A-1 positive (JSON): defaultsFields default, defaults.password as string and number, a catalog name/value pair', () => {
  const dir = repo({ env: SHORT_ENV, files: {
    'config/project.json': `{\n  "defaultsFields": [\n    { "key": "password", "default": "${SHORT}" }\n  ]\n}\n`,
    'environments/a.json': `{\n  "defaults": {\n    "password": ${SHORT}\n  }\n}\n`,
    'integration/login_api.json': `{\n  "requests": [ { "body": { "fields": [ { "name": "pwd",\n    "value": "${SHORT}" } ] } } ]\n}\n`,
  } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 1);
  const got = r.json.findings.map(f => [f.file, f.line, f.field, f.label]).sort();
  assert.deepStrictEqual(got, [
    ['config/project.json', 3, 'defaultsFields[0].default', 'password'],
    ['environments/a.json', 3, 'defaults.password', 'password'],
    ['integration/login_api.json', 3, 'requests[0].body.fields[0].value', 'pwd'],
  ]);
});

test('A-1 dedupe: a plain defaults.password equal to the needle → exactly one finding (secret-value wins)', () => {
  const dir = repo({ env: SHORT_ENV, files: { 'environments/qc.json': `{\n  "defaults": { "password": "${SHORT}" }\n}\n` } });
  const r = scan(dir, 'tracked');
  assert.deepStrictEqual(r.json.findings.map(f => [f.kind, f.line, f.field]), [['secret-value', 2, 'defaults.password']]);
});

test('A-1 floor: a 3-character needle after Pass: gives no finding and is named; --min-labeled-value-length 1 flips it', () => {
  const dir = repo({ env: 'PIN=a7z\n', files: { 'r.md': 'Pass: a7z\n' } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.json.valueCheck.notChecked.shortValue, ['PIN']);
  assert.deepStrictEqual(r.json.valueCheck.labelChecked, []);
  assert.strictEqual(scan(dir, 'tracked', { args: ['--min-labeled-value-length', '1'] }).status, 1);
});

test('A-1 staged: a labelled short value in a staged spec → exit 1', () => {
  const dir = repo({ env: SHORT_ENV });
  write(dir, 'test/s.md', `password: ${SHORT}\n`); git(dir, 'add', 'test/s.md');
  assert.strictEqual(scan(dir, 'staged').status, 1);
});

test('--min-value-length is tunable: a lower cut-off makes a short value a substring needle', () => {
  const dir = repo({ env: SHORT_ENV, files: { 'p.md': `call 0555${SHORT}\n` } });
  assert.strictEqual(scan(dir, 'tracked').status, 0);
  assert.strictEqual(scan(dir, 'tracked', { args: ['--min-value-length', '6'] }).status, 1);
});

// ── Output contract and safety ───────────────────────────────────────────────
test('outside a git repository → exit 2, ERROR with a plain message, one stdout line', () => {
  const r = scan(tmp(), 'tracked');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.lines.length, 1);
  assert.deepStrictEqual([r.json.result, r.json.exit, r.json.error], ['ERROR', 2, 'not-a-git-repository']);
  assert.match(r.json.message, /not inside a git repository/);
});

test('usage errors → exit 2, one stdout line', () => {
  const dir = repo();
  for (const args of [[], ['--staged', '--tracked'], ['--staged', '--max-file-bytes', 'lots'], ['--staged', '--project']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: baseEnv() });
    ALL_OUTPUT.push(r.stdout, r.stderr);
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.strictEqual(r.stdout.split('\n').filter(Boolean).length, 1);
    assert.strictEqual(JSON.parse(r.stdout).error, 'usage');
  }
});

test('exactly one stdout line on every path (clean, warn, leak, skipped)', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'a.md': 'x\n', 'environments/e.json': { api: { token: 'plain' } } } });
  for (const r of [scan(dir, 'staged'), scan(dir, 'tracked')]) assert.strictEqual(r.lines.length, 1);
  write(dir, 'b.md', S.token); git(dir, 'add', 'b.md');
  assert.strictEqual(scan(dir, 'staged').lines.length, 1);
  assert.strictEqual(scan(repo(), 'tracked').lines.length, 1);
});

test('read-only: working tree, .git/index and .git/config byte-identical after both modes', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\nDEFAULT_PASSWORD=${SHORT}\n`, files: {
    'a.md': `${S.token}\npassword: ${SHORT}\n`, 'environments/qc.json': { api: { token: 'plain' } } } });
  write(dir, 'b.md', 'staged\n'); git(dir, 'add', 'b.md');
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'a.md'), t, t);
  const before = treeSnapshot(dir);
  scan(dir, 'staged'); scan(dir, 'tracked');
  assert.deepStrictEqual(treeSnapshot(dir), before);
});

test('--hook wording: "commit REFUSED" and the docs path inside the running plugin', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n` });
  write(dir, 'a.md', S.token); git(dir, 'add', 'a.md');
  const r = scan(dir, 'staged', { args: ['--hook', '--project', ''] });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /commit REFUSED/);
  assert.ok(r.stderr.includes(path.join(path.resolve(__dirname, '..'), 'docs', 'putting-your-project-in-git.md') + '#fixing-findings'));
});

test('findings are capped at 200 with exact counts and findingsTruncated', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'many.md': `${S.token}\n`.repeat(250) } });
  const r = scan(dir, 'tracked');
  assert.deepStrictEqual([r.json.counts.leaks, r.json.findings.length, r.json.findingsTruncated], [250, 200, 50]);
});

// ── Credential shapes (token-patterns design) ────────────────────────────────
// Planted credentials are built at runtime from parts, so no real-looking token is
// ever committed to this repository. The bodies are fixed, obviously fake fillers.
const FILL = 'EvalShapeSentinel0123456789abcdefghijklmnopqrstuvwxyz';
const fill = (n, chars = FILL) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
const SHAPE = {
  'private-key-block': ['-----BEG', 'IN OPENSSH ', 'PRIV', 'ATE KEY-----'].join(''),
  'github-token': ['gh', 'p_', fill(40)].join(''),
  'aws-access-key-id': ['AK', 'IA', fill(16, 'EVALSHAPE0123456789')].join(''),
  'atlassian-api-token': ['ATA', 'TT3', fill(64)].join(''),
  'figma-token': ['fi', 'gd_', fill(44)].join(''),
};
const SHAPE_FILE = ['# Notes', ...Object.values(SHAPE).map(t => `- ${t}`)].join('\n') + '\n';
const SHAPE_FINDINGS = (file) => Object.keys(SHAPE).map((pattern, k) => ({ severity: 'warn', kind: 'credential-shape', file, line: k + 2, pattern }));
const shapeOnly = (r) => r.json.findings.filter(f => f.kind === 'credential-shape');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const QUESTION = 'Continue the commit anyway? [y/N]';
function answerFile(text) { const f = path.join(tmp(), 'answer.txt'); fs.writeFileSync(f, text); return f; }

test('shapes: one planted credential per pattern → file, line and pattern label; exit 0 WARN (tracked and staged)', () => {
  const dir = repo({ env: `API_TOKEN=${S.token}\n`, files: { 'test/suite1/creds.md': SHAPE_FILE } });
  const tracked = scan(dir, 'tracked');
  assert.strictEqual(tracked.status, 0, tracked.stdout + tracked.stderr);
  assert.strictEqual(tracked.json.result, 'WARN');
  assert.deepStrictEqual(tracked.json.findings, SHAPE_FINDINGS('test/suite1/creds.md'));
  write(dir, 'notes/new.md', SHAPE_FILE); git(dir, 'add', 'notes/new.md');
  const staged = scan(dir, 'staged');
  assert.strictEqual(staged.status, 0);
  assert.deepStrictEqual(staged.json.findings, SHAPE_FINDINGS('notes/new.md'), 'staged: this commit\'s delta only');
  for (const r of [tracked, staged]) {
    for (const pattern of Object.keys(SHAPE)) assert.ok(r.stderr.includes(pattern), `stderr names ${pattern}`);
    assert.match(r.stderr, /WARN test\/suite1\/creds\.md:3 |WARN notes\/new\.md:3 /);
    assert.ok(!/LEAK/.test(r.stderr.split('\n').slice(1).join('\n')), 'a shape is never called a leak');
  }
});

test('shapes: with no .env at all, shape detection still runs and the summary says so', () => {
  const dir = repo({ files: { 'test/api.md': `call it with ${SHAPE['github-token']}\n` } });
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual([r.json.valueCheck.status, r.json.valueCheck.reason], ['skipped', 'no-env-file']);
  assert.deepStrictEqual(r.json.findings, [{ severity: 'warn', kind: 'credential-shape', file: 'test/api.md', line: 1, pattern: 'github-token' }]);
  assert.match(r.stderr, /value check SKIPPED[^\n]*credential shapes/);
});

test('shapes: a freshly scaffolded project (shipped samples, templates) gives no shape finding, staged or tracked', () => {
  const scaffold = require('./lib/scaffold.js');
  const dir = tmp();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  scaffold.ensureGitignore(dir);
  scaffold.ensureClaudeMdBullet(dir);
  git(dir, 'init', '-q'); git(dir, 'add', '-A');
  const staged = scan(dir, 'staged');
  assert.ok(staged.json.counts.filesScanned > 3, 'the samples were scanned');
  assert.deepStrictEqual(shapeOnly(staged), []);
  git(dir, 'commit', '-qm', 'scaffold');
  assert.deepStrictEqual(shapeOnly(scan(dir, 'tracked')), []);
});

test('shapes: a token-shaped username in a remote URL → a warning naming the remote; a password part is still a LEAK', () => {
  const dir = repo({ env: '' });
  git(dir, 'remote', 'add', 'origin', `https://${SHAPE['github-token']}@${REMOTE_HOST}/team/repo.git`);
  const r = scan(dir, 'tracked');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(r.json.findings, [{ severity: 'warn', kind: 'credential-shape', remote: 'origin', field: 'url', pattern: 'github-token' }]);
  assert.match(r.stderr, /WARN remote "origin" url [^\n]*github-token/);
  git(dir, 'config', 'remote.origin.pushurl', `https://qa:${SHAPE['figma-token']}@${REMOTE_HOST}/push.git`);
  const both = scan(dir, 'staged');
  assert.strictEqual(both.status, 1, 'the existing remote-credential check is unchanged');
  assert.deepStrictEqual(both.json.findings.map(f => [f.severity, f.kind, f.field, f.pattern]),
    [['leak', 'remote-credential', 'pushurl', undefined], ['warn', 'credential-shape', 'url', 'github-token'], ['warn', 'credential-shape', 'pushurl', 'figma-token']]);
  for (const x of [r, both]) assert.ok(!(x.stdout + x.stderr).includes(REMOTE_HOST), 'never the URL');
});

function shapeRepoStaged() {
  const dir = repo({ env: '' });
  write(dir, 'test/api.md', `# api\ntoken ${SHAPE['github-token']}\n`); git(dir, 'add', 'test/api.md');
  return dir;
}

test('--hook + a terminal: "n" refuses through the installed hook contract (exit 1, "result":"LEAK", reason declined)', () => {
  const r = scan(shapeRepoStaged(), 'staged', { args: ['--hook', '--project', ''], env: { AGENTEX_SECRET_SCAN_TTY: answerFile('n\n') } });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.lines.length, 1);
  assert.ok(r.stdout.includes('"result":"LEAK"'), 'the marker the installed hook greps for');
  assert.deepStrictEqual([r.json.result, r.json.exit, r.json.reason], ['LEAK', 1, 'declined']);
  assert.deepStrictEqual(r.json.findings, [{ severity: 'warn', kind: 'credential-shape', file: 'test/api.md', line: 2, pattern: 'github-token' }]);
  assert.deepStrictEqual([r.json.counts.leaks, r.json.counts.warnings], [0, 1]);
  assert.ok(r.stderr.includes(QUESTION), r.stderr);
  assert.match(r.stderr, /commit REFUSED/);
});

test('--hook + a terminal: Enter (empty) and anything but y/yes are the default No', () => {
  for (const a of ['\n', 'nope\n', 'yy\n']) {
    const r = scan(shapeRepoStaged(), 'staged', { args: ['--hook'], env: { AGENTEX_SECRET_SCAN_TTY: answerFile(a) } });
    assert.deepStrictEqual([r.status, r.json.reason], [1, 'declined'], JSON.stringify(a));
  }
});

test('--hook + a terminal that gives no answer at all (end of input): nobody answered, the commit proceeds', () => {
  const r = scan(shapeRepoStaged(), 'staged', { args: ['--hook'], env: { AGENTEX_SECRET_SCAN_TTY: answerFile('') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.result, 'WARN');
  assert.ok(!('reason' in r.json));
  assert.match(r.stderr, /no answer could be read/);
});

test('--hook + a terminal: "y" → exit 0 with the warnings, the commit proceeds', () => {
  for (const a of ['y\n', 'YES\r\n']) {
    const r = scan(shapeRepoStaged(), 'staged', { args: ['--hook'], env: { AGENTEX_SECRET_SCAN_TTY: answerFile(a) } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.result, 'WARN');
    assert.ok(!('reason' in r.json));
    assert.ok(r.stderr.includes(QUESTION));
    assert.ok(!/commit REFUSED/.test(r.stderr));
  }
});

test('--hook without a terminal (IDE button, CI) → exit 0 with the warnings, nothing asked', () => {
  const r = scan(shapeRepoStaged(), 'staged', { args: ['--hook'] });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.json.result, 'WARN');
  assert.ok(!r.stderr.includes(QUESTION));
  assert.match(r.stderr, /no terminal/);
});

// POSIX only: a detached child has no controlling terminal, so /dev/tty cannot open.
if (process.platform !== 'win32') test('--hook with no controlling terminal at all (real /dev/tty unavailable) → exit 0, never waits', () => {
  const dir = shapeRepoStaged();
  const env = baseEnv(); delete env.AGENTEX_SECRET_SCAN_TTY;
  const r = spawnSync(process.execPath, [CLI, '--staged', '--hook'], { cwd: dir, encoding: 'utf8', env, detached: true, timeout: 30000 });
  ALL_OUTPUT.push(r.stdout, r.stderr);
  assert.strictEqual(r.status, 0, `${r.error || ''} ${r.stderr}`);
  assert.strictEqual(JSON.parse(r.stdout).result, 'WARN');
  assert.ok(!r.stderr.includes(QUESTION));
});

test('no question outside --hook, for a leak (refused anyway), or for non-shape warnings only', () => {
  const no = { AGENTEX_SECRET_SCAN_TTY: answerFile('n\n') };
  const plain = scan(shapeRepoStaged(), 'staged', { env: no });
  assert.deepStrictEqual([plain.status, plain.json.result], [0, 'WARN']);
  assert.ok(!plain.stderr.includes(QUESTION));
  const dir = repo({ env: `API_TOKEN=${S.token}\n` });
  write(dir, 'a.md', `${S.token}\n${SHAPE['aws-access-key-id']}\n`); git(dir, 'add', 'a.md');
  const leak = scan(dir, 'staged', { args: ['--hook'], env: no });
  assert.deepStrictEqual([leak.status, leak.json.result, leak.json.reason], [1, 'LEAK', undefined]);
  assert.ok(!leak.stderr.includes(QUESTION));
  const fields = repo({ env: '' });
  write(fields, 'environments/qc.json', { api: { token: 'plain' } }); git(fields, 'add', '-A');
  const warn = scan(fields, 'staged', { args: ['--hook'], env: no });
  assert.deepStrictEqual([warn.status, warn.json.result], [0, 'WARN']);
  assert.ok(!warn.stderr.includes(QUESTION));
});

test('real commit through the installed hook template (unchanged, v1): n refuses, y and no terminal commit', () => {
  const hookLib = require('./lib/precommit_hook.js');
  assert.strictEqual(hookLib.TEMPLATE_VERSION, 1, 'no hook version bump, no re-install');
  const home = tmp();
  const env = baseEnv({ HOME: home, USERPROFILE: home });
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_')) delete env[k];
  const commit = (dir, tty) => {
    const r = spawnSync('git', ['-c', 'user.email=qa@example.test', '-c', 'user.name=QA', 'commit', '-m', 'x'],
      { cwd: dir, encoding: 'utf8', env: { ...env, AGENTEX_SECRET_SCAN_TTY: tty } });
    ALL_OUTPUT.push(r.stdout, r.stderr);
    return r;
  };
  const count = (dir) => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
  for (const [tty, committed] of [[answerFile('n\n'), false], [answerFile('y\n'), true], ['none', true]]) {
    const dir = shapeRepoStaged();
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'),
      hookLib.renderHook({ projectPrefix: '', cacheParent: '', installRoot: PLUGIN_ROOT, nodePath: process.execPath }), { mode: 0o755 });
    const before = count(dir);
    const r = commit(dir, tty);
    assert.ok(!/did NOT run/.test(r.stderr), r.stderr);
    assert.match(r.stderr, /WARN test\/api\.md:2 /);
    assert.strictEqual(count(dir) === before + 1, committed, `${path.basename(tty)}: ${r.stderr}`);
    assert.strictEqual(r.status === 0, committed);
  }
});

test('sentinel: no secret value and no remote URL ever reached stdout or stderr, in any case', () => {
  const all = ALL_OUTPUT.join('\n');
  assert.ok(ALL_OUTPUT.length > 40, 'the cases above ran');
  for (const v of Object.values(S)) assert.ok(!all.includes(v), `${v.slice(0, 22)}… never printed`);
  for (const [label, v] of Object.entries(SHAPE)) assert.ok(!all.includes(v), `the planted ${label} never printed`);
  assert.ok(!all.includes(fill(36)), 'not even a token body');
  assert.ok(!all.includes(SHORT), 'the short sentinel never printed');
  assert.ok(!all.includes(REMOTE_HOST), 'no remote URL printed');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
