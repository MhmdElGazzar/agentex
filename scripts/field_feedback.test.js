'use strict';
// Tests for scripts/field_feedback.js — the consumer CLI behind the field-feedback skill
// (field-feedback-loop). S-1: `capture` and `forks`. Later packages append their verbs'
// tests to this file.
// Run: node scripts/field_feedback.test.js
// Offline. The script is spawned as a child process (test-side only); the sentinels that
// look like credentials are built at runtime from parts so lint never sees a shape.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'field_feedback.js');
const L = require('./lib/learnings.js');
const { run } = require('./field_feedback.js');
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ff-'));
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}
const learnings = (dir) => path.join(dir, L.FILE_REL);
const baseEnv = () => { const e = { ...process.env }; delete e.AGENTEX_CI; return e; };
function cli(dir, args, input, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, input: input === undefined ? '' : input, encoding: 'utf8', env: env || baseEnv() });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { /* not JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, lines: r.stdout.trim() === '' ? 0 : r.stdout.trim().split(/\r?\n/).length };
}
const payload = (o = {}) => JSON.stringify({ problem: 'The skill could not attach steps.', workaround: 'Called the CLI directly.', ...o });
const capture = (dir, extra = [], input = payload(), env) => cli(dir, ['capture', '--trigger', 'workaround', '--affected', 'test-design', ...extra], input, env);
// Every file under dir with its bytes, for byte-identity snapshots (directories are not files).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}
const parts = (...p) => p.join('');
const LONG = parts('EVAL_SENTINEL_', 'LONGVALUE_', '9f8e7d6c5b');       // 8+ chars: a substring needle
const SHORT = parts('Zq7', '!x');                                       // 5 chars: label-context only
const SHAPE = parts('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'); // a GitHub token shape
function secretProject() {
  const dir = tmp();
  write(dir, '.env', `API_TOKEN=${LONG}\nADMIN_PASSWORD=${SHORT}\nJIRA_EMAIL=someone@example.test\n`);
  write(dir, 'config/project.json', JSON.stringify({ login: { password: { envSecret: 'ADMIN_PASSWORD' } } }));
  return dir;
}

(async () => {
  await test('capture: appends exactly one entry, creates the file with its header; one JSON line, exit 0', async () => {
    const dir = tmp();
    const r = capture(dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines, 1);
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual([r.json.tool, r.json.schemaVersion, r.json.verb, r.json.result], ['agentex-field-feedback', 1, 'capture', 'OK']);
    assert.strictEqual(r.json.file, '.agentex/plugin-learnings.md');
    assert.strictEqual(r.json.created, true);
    assert.strictEqual(r.json.affectedCoerced, false);
    assert.strictEqual(r.json.redacted, 0);
    assert.strictEqual(r.json.valueCheck, 'skipped');
    const text = fs.readFileSync(learnings(dir), 'utf8');
    assert.ok(text.startsWith('<!-- agentex:plugin-learnings schemaVersion=1 -->\n'));
    const p = L.parse(Buffer.from(text));
    assert.strictEqual(p.entries.length, 1);
    const e = p.entries[0];
    assert.strictEqual(e.id, r.json.id);
    assert.match(e.id, /^PL-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    assert.strictEqual(e.date, new Date().toISOString().slice(0, 10));
    assert.deepStrictEqual([e.trigger, e.affected, e.status], ['workaround', 'test-design', 'open']);
    assert.strictEqual(e.fields.mode, 'sequential');
  });

  await test('capture: the version in the entry is the installed manifest version', async () => {
    const dir = tmp();
    capture(dir);
    assert.strictEqual(L.parse(fs.readFileSync(learnings(dir))).entries[0].version, PLUGIN_VERSION);
    // a different plugin root: its own manifest wins (in-process seam)
    const plugin = tmp();
    write(plugin, '.claude-plugin/plugin.json', JSON.stringify({ name: 'agentex', version: '7.8.9' }));
    write(plugin, 'skills/only-skill/SKILL.md', '---\nname: only-skill\n---\n');
    const dir2 = tmp();
    const r = await run(['capture', '--trigger', 'workaround', '--affected', 'only-skill'], { cwd: dir2, pluginRoot: plugin, stdin: payload(), env: {} });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const e = L.parse(fs.readFileSync(learnings(dir2))).entries[0];
    assert.deepStrictEqual([e.version, e.affected], ['7.8.9', 'only-skill']);
  });

  await test('capture: an unknown affected name is coerced to unknown and flagged; agentex: prefix and commands are accepted', async () => {
    const dir = tmp();
    const r = capture(dir, [], payload(), undefined);
    assert.strictEqual(r.json.affectedCoerced, false);
    const bad = cli(dir, ['capture', '--trigger', 'workaround', '--affected', 'no-such-skill'], payload());
    assert.strictEqual(bad.status, 0);
    assert.strictEqual(bad.json.affectedCoerced, true);
    const unk = cli(dir, ['capture', '--trigger', 'workaround', '--affected', 'unknown'], payload());
    assert.strictEqual(unk.json.affectedCoerced, false);
    const pre = cli(dir, ['capture', '--trigger', 'workaround', '--affected', 'agentex:update-agentex'], payload());
    assert.strictEqual(pre.json.affectedCoerced, false);
    const affected = L.parse(fs.readFileSync(learnings(dir))).entries.map((e) => e.affected);
    assert.deepStrictEqual(affected, ['test-design', 'unknown', 'unknown', 'update-agentex']);
  });

  await test('capture: a bad trigger, a bad mode, a bad path or rule is exit 2 and nothing is written', async () => {
    const dir = tmp();
    const cases = [
      ['capture', '--trigger', 'whenever', '--affected', 'unknown'],
      ['capture', '--affected', 'unknown'],
      ['capture', '--trigger', 'workaround'],
      ['capture', '--trigger', 'workaround', '--affected', 'unknown', '--mode', 'turbo'],
      ['capture', '--trigger', 'self-written-script', '--affected', 'unknown', '--script', '/etc/passwd'],
      ['capture', '--trigger', 'self-written-script', '--affected', 'unknown', '--script', '../outside.js'],
      ['capture', '--trigger', 'forked-skill', '--affected', 'unknown', '--fork', 'C:\\skills\\x'],
      ['capture', '--trigger', 'workaround', '--affected', 'unknown', '--rule', 'README.md'],
    ];
    for (const args of cases) {
      const r = cli(dir, args, payload());
      assert.strictEqual(r.status, 2, `${args.join(' ')} -> ${r.stdout}`);
      assert.strictEqual(r.json.result, 'BLOCKED');
      assert.strictEqual(r.lines, 1);
    }
    assert.deepStrictEqual(snapshot(dir), {});
  });

  await test('capture: stdin must be JSON with a problem and a workaround (exit 2); the error never echoes the input', async () => {
    const dir = tmp();
    for (const input of ['', 'not json', '{"problem":"p"}', '{"problem":"p","workaround":"  "}', '{"problem":1,"workaround":"w"}', '[]']) {
      const r = capture(dir, [], input);
      assert.strictEqual(r.status, 2, `${JSON.stringify(input)} -> ${r.stdout}`);
      assert.strictEqual(r.json.reason, 'usage');
    }
    const secretInput = `{"problem":"${LONG} broken`;
    const r = capture(dir, [], secretInput);
    assert.strictEqual(r.status, 2);
    assert.ok(!r.stdout.includes(LONG) && !r.stderr.includes(LONG));
    assert.deepStrictEqual(snapshot(dir), {});
  });

  await test('capture: a .env value (long), a label-context short value and a token shape reach no file, stdout or stderr', async () => {
    const dir = secretProject();
    const text = `Login failed. token ${LONG} was sent; password: ${SHORT} was typed; also ${SHAPE} appeared.`;
    const r = capture(dir, ['--session', `s-${LONG}`, '--script', `tools/${SHORT}.js`],
      payload({ problem: text, workaround: `Used ${LONG} directly\nand "password": "${SHORT}"` }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.json.valueCheck, 'ran');
    assert.ok(r.json.redacted >= 5, `redacted ${r.json.redacted}`);
    const file = fs.readFileSync(learnings(dir), 'utf8');
    for (const secret of [LONG, SHAPE, `password: ${SHORT}`, `"password": "${SHORT}"`]) {
      assert.ok(!file.includes(secret), 'not in the file');
      assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'not in stdout/stderr');
    }
    assert.ok(file.includes('{env:API_TOKEN}'), 'a long value becomes {env:NAME}');
    assert.ok(file.includes('{env:ADMIN_PASSWORD}'), 'a labelled short value becomes {env:NAME}');
    assert.ok(file.includes('<secret>'), 'a token shape becomes <secret>');
  });

  await test('capture: a short value with no label context is NOT replaced (no false positives on 5-char words)', async () => {
    const dir = secretProject();
    const r = capture(dir, [], payload({ problem: `The word ${SHORT} appears alone, and ${SHORT}s too.` }));
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(learnings(dir), 'utf8').includes(`The word ${SHORT} appears alone`));
  });

  await test('capture: a value that exists only in the process environment, named by an envSecret reference, is redacted', async () => {
    const dir = tmp();
    write(dir, 'environments/qc.json', JSON.stringify({ users: { admin: { password: { envSecret: 'QC_ADMIN_SECRET' } } } }));
    const value = parts('only-in-', 'process-env-', '42xyz');
    const r = capture(dir, [], payload({ problem: `it broke with ${value}` }), { ...baseEnv(), QC_ADMIN_SECRET: value });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json.valueCheck, 'ran');
    const file = fs.readFileSync(learnings(dir), 'utf8');
    assert.ok(!file.includes(value));
    assert.ok(file.includes('{env:QC_ADMIN_SECRET}'));
  });

  await test('capture: tree snapshot — only the learnings file appears; pre-existing bytes identical; no lock left; no network or git touched', async () => {
    const dir = secretProject();
    write(dir, 'CLAUDE.md', '# mine\n');
    write(dir, 'test/a.md', 'spec\n');
    const before = snapshot(dir);
    const r = capture(dir);
    assert.strictEqual(r.status, 0);
    const after = snapshot(dir);
    for (const k of Object.keys(before)) assert.strictEqual(after[k], before[k], `${k} identical`);
    assert.deepStrictEqual(Object.keys(after).filter((k) => !(k in before)), ['.agentex/plugin-learnings.md']);
    const second = capture(dir);
    assert.strictEqual(second.json.created, false);
    const text = fs.readFileSync(learnings(dir), 'utf8');
    assert.strictEqual(L.parse(Buffer.from(text)).entries.length, 2);
  });

  await test('capture: under AGENTEX_CI=1 the mode is forced to ci whatever --mode says', async () => {
    const dir = tmp();
    const r = capture(dir, ['--mode', 'parallel'], payload(), { ...baseEnv(), AGENTEX_CI: '1' });
    assert.strictEqual(r.status, 0, r.stdout);
    assert.strictEqual(L.parse(fs.readFileSync(learnings(dir))).entries[0].fields.mode, 'ci');
    const normal = tmp();
    capture(normal, ['--mode', 'parallel', '--session', 'run-7']);
    const e = L.parse(fs.readFileSync(learnings(normal))).entries[0];
    assert.deepStrictEqual([e.fields.mode, e.fields.session], ['parallel', 'run-7']);
  });

  await test('capture: --script, --fork and --rule are recorded as given; multi-line text keeps its lines', async () => {
    const dir = tmp();
    const r = cli(dir, ['capture', '--trigger', 'forked-skill', '--affected', 'task-estimation', '--fork', '.claude/skills/task-estimation/', '--script', 'tools\\probe.js', '--rule', 'CLAUDE.md'],
      payload({ problem: 'line one\nline two' }));
    assert.strictEqual(r.status, 0, r.stdout);
    const e = L.parse(fs.readFileSync(learnings(dir))).entries[0];
    assert.deepStrictEqual([e.trigger, e.fields.fork, e.fields.script, e.fields.rule, e.fields.problem], ['forked-skill', '.claude/skills/task-estimation/', 'tools/probe.js', 'CLAUDE.md', 'line one\nline two']);
  });

  await test('capture: 20 concurrent processes give 20 intact entries and one header; sentinels redacted in each', async () => {
    const dir = secretProject();
    const kids = [];
    for (let i = 0; i < 20; i++) {
      kids.push(new Promise((resolve) => {
        const c = spawn(process.execPath, [SCRIPT, 'capture', '--trigger', 'workaround', '--affected', 'test-design', '--mode', 'parallel', '--session', `s${i}`], { cwd: dir, env: baseEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
        c.on('close', (status) => resolve({ status, out, err }));
        c.stdin.end(payload({ problem: `child ${i} saw ${LONG}`, workaround: `child ${i}\npassword: ${SHORT}` }));
      }));
    }
    const res = await Promise.all(kids);
    res.forEach((r, i) => { assert.strictEqual(r.status, 0, `child ${i}: ${r.out}${r.err}`); assert.strictEqual(r.err, ''); });
    const file = fs.readFileSync(learnings(dir), 'utf8');
    const p = L.parse(Buffer.from(file));
    assert.strictEqual(p.entries.length, 20);
    assert.strictEqual(p.unparsed, 0);
    assert.strictEqual(file.split('\n').filter((l) => l.startsWith('<!-- agentex:plugin-learnings')).length, 1);
    assert.strictEqual(new Set(p.entries.map((e) => e.id)).size, 20);
    for (let i = 0; i < 20; i++) assert.ok(p.entries.some((e) => e.fields.session === `s${i}` && e.fields.problem === `child ${i} saw {env:API_TOKEN}`), `child ${i} intact`);
    assert.ok(!file.includes(LONG) && !file.includes(`password: ${SHORT}`));
    assert.ok(res.every((r) => !r.out.includes(LONG)));
  });

  await test('capture: a lock held past the wait is exit 1 lock-busy and nothing is written', async () => {
    const dir = tmp();
    write(dir, L.LOCK_REL, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'x' }));
    const r = await run(['capture', '--trigger', 'workaround', '--affected', 'unknown'], { cwd: dir, stdin: payload(), env: {}, lockWaitMs: 60, lockRetryMs: 10 });
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual([r.out.result, r.out.reason], ['ERROR', 'lock-busy']);
    assert.ok(!fs.existsSync(learnings(dir)));
  });

  await test('capture: a newer-schema file is exit 2 newer-schema; the file is untouched', async () => {
    const dir = tmp();
    const body = '<!-- agentex:plugin-learnings schemaVersion=2 -->\n# t\n';
    write(dir, L.FILE_REL, body);
    const r = capture(dir);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.json.reason, 'newer-schema');
    assert.strictEqual(fs.readFileSync(learnings(dir), 'utf8'), body);
  });

  await test('every verb except capture refuses under AGENTEX_CI=1 with exit 2 ci-mode; an unknown verb is exit 2', async () => {
    const dir = tmp();
    const ci = { ...baseEnv(), AGENTEX_CI: '1' };
    const r = cli(dir, ['forks'], '', ci);
    assert.strictEqual(r.status, 2);
    assert.deepStrictEqual([r.json.verb, r.json.result, r.json.reason], ['forks', 'BLOCKED', 'ci-mode']);
    const u = cli(dir, ['frobnicate'], '');
    assert.strictEqual(u.status, 2);
    assert.strictEqual(u.json.reason, 'usage');
    const none = cli(dir, [], '');
    assert.strictEqual(none.status, 2);
    assert.strictEqual(none.lines, 1);
  });

  await test('forks: by name, by self-description, a negative; the exposed plugin name is P; read-only', async () => {
    const dir = tmp();
    write(dir, '.claude/skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: our weights\n---\n');
    write(dir, '.claude/skills/our-design/SKILL.md', '---\nname: our-design\ndescription: Overrides test-design for our team\n---\n');
    write(dir, '.claude/skills/unrelated/SKILL.md', '---\nname: unrelated\ndescription: Replaces manual steps\n---\n');
    const before = snapshot(dir);
    const r = cli(dir, ['forks']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines, 1);
    assert.deepStrictEqual(r.json.forks.map((f) => [f.plugin, f.rule, f.path]).sort(), [
      ['task-estimation', 'name', '.claude/skills/task-estimation/'],
      ['test-design', 'self-described', '.claude/skills/our-design/'],
    ]);
    assert.deepStrictEqual(snapshot(dir), before, 'forks writes nothing');
    const none = cli(tmp(), ['forks']);
    assert.deepStrictEqual(none.json.forks, []);
  });

  // ---- S-2: export ---------------------------------------------------------------------------
  const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const exportCli = (dir, env) => cli(dir, ['export'], '', env);
  const exportFiles = (dir) => { const d = path.join(dir, '.agentex', 'scratch', 'field-feedback'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith('export-')) : []; };
  // A git project that ignores scratch, with two open entries (one carrying every sentinel) and one absorbed.
  function exportProject({ ignore = true } = {}) {
    const dir = tmp();
    git(dir, ['init', '-q']);
    if (ignore) write(dir, '.gitignore', '.env\n.agentex/scratch/\n');
    write(dir, '.env', `API_TOKEN=${LONG}\n`);
    write(dir, 'config/project.json', { azure: { org: 'SentinelOrgExport', project: 'SentinelProjExport' } });
    write(dir, 'environments/qc.json', { portalUrl: 'https://portal.sentinel-export.test/app', users: { sentineladmin: { password: { envSecret: 'ADMIN_PASSWORD' } } }, defaults: { otp: 'SentinelOtpExport' } });
    write(dir, 'test/test-data/d.json', { n: 'SentinelDataExport' });
    const head = '<!-- agentex:plugin-learnings schemaVersion=1 -->\n# t\n\n';
    write(dir, L.FILE_REL, `${head}` +
      `- [ ] PL-20261022T101500Z-7f3a · 2026-10-22 · workaround · test-design · v0.26.0\n  problem: Failed on SentinelOrgExport with ${LONG} at https://docs.elsewhere.org/x and mail me@elsewhere.org\n    second line from 10.9.8.7 in /opt/acme/run.sh\n  workaround: typed SentinelOtpExport as sentineladmin\n  script: tools/probe-sentinel.js\n  fork: .claude/skills/x/\n  session: s-1\n` +
      `- [x] PL-20261020T091200Z-c41e · 2026-10-20 · forked-skill · task-estimation · v0.25.0 · absorbed in v0.26.0\n  problem: ABSORBED-ENTRY-MARKER\n  workaround: w\n` +
      `- [ ] PL-20261021T091200Z-0a0b · 2026-10-21 · repeated-correction · unknown · v0.25.0\n  problem: Second open entry about SentinelDataExport\n  workaround: fixed it\n`);
    write(dir, '.claude/skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: ours\n---\n');
    return dir;
  }

  await test('export: writes exactly ONE git-ignored file under .agentex/scratch/field-feedback/, open entries only, plugin names for forks, version and schemaVersion', async () => {
    const dir = exportProject();
    const before = snapshot(dir);
    const r = exportCli(dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.lines, 1);
    assert.strictEqual(r.stderr, '');
    assert.deepStrictEqual([r.json.verb, r.json.result, r.json.entries, r.json.forkedSkills], ['export', 'OK', 2, 1]);
    const files = exportFiles(dir);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^export-\d{8}T\d{6}Z\.md$/);
    assert.strictEqual(r.json.file, `.agentex/scratch/field-feedback/${files[0]}`);
    assert.strictEqual(git(dir, ['check-ignore', '-q', r.json.file]).status, 0, 'git ignores the export');
    const after = snapshot(dir);
    for (const k of Object.keys(before)) assert.strictEqual(after[k], before[k], `${k} byte-identical`);
    assert.deepStrictEqual(Object.keys(after).filter((k) => !(k in before)), [r.json.file], 'exactly one new file');
    const md = fs.readFileSync(path.join(dir, r.json.file), 'utf8');
    assert.ok(md.startsWith(`<!-- agentex:field-feedback-export schemaVersion=1 plugin=agentex@${PLUGIN_VERSION} -->\n`));
    assert.ok(md.includes('## Open learnings (2)'));
    assert.ok(md.includes('PL-20261022T101500Z-7f3a') && md.includes('PL-20261021T091200Z-0a0b'));
    assert.ok(!md.includes('ABSORBED-ENTRY-MARKER') && !md.includes('PL-20261020T091200Z-c41e'), 'absorbed entries are not exported');
    assert.ok(md.includes('## Forked plugin skills (names only)\n- task-estimation\n'));
    assert.ok(!md.includes('.claude/skills'), 'the fork path stays local');
    for (const dropped of ['probe-sentinel', 'tools/', 'session', 'fork:', 'script:']) assert.ok(!md.includes(dropped), `${dropped} is not exported`);
  });

  await test('export: every sentinel category becomes its placeholder; counts, never values, in the file, the JSON line and stderr', async () => {
    const dir = exportProject();
    const r = exportCli(dir);
    assert.strictEqual(r.status, 0, r.stdout);
    const md = fs.readFileSync(path.join(dir, r.json.file), 'utf8');
    const values = [LONG, 'SentinelOrgExport', 'SentinelOtpExport', 'sentineladmin', 'SentinelDataExport', 'docs.elsewhere.org', 'me@elsewhere.org', '10.9.8.7', '/opt/acme', 'portal.sentinel-export.test'];
    for (const v of values) assert.ok(!md.includes(v), `${v} is not in the file`);
    for (const v of values) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), `${v} is not in the JSON line or stderr`);
    for (const ph of ['<secret>', '<org-name>', '<test-data>', '<user-name>', '<url>', '<email>', '<ip>', '<path>']) assert.ok(md.includes(ph), ph);
    assert.ok(r.json.counts.secret >= 1 && r.json.counts['org-name'] >= 1 && r.json.counts.url >= 1 && r.json.counts.email >= 1 && r.json.counts.ip >= 1 && r.json.counts.path >= 1);
    assert.ok(Object.values(r.json.counts).every((n) => Number.isInteger(n)));
    assert.match(md, /Replaced before export: .*\d+ secret.* \(values are never shown\)\./);
    assert.ok(md.includes('Secret value check: ran.'));
    assert.ok(md.indexOf('Review before sending') > 0 && md.includes('best effort') && md.includes('The destination is public'));
    assert.ok(md.includes(`(https://github.com/MhmdElGazzar/agentex/issues/new?labels=field-feedback)`), 'the destination link comes from plugin.json');
  });

  await test('export: the target must be git-ignored (not-ignored, exit 2, no file); outside a git repo the check does not apply', async () => {
    const dir = exportProject({ ignore: false });
    const r = exportCli(dir);
    assert.strictEqual(r.status, 2);
    assert.deepStrictEqual([r.json.result, r.json.reason], ['BLOCKED', 'not-ignored']);
    assert.ok(/update-agentex/.test(r.json.error.message));
    assert.deepStrictEqual(exportFiles(dir), []);
    const plain = exportProject();
    fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true });
    const ok = exportCli(plain);
    assert.strictEqual(ok.status, 0, ok.stdout);
  });

  await test('export: zero open entries (or no file, or only forks) is NOTHING_TO_EXPORT, exit 0, no file', async () => {
    const none = tmp();
    const a = exportCli(none);
    assert.deepStrictEqual([a.status, a.json.result], [0, 'NOTHING_TO_EXPORT']);
    const forksOnly = tmp();
    write(forksOnly, '.claude/skills/test-design/SKILL.md', '---\nname: test-design\n---\n');
    assert.strictEqual(exportCli(forksOnly).json.result, 'NOTHING_TO_EXPORT');
    const absorbed = tmp();
    write(absorbed, L.FILE_REL, '<!-- agentex:plugin-learnings schemaVersion=1 -->\n- [x] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0 · absorbed in v0.2.0\n  problem: p\n  workaround: w\n');
    const c = exportCli(absorbed);
    assert.strictEqual(c.json.result, 'NOTHING_TO_EXPORT');
    for (const d of [none, forksOnly, absorbed]) assert.deepStrictEqual(exportFiles(d), []);
  });

  await test('export: each hard-stop cause exits 2 with its reason and writes no file', async () => {
    const stop = (dir, reason, runner) => {
      const r = runner ? runner(dir) : exportCli(dir);
      assert.strictEqual(r.status === undefined ? r.code : r.status, 2, `${reason}: ${JSON.stringify(r.json || r.out)}`);
      assert.strictEqual((r.json || r.out).reason, reason);
      assert.deepStrictEqual(exportFiles(dir), [], `${reason}: no file`);
    };
    const a = exportProject(); write(a, 'config/project.json', '{ nope'); stop(a, 'config-unparseable');
    const b = exportProject(); write(b, 'environments/qc.json', '{ nope'); stop(b, 'environment-unparseable');
    const c = exportProject(); write(c, L.FILE_REL, '<!-- agentex:plugin-learnings schemaVersion=3 -->\n- [ ] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0\n  problem: p\n  workaround: w\n'); stop(c, 'newer-schema');
    const d = exportProject({ ignore: false }); stop(d, 'not-ignored');
    // residue: a verify-only needle the layers do not replace (in-process seam)
    const e = exportProject();
    const rr = await run(['export'], { cwd: e, env: {}, sanitize: { verifyOnly: ['Second open entry'] } });
    assert.strictEqual(rr.code, 2); assert.strictEqual(rr.out.reason, 'residue');
    assert.ok(!JSON.stringify(rr.out).includes('Second open entry'), 'the residue is never named');
    assert.deepStrictEqual(exportFiles(e), []);
    // core-unavailable: a plugin copy without the secret-scan core
    const copy = tmp();
    for (const rel of ['scripts/field_feedback.js', 'scripts/lib/learnings.js', 'scripts/lib/plugin_inventory.js', 'scripts/lib/feedback_sanitize.js', 'scripts/lib/version.js', 'scripts/lib/git_plumbing.js', '.claude-plugin/plugin.json']) {
      write(copy, rel, fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    }
    const f = exportProject();
    const r = spawnSync(process.execPath, [path.join(copy, 'scripts', 'field_feedback.js'), 'export'], { cwd: f, encoding: 'utf8', env: baseEnv() });
    assert.strictEqual(r.status, 2); assert.strictEqual(JSON.parse(r.stdout).reason, 'core-unavailable');
    assert.deepStrictEqual(exportFiles(f), []);
    const cap = spawnSync(process.execPath, [path.join(copy, 'scripts', 'field_feedback.js'), 'capture', '--trigger', 'workaround', '--affected', 'unknown'], { cwd: tmp(), input: payload(), encoding: 'utf8', env: baseEnv() });
    assert.strictEqual(cap.status, 2, 'capture refuses too: nothing is written without the secret layer');
  });

  await test('export: no .env is stated (skipped) and still exports; no config at all is stated; an integration file that is not JSON is skipped', async () => {
    const dir = tmp();
    write(dir, L.FILE_REL, '<!-- agentex:plugin-learnings schemaVersion=1 -->\n- [ ] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0\n  problem: p\n  workaround: w\n');
    write(dir, 'integration/x_api.json', '{ nope');
    const r = exportCli(dir);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.deepStrictEqual([r.json.valueCheck, r.json.config], ['skipped', 'none']);
    const md = fs.readFileSync(path.join(dir, r.json.file), 'utf8');
    assert.ok(md.includes('Secret value check: skipped — no .env.'));
    assert.ok(md.includes('Config-derived names: not replaced'));
  });

  await test('export: the header carries no link when plugin.json has no repository, never a hard-coded URL', async () => {
    const plugin = tmp();
    write(plugin, '.claude-plugin/plugin.json', JSON.stringify({ name: 'agentex', version: '2.0.0' }));
    const dir = tmp();
    write(dir, L.FILE_REL, '<!-- agentex:plugin-learnings schemaVersion=1 -->\n- [ ] PL-20260101T000000Z-aaaa · 2026-01-01 · workaround · unknown · v0.1.0\n  problem: p\n  workaround: w\n');
    const r = await run(['export'], { cwd: dir, pluginRoot: plugin, env: {} });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const md = fs.readFileSync(path.join(dir, r.out.file), 'utf8');
    assert.ok(md.includes('plugin=agentex@2.0.0'));
    assert.ok(!/https?:\/\//.test(md));
    assert.ok(md.includes('the AgenTeX public issue tracker, label `field-feedback`'));
  });

  await test('export: a second export in the same second never overwrites the first; the export is refused under AGENTEX_CI=1', async () => {
    const dir = exportProject();
    const fixed = () => new Date('2026-10-22T10:15:00Z');
    const a = await run(['export'], { cwd: dir, env: {}, now: fixed });
    const b = await run(['export'], { cwd: dir, env: {}, now: fixed });
    assert.notStrictEqual(a.out.file, b.out.file);
    assert.strictEqual(exportFiles(dir).length, 2);
    assert.strictEqual(a.out.file, '.agentex/scratch/field-feedback/export-20261022T101500Z.md');
    const ci = exportCli(dir, { ...baseEnv(), AGENTEX_CI: '1' });
    assert.deepStrictEqual([ci.status, ci.json.reason], [2, 'ci-mode']);
  });

  await test('export: the in-memory payload is the frozen shape and the markdown is its rendering', async () => {
    const S = require('./lib/feedback_sanitize.js');
    const dir = exportProject();
    const ctx = S.buildContext(dir, { pluginRoot: path.join(__dirname, '..'), env: {} });
    const parsed = L.parse(fs.readFileSync(path.join(dir, L.FILE_REL))).entries.filter((e) => e.status === 'open');
    const results = parsed.map((e) => S.sanitizeEntry(e, ctx));
    const payload = S.buildPayload({ plugin: { name: 'agentex', version: PLUGIN_VERSION }, entries: results.map((x) => x.entry), forkedSkills: ['task-estimation'], counts: S.sumCounts(results.map((x) => x.counts)) });
    assert.deepStrictEqual(Object.keys(payload), ['tool', 'schemaVersion', 'plugin', 'entries', 'forkedSkills', 'sanitization']);
    const md = S.renderExport(payload, { valueCheck: ctx.valueCheck, configFound: ctx.configFound });
    for (const e of payload.entries) assert.ok(md.includes(`- ${e.id} · ${e.date} · ${e.trigger} · ${e.affected} · v${e.version}`));
  });

  await test('structural: no network module and no process.exit in field_feedback.js', async () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|tls|dgram)['"]\)/.test(src));
    assert.ok(!src.includes('process.exit('));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
