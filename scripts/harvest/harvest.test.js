'use strict';
// Tests for scripts/harvest/harvest.js — the maintainer's read-only harvest of the field
// signals in consumer projects (field-feedback-loop S-4; spec appendix A5).
// Run: node scripts/harvest/harvest.test.js
// Offline. Roots are temp folders (one with a real git repository so .git/index and
// .git/config exist). In-process runs wrap fs and the network modules with spies before
// calling run(); the CLI contract is spawned.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'harvest.js');
const harvest = require('./harvest.js');
const REPO = path.resolve(__dirname, '..', '..');
const { STRUCTURED_DEFAULTS } = require('../lib/project_config.js');
const QA_DEFAULT = STRUCTURED_DEFAULTS.qaRecords.pendingQuestions;     // the one home of the default paths

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.stack ? e.message : e}`); }
}

const tmp = (p = 'agentex-harvest-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const real = (p) => fs.realpathSync(p);
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof text === 'string' || Buffer.isBuffer(text) ? text : JSON.stringify(text, null, 2));
}
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
const ENV_SENTINEL = ['HARVEST', 'SENTINEL', 'ENVVALUE', '42'].join('_');
const AUTH_SENTINEL = ['HARVEST', 'SENTINEL', 'AUTHSTATE', '77'].join('_');

// Every file under dir with its bytes and mtime (symlinks by target), .git included.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); }
      else out[rel] = `${fs.readFileSync(p).toString('base64')}@${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

const LEARNINGS = '<!-- agentex:plugin-learnings schemaVersion=1 -->\n# t\n\n' +
  '- [ ] PL-20261022T101500Z-7f3a · 2026-10-22 · workaround · test-design · v0.26.0\n  problem: The skill could not attach steps.\n  workaround: Called the CLI directly.\n' +
  '- [x] PL-20261020T091200Z-c41e · 2026-10-20 · forked-skill · task-estimation · v0.25.0 · absorbed in v0.26.0\n  problem: Needed per-team weights.\n  workaround: Copied the skill.\n' +
  '- [ ] PL-20261021T091200Z-0a0b · 2026-10-21 · repeated-correction · unknown · v0.25.0\n  problem: Repeated correction.\n  workaround: Fixed it.\n';
const BLOCK = '<!-- agentex:begin project-layout v1 hash=abcdefabcdef -->\n| A project rule you believe the AgenTeX plugin itself should adopt | A `CLAUDE.md` bullet outside this block, tagged `[agentex:promote]` |\n<!-- agentex:end project-layout -->\n';

// A consumer project carrying every signal kind plus the places the harvest must never open.
function consumer(name, { gitRepo = true } = {}) {
  const dir = path.join(tmp(), name);
  fs.mkdirSync(dir);
  write(dir, '.agentex/plugin-learnings.md', LEARNINGS);
  write(dir, '.claude/skills/task-estimation/SKILL.md', '---\nname: task-estimation\ndescription: our weights\n---\n');
  write(dir, '.claude/skills/our-design/SKILL.md', '---\nname: our-design\ndescription: Overrides test-design for us\n---\n');
  write(dir, '.claude/skills/unrelated/SKILL.md', '---\nname: unrelated\ndescription: Replaces manual steps\n---\n');
  write(dir, 'CLAUDE.md', `# rules\n- [agentex:promote] always ask for the sprint first\n- candidate for promotion to AgenTeX: name the env in every report\n- we should upstream the retry rule to the agentex plugin\n- an ordinary rule\n${BLOCK}`);
  write(dir, '.claude/CLAUDE.md', '- Promote the login helper to the agentex plugin\n');
  write(dir, 'CLAUDE.local.md', '- nothing here\n');
  write(dir, '.agentex/scripts/helper.js', 'a\nb\nc\n');
  write(dir, '.agentex/scripts/deep/er/x.py', 'print(1)\n');
  write(dir, '.agentex/tool.mjs', 'x\n');
  write(dir, '.agentex/port-list.md', '# Pending changes\n- [ ] port the retry helper to the plugin\n- [x] done item\n- [ ] second open item\n');
  write(dir, 'dev-notes.md', 'we must upstream this\n- [ ] write the upstream issue\n');
  write(dir, 'probe-login.mjs', 'x');
  write(dir, 'explore_page.js', 'x');
  write(dir, 'run-out.txt', 'x');
  write(dir, 'api_dump_1.json', '{}');
  write(dir, 'docs/open-questions.md', 'q1\nq2\n');
  write(dir, QA_DEFAULT, 'configured, not ad hoc\n');
  write(dir, '.env', `API_TOKEN=${ENV_SENTINEL}\n`);
  write(dir, '.env.local', `X=${ENV_SENTINEL}\n`);
  write(dir, 'test/.auth/state.json', AUTH_SENTINEL);
  write(dir, '.auth/state.json', AUTH_SENTINEL);
  write(dir, 'node_modules/pkg/pending-questions.md', 'x');
  write(dir, 'executions/run1/watchlist.md', 'x');
  write(dir, '.playwright-cli/session.json', AUTH_SENTINEL);
  if (gitRepo) { git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c'); }
  return dir;
}
const OUT = () => path.join(tmp('agentex-harvest-out-'), 'out');
const baseOpts = (extra = {}) => ({ env: {}, now: () => new Date('2026-10-22T10:15:00Z'), ...extra });
function readReport(out) { return { md: fs.readFileSync(path.join(out, 'report.md'), 'utf8'), json: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')) }; }

// ---- spies --------------------------------------------------------------------------------------
const WRITE_FNS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'utimesSync', 'chmodSync', 'openSync', 'writeSync', 'createWriteStream', 'mkdtempSync'];
const isWrite = (c) => (c.fn !== 'openSync' ? WRITE_FNS.includes(c.fn) : (typeof c.flags === 'string' ? /[wa+]/.test(c.flags) : typeof c.flags === 'number' && (c.flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0));
const READ_FNS = ['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'readlinkSync', 'existsSync', 'accessSync', 'opendirSync', 'createReadStream'];
function spyFs() {
  const calls = []; const orig = {};
  for (const fn of [...WRITE_FNS, ...READ_FNS]) {
    if (typeof fs[fn] !== 'function') continue;
    orig[fn] = fs[fn];
    fs[fn] = function spied(...args) { calls.push({ fn, flags: args[1], path: typeof args[0] === 'string' ? args[0] : (Buffer.isBuffer(args[0]) ? args[0].toString() : String(args[0])) }); return orig[fn].apply(this, args); };
  }
  return { calls, restore() { for (const [fn, f] of Object.entries(orig)) fs[fn] = f; } };
}
function stubNetwork() {
  const hits = []; const restore = [];
  const stub = (mod, fn) => { const m = require(mod); if (typeof m[fn] !== 'function') return; const o = m[fn]; m[fn] = function stubbed() { hits.push(`${mod}.${fn}`); throw new Error('network is not allowed'); }; restore.push(() => { m[fn] = o; }); };
  for (const [mod, fns] of Object.entries({ http: ['request', 'get'], https: ['request', 'get'], net: ['connect', 'createConnection'], dns: ['lookup', 'resolve'], tls: ['connect'], dgram: ['createSocket'] })) for (const fn of fns) stub(mod, fn);
  return { hits, restore() { restore.forEach((r) => r()); } };
}

(async () => {
  // ---- first test: fixture roots byte-identical after a run --------------------------------------
  await test('roots are byte-identical after a run (every file, mtimes, .git/index and .git/config included)', async () => {
    const a = consumer('alpha'); const b = consumer('beta');
    const before = { a: snapshot(a), b: snapshot(b) };
    assert.ok(fs.existsSync(path.join(a, '.git', 'index')) && fs.existsSync(path.join(a, '.git', 'config')));
    const out = OUT();
    const r = await harvest.run(['--root', a, '--root', b, '--out', out], baseOpts());
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(snapshot(a), before.a);
    assert.deepStrictEqual(snapshot(b), before.b);
    assert.ok(fs.existsSync(path.join(out, 'report.md')) && fs.existsSync(path.join(out, 'report.json')));
  });

  await test('no root at all is exit 2 and nothing is written (no out folder either)', async () => {
    const out = OUT();
    const r = await harvest.run(['--out', out], baseOpts());
    assert.strictEqual(r.code, 2);
    assert.deepStrictEqual([r.out.tool, r.out.schemaVersion, r.out.result, r.out.reason], ['agentex-field-harvest', 1, 'ERROR', 'no-roots']);
    assert.ok(!fs.existsSync(out), 'the out folder is not created');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out)), [], 'the out parent is empty');
    const tmpBase = tmp('agentex-harvest-tmpdir-');
    const r2 = await harvest.run([], baseOpts({ tmpdir: tmpBase }));
    assert.strictEqual(r2.code, 2);
    assert.deepStrictEqual(fs.readdirSync(tmpBase), [], 'the default destination is not created either');
    const cli = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, AGENTEX_HARVEST_ROOTS: '' } });
    assert.strictEqual(cli.status, 2);
    assert.strictEqual(cli.stdout.trim().split(/\r?\n/).length, 1);
  });

  await test('all seven signal kinds are found on fixtures, with their fields; content of helper scripts is never copied', async () => {
    const a = consumer('alpha');
    const out = OUT();
    const r = await harvest.run(['--root', a, '--out', out], baseOpts());
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    const { json, md } = readReport(out);
    const of = (kind) => json.signals.filter((s) => s.kind === kind);
    // learning
    const learning = of('learning');
    assert.strictEqual(learning.length, 3);
    const open = learning.find((s) => s.id === 'PL-20261022T101500Z-7f3a');
    assert.deepStrictEqual([open.date, open.trigger, open.affected, open.version, open.status, open.problem, open.workaround],
      ['2026-10-22', 'workaround', 'test-design', '0.26.0', 'open', 'The skill could not attach steps.', 'Called the CLI directly.']);
    assert.strictEqual(learning.find((s) => s.id === 'PL-20261020T091200Z-c41e').status, 'absorbed');
    // fork
    assert.deepStrictEqual(of('fork').map((s) => [s.plugin, s.rule, s.path]).sort(), [
      ['task-estimation', 'name', '.claude/skills/task-estimation/'], ['test-design', 'self-described', '.claude/skills/our-design/']]);
    // promotion: the tag, the two tolerant phrasings, the .claude/CLAUDE.md line; not the block's own mention, not an ordinary rule
    const promo = of('promotion');
    assert.deepStrictEqual(promo.map((s) => [s.file, s.line]).sort(), [['.claude/CLAUDE.md', 1], ['CLAUDE.md', 2], ['CLAUDE.md', 3], ['CLAUDE.md', 4]]);
    assert.ok(promo.find((s) => s.line === 2).text.includes('always ask for the sprint first'));
    // helper-script
    assert.deepStrictEqual(of('helper-script').map((s) => [s.path, s.size, s.lines]).sort(), [
      ['.agentex/scripts/deep/er/x.py', 9, 1], ['.agentex/scripts/helper.js', 6, 3], ['.agentex/tool.mjs', 2, 1]]);
    assert.ok(!md.includes('print(1)') && !JSON.stringify(json).includes('print(1)'), 'a helper script is never copied');
    // port-checklist
    const ports = of('port-checklist');
    assert.deepStrictEqual(ports.map((s) => [s.file, s.unchecked]).sort(), [['.agentex/port-list.md', 2], ['dev-notes.md', 1]]);
    assert.deepStrictEqual(ports.find((s) => s.file === '.agentex/port-list.md').items, ['port the retry helper to the plugin', 'second open item']);
    // root-probe
    assert.deepStrictEqual(of('root-probe').map((s) => s.name).sort(), ['api_dump_1.json', 'explore_page.js', 'probe-login.mjs', 'run-out.txt']);
    // adhoc-watchlist: the configured qaRecords file is not ad hoc
    assert.deepStrictEqual(of('adhoc-watchlist').map((s) => [s.path, s.lines]), [['docs/open-questions.md', 2]]);
    assert.deepStrictEqual(r.out.signals, { learning: 3, fork: 2, promotion: 4, 'helper-script': 3, 'port-checklist': 2, 'root-probe': 4, 'adhoc-watchlist': 1 });
  });

  await test('a custom qaRecords path is honoured: the configured file is not ad hoc, the default file then is', async () => {
    const dir = tmp();
    write(dir, 'config/project.json', { qaRecords: { pendingQuestions: 'notes/pending-questions.md' } });
    write(dir, 'notes/pending-questions.md', 'a\n');
    const extra = `${path.dirname(QA_DEFAULT)}/watchlist-extra.md`;
    write(dir, extra, 'b\nc\n');
    const out = OUT();
    await harvest.run(['--root', dir, '--out', out], baseOpts());
    assert.deepStrictEqual(readReport(out).json.signals.filter((s) => s.kind === 'adhoc-watchlist').map((s) => s.path), [`${path.dirname(QA_DEFAULT)}/watchlist-extra.md`]);
  });

  await test('the report is grouped by affected plugin skill then signal kind, with counts across projects; absorbed entries get their own subsection', async () => {
    const a = consumer('alpha'); const b = consumer('beta');
    const out = OUT();
    const r = await harvest.run(['--root', a, '--root', b, '--out', out], baseOpts());
    assert.strictEqual(r.code, 0);
    const { md, json } = readReport(out);
    assert.ok(md.startsWith('Contains consumer specifics. Never commit to the plugin repo or the planning repo; generalize before filing.\n'));
    const iSkill = md.indexOf('### test-design'); const iAbsorbed = md.indexOf('Absorbed');
    assert.ok(iSkill > 0 && iAbsorbed > iSkill, 'the per-skill groups come first, absorbed apart');
    assert.match(md, /### test-design — \d+ signals? across 2 projects/);
    assert.match(md, /#### learning \(2\)/, 'two open test-design learnings (one per project)');
    assert.match(md, /#### fork \(2\)/);
    const absorbed = md.slice(iAbsorbed);
    assert.ok(absorbed.includes('PL-20261020T091200Z-c41e') && absorbed.includes('task-estimation'));
    assert.ok(!md.slice(0, iAbsorbed).includes('PL-20261020T091200Z-c41e'), 'an absorbed entry is not among the open ones');
    assert.ok(md.includes('alpha') && md.includes('beta'), 'project labels name the source');
    assert.strictEqual(json.schemaVersion, 1);
    assert.strictEqual(json.tool, 'agentex-field-harvest');
    assert.deepStrictEqual(json.roots.map((x) => [x.label, x.status]), [['alpha', 'ok'], ['beta', 'ok']]);
    assert.strictEqual(json.bySkill['test-design'].projects, 2);
    assert.strictEqual(json.bySkill['test-design'].learning, 2);
    assert.ok(json.signals.every((s) => typeof s.project === 'string'));
  });

  await test('.env files, test/.auth/, .auth/, .git/, node_modules/, executions/ and .playwright-cli/ are never opened or listed; their content never reaches the report', async () => {
    const a = consumer('alpha');
    const out = OUT();
    const spy = spyFs();
    let r;
    try { r = await harvest.run(['--root', a, '--out', out], baseOpts()); } finally { spy.restore(); }
    assert.strictEqual(r.code, 0);
    const rootReal = real(a);
    const touched = spy.calls.map((c) => c.path).filter((p) => p.startsWith(a) || p.startsWith(rootReal));
    const bad = touched.filter((p) => {
      const rel = path.relative(p.startsWith(rootReal) ? rootReal : a, p).split(path.sep);
      return rel.some((seg) => seg.startsWith('.env') || seg === '.auth' || seg === '.git' || seg === 'node_modules' || seg === 'executions' || seg === '.playwright-cli');
    });
    assert.deepStrictEqual(bad, [], `forbidden paths touched: ${bad.join(', ')}`);
    assert.ok(touched.length > 5, 'the spy saw the harvest read the root');
    const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8') + fs.readFileSync(path.join(out, 'report.json'), 'utf8');
    assert.ok(!report.includes(ENV_SENTINEL) && !report.includes(AUTH_SENTINEL));
    assert.ok(!r.out.out.includes(ENV_SENTINEL));
  });

  await test('read-only by construction: the only fs writes land in the out folder; no git command, no write API near a root', async () => {
    const a = consumer('alpha');
    const out = OUT();
    const spy = spyFs();
    try { await harvest.run(['--root', a, '--out', out], baseOpts()); } finally { spy.restore(); }
    const writes = spy.calls.filter(isWrite);
    const parents = [path.dirname(out), real(path.dirname(out))];
    for (const w of writes) assert.ok(parents.some((x) => w.path.startsWith(x)), `${w.fn} ${w.path} is outside the out folder`);
    assert.ok(writes.length >= 2);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!/child_process|execSync|spawn/.test(src), 'no git (or any) process');
    assert.ok(!/require\(['"](?:node:)?(?:net|http|https|dns|tls|dgram)['"]\)/.test(src), 'no network module');
  });

  await test('the network stub is never hit', async () => {
    const a = consumer('alpha');
    const stub = stubNetwork();
    let r;
    try { r = await harvest.run(['--root', a, '--out', OUT()], baseOpts()); } finally { stub.restore(); }
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(stub.hits, []);
  });

  await test('the destination inside the plugin repo, the planning repo (nested .planning/) or a root is refused (exit 2, nothing written); a destination beside them is fine', async () => {
    const a = consumer('alpha');
    const fakeRepo = tmp('agentex-fake-repo-');
    fs.mkdirSync(path.join(fakeRepo, '.planning'));
    const cases = {
      'inside the plugin repo': path.join(fakeRepo, 'out'),
      'inside the planning repo': path.join(fakeRepo, '.planning', 'harvest', 'out'),
      'the plugin repo itself': fakeRepo,
      'inside a root': path.join(a, 'harvest-out'),
      'a root itself': a,
    };
    for (const [name, out] of Object.entries(cases)) {
      const before = snapshot(fakeRepo);
      const rootBefore = snapshot(a);
      const r = await harvest.run(['--root', a, '--out', out], baseOpts({ pluginRepo: fakeRepo }));
      assert.strictEqual(r.code, 2, `${name}: ${JSON.stringify(r.out)}`);
      assert.strictEqual(r.out.result, 'ERROR');
      assert.match(r.out.reason, /^destination-in-(plugin-repo|root)$/, name);
      assert.deepStrictEqual(snapshot(fakeRepo), before, `${name}: plugin repo untouched`);
      assert.deepStrictEqual(snapshot(a), rootBefore, `${name}: root untouched`);
    }
    // the real plugin repo is the default plugin repo
    const real1 = await harvest.run(['--root', a, '--out', path.join(REPO, 'harvest-never-written')], baseOpts());
    assert.strictEqual(real1.code, 2);
    assert.ok(!fs.existsSync(path.join(REPO, 'harvest-never-written')));
    // a symlinked path into the repo is resolved first
    if (process.platform !== 'win32') {
      const link = path.join(tmp(), 'link');
      fs.symlinkSync(fakeRepo, link);
      const viaLink = await harvest.run(['--root', a, '--out', path.join(link, 'x')], baseOpts({ pluginRepo: fakeRepo }));
      assert.strictEqual(viaLink.code, 2);
    }
    const fine = await harvest.run(['--root', a, '--out', OUT()], baseOpts({ pluginRepo: fakeRepo }));
    assert.strictEqual(fine.code, 0);
  });

  await test('the default destination is a fresh folder under the OS temp dir: agentex-harvest-<UTC ts>/', async () => {
    const a = consumer('alpha');
    const tmpBase = tmp('agentex-harvest-tmpdir-');
    const r = await harvest.run(['--root', a], baseOpts({ tmpdir: tmpBase }));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(path.basename(r.out.out), 'agentex-harvest-20261022T101500Z');
    assert.strictEqual(path.dirname(real(r.out.out)), real(tmpBase));
    assert.ok(fs.existsSync(path.join(r.out.out, 'report.md')));
  });

  await test('a roots file inside the plugin repo is refused; roots come from --root, --roots-file (comments, blanks) and AGENTEX_HARVEST_ROOTS, deduplicated', async () => {
    const a = consumer('alpha'); const b = consumer('beta'); const c = consumer('gamma');
    const fakeRepo = tmp('agentex-fake-repo-');
    write(fakeRepo, 'roots.txt', `${a}\n`);
    const refused = await harvest.run(['--roots-file', path.join(fakeRepo, 'roots.txt'), '--out', OUT()], baseOpts({ pluginRepo: fakeRepo }));
    assert.deepStrictEqual([refused.code, refused.out.reason], [2, 'roots-file-in-plugin-repo']);
    const rootsFile = path.join(tmp(), 'roots.txt');
    fs.writeFileSync(rootsFile, `# my projects\n\n${b}\n  ${a}  \n`);
    const out = OUT();
    const r = await harvest.run(['--root', a, '--roots-file', rootsFile, '--out', out], baseOpts({ env: { AGENTEX_HARVEST_ROOTS: [c, b].join(path.delimiter) } }));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.roots, 3, 'a, b, c once each');
    assert.deepStrictEqual(readReport(out).json.roots.map((x) => x.label).sort(), ['alpha', 'beta', 'gamma']);
    assert.strictEqual((await harvest.run(['--roots-file', path.join(tmp(), 'missing.txt')], baseOpts())).code, 2);
  });

  await test('labels: basename by default (duplicates told apart), index on request', async () => {
    const a = consumer('app'); const b = consumer('app');
    const out1 = OUT();
    await harvest.run(['--root', a, '--root', b, '--out', out1], baseOpts());
    assert.deepStrictEqual(readReport(out1).json.roots.map((x) => x.label), ['app', 'app-2']);
    const out2 = OUT();
    await harvest.run(['--root', a, '--root', b, '--label', 'index', '--out', out2], baseOpts());
    assert.deepStrictEqual(readReport(out2).json.roots.map((x) => x.label), ['project-1', 'project-2']);
    assert.ok(!readReport(out2).md.includes('app-2'), 'the index label hides the folder name');
    assert.strictEqual((await harvest.run(['--root', a, '--label', 'weird'], baseOpts())).code, 2);
  });

  await test('an unreadable root is PARTIAL (exit 1) and named by label; the readable roots are still reported', async () => {
    const a = consumer('alpha');
    const missing = path.join(tmp(), 'gone');
    const out = OUT();
    const r = await harvest.run(['--root', a, '--root', missing, '--out', out], baseOpts());
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual([r.out.result, r.out.roots, r.out.scanned, r.out.unreadable], ['PARTIAL', 2, 1, 1]);
    assert.deepStrictEqual(r.out.unreadableRoots, ['gone']);
    const { json } = readReport(out);
    assert.deepStrictEqual(json.roots.map((x) => [x.label, x.status]), [['alpha', 'ok'], ['gone', 'unreadable']]);
  });

  await test('CLI: one JSON line on stdout; exit 0 on OK; exit 2 on usage; AGENTEX_HARVEST_ROOTS alone is enough', async () => {
    const a = consumer('alpha');
    const out = OUT();
    const r = spawnSync(process.execPath, [SCRIPT, '--out', out], { encoding: 'utf8', env: { ...process.env, AGENTEX_HARVEST_ROOTS: a } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.deepStrictEqual([j.tool, j.schemaVersion, j.result, j.roots, j.scanned, j.unreadable], ['agentex-field-harvest', 1, 'OK', 1, 1, 0]);
    assert.deepStrictEqual(Object.keys(j.signals), ['learning', 'fork', 'promotion', 'helper-script', 'port-checklist', 'root-probe', 'adhoc-watchlist']);
    assert.strictEqual(fs.realpathSync(j.out), fs.realpathSync(out));
    const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', env: { ...process.env, AGENTEX_HARVEST_ROOTS: '' } });
    assert.strictEqual(bad.status, 2);
    assert.strictEqual(JSON.parse(bad.stdout.trim()).reason, 'usage');
  });

  await test('structural: the delivered script writes only inside its output function and never names a network or process module', async () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const code = src.replace(/\/\/.*$/gm, '');
    const writers = code.match(/\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|cpSync|symlinkSync)\b/g) || [];
    const fnStart = code.indexOf('function writeOutputs');
    assert.ok(fnStart > 0, 'writeOutputs exists');
    const fnBody = code.slice(fnStart, code.indexOf('\n}\n', fnStart));
    const inFn = fnBody.match(/\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|cpSync|symlinkSync)\b/g) || [];
    assert.strictEqual(writers.length, inFn.length, 'every write call sits in writeOutputs');
    assert.ok(!code.includes('process.exit('));
  });

  await test('no command, skill, agent or reference names scripts/harvest (the harvest is the maintainer\'s, never a consumer path)', async () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); continue; }
        if (!/\.(md|js|json|yml|yaml)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
        if (fs.readFileSync(p, 'utf8').includes('scripts/harvest')) hits.push(path.relative(REPO, p));
      }
    };
    for (const d of ['commands', 'skills', 'agents', 'references']) if (fs.existsSync(path.join(REPO, d))) walk(path.join(REPO, d));
    assert.deepStrictEqual(hits, []);
  });

  await test('genericity: the harvest sources carry no machine path, employer or project name', async () => {
    for (const f of ['harvest.js', 'README.md']) {
      const text = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!/\/Users\/|C:\\Users\\|\/home\/[a-z]/i.test(text), `${f} names a machine path`);
    }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
