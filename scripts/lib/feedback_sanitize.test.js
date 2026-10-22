'use strict';
// Unit tests for scripts/lib/feedback_sanitize.js — the export sanitizer, layers 1-4
// (field-feedback-loop S-2; spec appendix A4).
// Run: node scripts/lib/feedback_sanitize.test.js
// Offline. Values that look like credentials are built at runtime from parts.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./feedback_sanitize.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-fsan-'));
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}
const parts = (...p) => p.join('');
const ENV_SECRET = parts('SENTINEL_', 'SECRET_', 'VALUE_77');
const OPTS = { pluginRoot: PLUGIN_ROOT, env: {}, osUser: 'sentineluser', homeDir: '/home/sentineluser' };
const ctxFor = (dir, extra = {}) => S.buildContext(dir, { ...OPTS, ...extra });
const text = (t, ctx) => { const counts = S.emptyCounts(); const out = S.sanitizeText(t, ctx, counts); return { out, counts }; };

// A project carrying one sentinel per category.
function sentinelProject() {
  const dir = tmp();
  write(dir, '.env', `API_TOKEN=${ENV_SECRET}\n`);
  write(dir, 'config/project.json', {
    name: 'ZebraPortalSentinel',
    azure: { org: 'SentinelOrgAzure', project: 'SentinelProjAzure', team: 'SentinelTeamAzure', areaPath: 'SentinelProjAzure\\AreaSegmentSentinel', iterationPath: 'SentinelProjAzure\\SprintSegmentSentinel' },
    figma: { fileKey: 'FigmaFileSentinel9', token: { envSecret: 'FIGMA_TOKEN' } },
  });
  write(dir, 'environments/qc.json', {
    portalUrl: 'https://portal.sentinel-env.test/app',
    api: { baseUrl: 'https://api.sentinel-env.test/v1' },
    db: { server: 'sql-sentinel.internal', name: 'SentinelDatabase' },
    users: { sentineladmin: { username: 'sentinel.person@corp.test', password: { envSecret: 'ADMIN_PASSWORD' } } },
    defaults: { otp: 'SentinelOtp99' },
  });
  write(dir, 'test/test-data/people.json', { people: [{ name: 'SentinelPersonName' }] });
  write(dir, 'test/test-data/rows.csv', 'id,city\n1,"Sentinel City, North"\n2,Sentinelville\n');
  return dir;
}
function sentinelJira() {
  const dir = tmp();
  write(dir, 'config/project.json', { jira: { site: 'sentineljirasite', project: 'SNTL', board: 'SentinelBoardName' } });
  return dir;
}

// ---- first test: a sentinel per category + the core import pin ------------------------------
test('the secret-scan core exports every function the sanitizer builds on (import pin)', () => {
  const core = require('./secret_scan_core.js');
  for (const name of ['buildNeedles', 'collectEnvSecretNames', 'canonicalSecretNames', 'labelBeforeValue', 'rightBoundaryOk', 'parseJson', 'remoteHasCredential', 'scanShapes']) {
    assert.strictEqual(typeof core[name], 'function', `${name} is exported`);
  }
  assert.ok(core.DEFAULTS && Number.isInteger(core.DEFAULTS.MIN_VALUE_LENGTH));
  assert.ok(Array.isArray(core.SHAPE_PATTERNS) && core.SHAPE_PATTERNS.every((p) => p.re instanceof RegExp));
});

test('one sentinel per category becomes its placeholder; counts are exact and carry no values', () => {
  const dir = sentinelProject();
  const jiraDir = sentinelJira();
  const ctx = ctxFor(dir); const jctx = ctxFor(jiraDir);
  const git = tmp();
  spawnSync('git', ['init', '-q'], { cwd: git });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/SentinelRemoteOwner/sentinel-remote-repo.git'], { cwd: git });
  const gctx = ctxFor(git);
  const cases = [
    ['secret', ctx, `the token ${ENV_SECRET} leaked`, '<secret>'],
    ['url', ctx, 'see https://docs.elsewhere.org/a/b?q=1 now', '<url>'],
    ['host', ctx, 'it ran on build.corpnet.example today', '<host>'],
    ['ip', ctx, 'connected to 10.20.30.40 fine', '<ip>'],
    ['email', ctx, 'mail someone@elsewhere.org please', '<email>'],
    ['org-name', ctx, 'the SentinelOrgAzure org', '<org-name>'],
    ['project-name', ctx, 'the SentinelProjAzure project', '<project-name>'],
    ['site-name', jctx, 'the sentineljirasite site', '<site-name>'],
    ['env-url', ctx, 'the portal https://portal.sentinel-env.test/app was down', '<env-url>'],
    ['user-name', ctx, 'login as sentineladmin failed', '<user-name>'],
    ['test-data', ctx, 'typed SentinelOtp99 into the field', '<test-data>'],
    ['path', ctx, 'edited /opt/acme/tools/run.sh before', '<path>'],
  ];
  for (const [cat, c, input, placeholder] of cases) {
    const { out, counts } = text(input, c);
    assert.ok(out.includes(placeholder), `${cat}: ${out}`);
    assert.strictEqual(counts[cat], 1, `${cat} count`);
    assert.strictEqual(Object.values(counts).reduce((a, b) => a + b, 0), 1, `${cat}: only its own category counted (${JSON.stringify(counts)})`);
    for (const forbidden of ['SentinelOrgAzure', 'sentineljirasite', 'opt/acme', 'elsewhere.org', '10.20.30.40', ENV_SECRET, 'SentinelOtp99']) assert.ok(!out.includes(forbidden), `${cat}: ${forbidden} gone`);
    assert.ok(!JSON.stringify(counts).match(/[A-Za-z]{6,}\w*":\s*"/), 'counts hold numbers only');
  }
  // remote path segments: org and repo name
  const r = text('cloned SentinelRemoteOwner/sentinel-remote-repo last week', gctx);
  assert.ok(r.out.includes('<org-name>') && r.out.includes('<project-name>'), r.out);
  assert.ok(!/Sentinel(?:Remote|-remote)/i.test(r.out));
  assert.deepStrictEqual(S.CATEGORIES, ['secret', 'url', 'host', 'ip', 'email', 'org-name', 'project-name', 'site-name', 'env-url', 'user-name', 'test-data', 'path']);
});

test('config-derived sources: tracker segments, figma, db, users and defaults leaves, test-data JSON and CSV, root name, OS user and home', () => {
  const dir = sentinelProject();
  const ctx = ctxFor(dir);
  const probes = {
    'project-name': ['ZebraPortalSentinel', 'SentinelTeamAzure', 'AreaSegmentSentinel', 'SprintSegmentSentinel', 'FigmaFileSentinel9', path.basename(dir)],
    host: ['sql-sentinel.internal', 'SentinelDatabase'],
    'env-url': ['https://api.sentinel-env.test/v1'],
    'user-name': ['sentineladmin', 'sentineluser'],
    'test-data': ['sentinel.person@corp.test', 'SentinelPersonName', 'Sentinel City, North', 'Sentinelville', 'SentinelOtp99'],
    path: ['/home/sentineluser/work'],
  };
  for (const [cat, list] of Object.entries(probes)) {
    for (const v of list) {
      const { out, counts } = text(`before ${v} after`, ctx);
      assert.ok(counts[cat] >= 1, `${v} -> ${cat}: ${out}`);
      assert.ok(!out.includes(v), `${v} gone: ${out}`);
    }
  }
});

test('an env-var NAME named by an envSecret reference stays in the text; only values go', () => {
  const dir = sentinelProject();
  const { out } = text('set ADMIN_PASSWORD and FIGMA_TOKEN and API_TOKEN in the CI secret store', ctxFor(dir));
  assert.strictEqual(out, 'set ADMIN_PASSWORD and FIGMA_TOKEN and API_TOKEN in the CI secret store');
});

test('longest first: the longer name wins an overlap; the shorter still matches alone; case-insensitive', () => {
  const dir = tmp();
  write(dir, 'config/project.json', { azure: { org: 'Acme', project: 'Acme Corporation' } });
  const ctx = ctxFor(dir);
  const { out, counts } = text('Acme Corporation and ACME alone and acme corporation again', ctx);
  assert.strictEqual(out, '<project-name> and <org-name> alone and <project-name> again');
  assert.strictEqual(counts['project-name'], 2);
  assert.strictEqual(counts['org-name'], 1);
});

test('a name shorter than 3 characters is never a needle', () => {
  const dir = tmp();
  write(dir, 'config/project.json', { azure: { org: 'qa', project: 'ab' } });
  assert.strictEqual(text('qa and ab stay', ctxFor(dir)).out, 'qa and ab stay');
});

test('the extension allowlist keeps report.md and run_api.js; unknown hostnames, localhost and slash commands behave', () => {
  const ctx = ctxFor(tmp());
  assert.strictEqual(text('see report.md and run_api.js, plugin.json, qa-records.js and README.MD', ctx).out, 'see report.md and run_api.js, plugin.json, qa-records.js and README.MD');
  assert.strictEqual(text('host files.internal.example answered', ctx).out, 'host <host> answered');
  const lh = text('http://localhost:3000 and localhost:8080', ctx);
  assert.strictEqual(lh.out, '<url> and <host>:8080');
  assert.strictEqual(text('run /update-agentex then /init-test', ctx).out, 'run /update-agentex then /init-test');
  assert.strictEqual(text('v0.26.0 at 10:15:00 e.g. 1.2.3 and i.e. Node.js', ctx).out, 'v0.26.0 at 10:15:00 e.g. 1.2.3 and i.e. Node.js');
});

test('layer 3 patterns: URL with trailing punctuation, IPv4/IPv6, email, POSIX, home, Windows and UNC paths', () => {
  const ctx = ctxFor(tmp());
  assert.strictEqual(text('open https://x.example.org/a/b?c=d. Then', ctx).out, 'open <url>. Then');
  assert.strictEqual(text('ips 192.168.0.1:8080, 2001:db8::1 and fe80::1', ctx).out, 'ips <ip>, <ip> and <ip>');
  assert.strictEqual(text('999.1.1.1 is not an address', ctx).out, '999.1.1.1 is not an address');
  assert.strictEqual(text('write to ~/work/notes and /var/log/app.log; C:\\Users\\me\\x.txt and \\\\fileserver\\share\\y.txt', ctx).out, 'write to <path> and <path>; <path> and <path>');
  assert.strictEqual(text('relative .agentex/scratch/field-feedback/x and scripts/a.js stay', ctx).out, 'relative .agentex/scratch/field-feedback/x and scripts/a.js stay');
  assert.strictEqual(text('a.b@c.example and "x@y.org"', ctx).out, '<email> and "<email>"');
});

test('export mode uses <secret>; capture mode names the variable', () => {
  const dir = sentinelProject();
  const ctx = ctxFor(dir);
  assert.strictEqual(text(`value ${ENV_SECRET}`, ctx).out, 'value <secret>');
  const l1 = S.redactSecrets(`value ${ENV_SECRET}`, ctx.secret, { named: true });
  assert.strictEqual(l1.text, 'value {env:API_TOKEN}');
});

test('a short value with a password label is replaced; the same value without a label is not', () => {
  const dir = tmp();
  write(dir, '.env', 'ADMIN_PASSWORD=Zq7!x\n');
  write(dir, 'config/project.json', { login: { password: { envSecret: 'ADMIN_PASSWORD' } } });
  const ctx = ctxFor(dir);
  assert.strictEqual(text('password: Zq7!x typed', ctx).out, 'password: <secret> typed');
  assert.strictEqual(text('the word Zq7!x alone', ctx).out, 'the word Zq7!x alone');
});

test('a credential shape is replaced by <secret> even with no .env', () => {
  const ctx = ctxFor(tmp());
  const shape = parts('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  assert.strictEqual(text(`token ${shape} here`, ctx).out, 'token <secret> here');
  assert.strictEqual(ctx.valueCheck, 'skipped');
});

test('a remote URL that carries a credential: the credential part is a secret needle', () => {
  const git = tmp();
  spawnSync('git', ['init', '-q'], { cwd: git });
  const pw = parts('remote', 'pw', 'Sentinel1');
  spawnSync('git', ['remote', 'add', 'origin', `https://someuser:${pw}@git.example.org/Owner/repo.git`], { cwd: git });
  const ctx = ctxFor(git);
  const { out } = text(`pushed with ${pw} to origin`, ctx);
  assert.ok(!out.includes(pw), out);
});

test('residue is a hard stop (exit 2 vocabulary: residue), carrying no value', () => {
  const ctx = ctxFor(tmp(), { verifyOnly: ['forbidden-word'] });
  assert.throws(() => text('contains forbidden-word inside', ctx), (e) => e.reason === 'residue' && e.code === 2 && !/forbidden-word/.test(e.message));
  assert.doesNotThrow(() => text('clean text', ctx));
});

test('findResidue: placeholders are masked so they never count; a leftover needle or pattern does', () => {
  const dir = sentinelProject();
  const ctx = ctxFor(dir);
  assert.strictEqual(S.findResidue('a <project-name> b <secret> c {env:API_TOKEN} d <url> e', ctx), 0);
  assert.ok(S.findResidue('still SentinelOrgAzure here', ctx) > 0);
  assert.ok(S.findResidue('still https://x.example.org here', ctx) > 0);
  assert.ok(S.findResidue(`still ${ENV_SECRET} here`, ctx) > 0);
});

test('unparseable config or environment is a hard stop; an unparseable integration file is skipped; absent config is stated', () => {
  const a = tmp(); write(a, 'config/project.json', '{ not json');
  assert.throws(() => ctxFor(a), (e) => e.reason === 'config-unparseable' && e.code === 2);
  const b = tmp(); write(b, 'environments/qc.json', '{ nope');
  assert.throws(() => ctxFor(b), (e) => e.reason === 'environment-unparseable' && e.code === 2);
  const c = tmp(); write(c, 'integration/x_api.json', '{ nope');
  assert.doesNotThrow(() => ctxFor(c));
  const d = ctxFor(tmp());
  assert.strictEqual(d.configFound, false);
  assert.strictEqual(d.valueCheck, 'skipped');
  assert.strictEqual(d.valueCheckReason, 'no-env-file');
  assert.strictEqual(ctxFor(sentinelProject()).configFound, true);
});

test('sanitizeEntry: fixed fields untouched, script/fork/rule/session dropped, text sanitized, input not mutated', () => {
  const dir = sentinelProject();
  const ctx = ctxFor(dir);
  const entry = {
    id: 'PL-20261022T101500Z-7f3a', date: '2026-10-22', trigger: 'workaround', affected: 'test-design', version: '0.26.0', status: 'open',
    fields: { problem: 'It failed for SentinelOrgAzure', workaround: `used ${ENV_SECRET}`, mode: 'parallel', session: 's-1', script: 'tools/sentinel-probe.js', fork: '.claude/skills/x/', rule: 'CLAUDE.md' },
  };
  const frozen = JSON.stringify(entry);
  const { entry: out, counts } = S.sanitizeEntry(entry, ctx);
  assert.strictEqual(JSON.stringify(entry), frozen, 'input untouched');
  assert.deepStrictEqual(Object.keys(out).sort(), ['affected', 'date', 'id', 'mode', 'problem', 'trigger', 'version', 'workaround']);
  assert.deepStrictEqual([out.id, out.date, out.trigger, out.affected, out.version, out.mode], ['PL-20261022T101500Z-7f3a', '2026-10-22', 'workaround', 'test-design', '0.26.0', 'parallel']);
  assert.strictEqual(out.problem, 'It failed for <org-name>');
  assert.strictEqual(out.workaround, 'used <secret>');
  assert.deepStrictEqual([counts.secret, counts['org-name']], [1, 1]);
});

test('sanitizeEntry: a fixed field outside its vocabulary is sanitized like text instead of trusted', () => {
  const ctx = ctxFor(sentinelProject());
  const { entry, counts } = S.sanitizeEntry({ id: 'PL-20261022T101500Z-7f3a', date: '2026-10-22', trigger: 'workaround', affected: 'SentinelOrgAzure-portal', version: '0.26.0', fields: { problem: 'p', workaround: 'w' } }, ctx);
  assert.ok(!entry.affected.includes('SentinelOrgAzure'));
  assert.ok(counts['org-name'] >= 1);
});

test('sanitizeText keeps non-ASCII and RTL text intact, and a case-fold that changes length does not misalign spans', () => {
  const dir = tmp();
  write(dir, 'config/project.json', { azure: { org: 'SentinelOrg', project: 'x'.repeat(3) } });
  const ctx = ctxFor(dir);
  assert.strictEqual(text('فشل الاختبار — ünï', ctx).out, 'فشل الاختبار — ünï');
  const { out } = text('İİİ İİİ SentinelOrg İİİ', ctx);
  assert.strictEqual(out, 'İİİ İİİ <org-name> İİİ');
});

test('buildPayload: the frozen shape the relay reads; sumCounts adds per category', () => {
  const counts = S.emptyCounts(); counts.secret = 2;
  const payload = S.buildPayload({ plugin: { name: 'agentex', version: '1.0.0' }, entries: [{ id: 'a' }], forkedSkills: ['test-design'], counts });
  assert.deepStrictEqual(Object.keys(payload), ['tool', 'schemaVersion', 'plugin', 'entries', 'forkedSkills', 'sanitization']);
  assert.deepStrictEqual(payload.tool, 'agentex-field-feedback');
  assert.strictEqual(payload.schemaVersion, 1);
  assert.deepStrictEqual(payload.sanitization, { bestEffort: true, counts });
  const sum = S.sumCounts([counts, { ...S.emptyCounts(), secret: 1, url: 4 }]);
  assert.deepStrictEqual([sum.secret, sum.url, sum.host], [3, 4, 0]);
});

test('structural: no network module in feedback_sanitize.js; only learnings.js, the core and git_plumbing are required', () => {
  const src = fs.readFileSync(path.join(__dirname, 'feedback_sanitize.js'), 'utf8');
  assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|tls|dgram|child_process)['"]\)/.test(src));
  assert.ok(!src.includes('process.exit('));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
