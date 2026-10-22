'use strict';
// Tests for build_host.js — the per-host branch builder, against throwaway git repos.
// Run: node scripts/hosts/build_host.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildTree, buildHostCommit, COMMON_EXCLUDES } = require('./build_host.js');
const { matcher } = require('./transforms.js');

const SCRIPT = path.join(__dirname, 'build_host.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}
function write(dir, rel, content = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}
function treeFiles(cwd, ref) {
  return git(cwd, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort();
}
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const CLAUDE_HOST = { target: { branch: 'store' }, guards: { maxFiles: 512, forbiddenPaths: ['.gitattributes'] } };
const DEMO_HOST = {
  label: 'Demo Host',
  target: { branch: 'demo' },
  tag: 'demo-v{version}',
  exclude: ['skills/legacy'],
  transforms: [
    ['commandsToSkills'],
    ['invocations', { prefix: '/demo:' }],
    ['pluginRoot', { mode: 'placeholder' }],
    ['preamble', { text: '> On {host}, root is `{root}`.' }],
    ['manifest', { target: '.demo-plugin/plugin.json', pick: ['name', 'version'], removeSource: true }],
  ],
  guards: {
    skills: { nameMatchesFolder: true },
    forbiddenText: [{ pattern: '\\$\\{CLAUDE_PLUGIN_ROOT\\}' }],
    manifest: { path: '.demo-plugin/plugin.json', required: ['name', 'version'] },
  },
};

// A repo shaped like the plugin: runtime files, dev-only paths, and two host configs.
function pluginRepo() {
  const dir = tmp('agentex-host-test-');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, '.claude-plugin/plugin.json', '{"name":"agentex","version":"1.0.0","description":"d"}\n');
  write(dir, 'README.md');
  write(dir, '.gitattributes', '* text=auto eol=lf\n');
  write(dir, '.github/workflows/hosts.yml');
  write(dir, 'evals/trigger-x/prompt.md');
  write(dir, 'skills/run-it/SKILL.md', '---\nname: run-it\ndescription: Runs it.\n---\nnode ${CLAUDE_PLUGIN_ROOT}/skills/run-it/scripts/run.js\n');
  write(dir, 'skills/run-it/scripts/run.js', '// x\n');
  write(dir, 'skills/run-it/scripts/run.test.js');
  write(dir, 'skills/run-it/scripts/golden/case1.json', '{}\n');
  write(dir, 'skills/legacy/scripts/old.js');
  write(dir, 'commands/go.md', '---\ndescription: Go. Usage: /go\n---\nGo with $ARGUMENTS\n');
  write(dir, 'scripts/hosts/build_host.js');
  write(dir, 'scripts/run-tests.js');                 // maintainer tooling (delivery-speed)
  write(dir, 'scripts/release-gate/gate-plan.js');
  write(dir, 'scripts/release-gate/prepare.js');      // a gate script that does ship
  write(dir, 'hosts/claude/host.json', JSON.stringify(CLAUDE_HOST));
  write(dir, 'hosts/demo/host.json', JSON.stringify(DEMO_HOST));
  write(dir, 'hosts/demo/overlay/DEMO.md', 'demo only\n');
  commitAll(dir, 'init');
  return dir;
}
function bareRemote(dir) {
  const bare = tmp('agentex-host-remote-');
  git(bare, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', bare);
  return bare;
}
function runCli(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n')[0]), stdout: r.stdout };
}

const CLAUDE_KEPT = ['.claude-plugin/plugin.json', 'README.md', 'commands/go.md',
  'scripts/release-gate/prepare.js',
  'skills/legacy/scripts/old.js', 'skills/run-it/SKILL.md', 'skills/run-it/scripts/run.js'];

test('claude host: main minus evals, tests and golden fixtures, .github, .gitattributes, hosts/, scripts/hosts and the maintainer runners', () => {
  const dir = pluginRepo();
  const res = buildHostCommit({ cwd: dir, source: 'main', host: 'claude' });
  assert.strictEqual(res.ok, true, JSON.stringify(res.findings));
  assert.deepStrictEqual(treeFiles(dir, res.commit), CLAUDE_KEPT);
});

test('claude host: untouched files reuse their source blobs, so the tree is byte-identical', () => {
  const dir = pluginRepo();
  const res = buildHostCommit({ cwd: dir, source: 'main', host: 'claude' });
  for (const p of CLAUDE_KEPT) {
    assert.strictEqual(git(dir, 'rev-parse', `${res.commit}:${p}`), git(dir, 'rev-parse', `main:${p}`), p);
  }
});

test('transform host: commands become skills, the root is rewritten, preamble and manifest added, overlay applied', () => {
  const dir = pluginRepo();
  const res = buildHostCommit({ cwd: dir, source: 'main', host: 'demo' });
  assert.strictEqual(res.ok, true, JSON.stringify(res.findings));
  assert.deepStrictEqual(treeFiles(dir, res.commit), ['.demo-plugin/plugin.json', 'DEMO.md', 'README.md',
    'scripts/release-gate/prepare.js', 'skills/go/SKILL.md', 'skills/run-it/SKILL.md', 'skills/run-it/scripts/run.js']);
  assert.strictEqual(git(dir, 'show', `${res.commit}:skills/run-it/SKILL.md`),
    '---\nname: run-it\ndescription: Runs it.\n---\n\n> On Demo Host, root is `../..`.\n\nnode <agentex-root>/skills/run-it/scripts/run.js');
  assert.match(git(dir, 'show', `${res.commit}:skills/go/SKILL.md`), /^---\nname: go\ndescription: "Go\. Usage: \/demo:go"[\s\S]*Go with \(the argument text/);
  assert.deepStrictEqual(JSON.parse(git(dir, 'show', `${res.commit}:.demo-plugin/plugin.json`)), { name: 'agentex', version: '1.0.0' });
  assert.strictEqual(git(dir, 'show', `${res.commit}:DEMO.md`), 'demo only');
});

test('a guard finding fails the build: no commit, exit 1, nothing pushed', () => {
  const dir = pluginRepo();
  write(dir, 'skills/broken/scripts/x.js');           // a skill folder with no SKILL.md
  commitAll(dir, 'broken skill');
  const bare = bareRemote(dir);
  const res = buildTree({ cwd: dir, source: 'main', host: 'demo' });
  assert.deepStrictEqual(res.findings.map((f) => `${f.guard}:${f.path}`), ['skills:skills/broken/']);
  const r = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.ok, false);
  assert.strictEqual(r.out.pushed, false);
  assert.strictEqual(spawnSync('git', ['rev-parse', '-q', '--verify', 'demo'], { cwd: bare }).status, 1, 'no demo branch');
});

test('working tree, index and HEAD are untouched by a build', () => {
  const dir = pluginRepo();
  const head = git(dir, 'rev-parse', 'HEAD');
  buildHostCommit({ cwd: dir, source: 'main', host: 'demo' });
  assert.strictEqual(git(dir, 'status', '--porcelain'), '');
  assert.strictEqual(git(dir, 'rev-parse', 'HEAD'), head);
});

test('no change on main → no new commit; a change → one commit on top of the target head', () => {
  const dir = pluginRepo();
  const first = buildHostCommit({ cwd: dir, source: 'main', host: 'claude' });
  git(dir, 'branch', 'store', first.commit);
  assert.strictEqual(buildHostCommit({ cwd: dir, source: 'main', host: 'claude', parent: 'store' }).changed, false);

  write(dir, 'evals/trigger-y/prompt.md');           // dev-only change: target unaffected
  commitAll(dir, 'eval only');
  assert.strictEqual(buildHostCommit({ cwd: dir, source: 'main', host: 'claude', parent: 'store' }).changed, false);

  write(dir, 'README.md', 'updated\n');              // runtime change: target moves
  commitAll(dir, 'readme');
  const next = buildHostCommit({ cwd: dir, source: 'main', host: 'claude', parent: 'store' });
  assert.strictEqual(next.changed, true);
  assert.strictEqual(git(dir, 'rev-parse', `${next.commit}^`), first.commit, 'parent is the target head');
});

function setVersion(dir, version) {
  write(dir, '.claude-plugin/plugin.json', `{"name":"agentex","version":"${version}","description":"d"}\n`);
  commitAll(dir, `release ${version}`);
}

test('CLI --push: the version a branch starts at is never tagged; each new version is tagged once', () => {
  const dir = pluginRepo();
  const bare = bareRemote(dir);
  const r1 = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.strictEqual(r1.code, 0, r1.stdout);
  assert.deepStrictEqual([r1.out.pushed, r1.out.tagged], [true, null], 'unreleased 1.0.0 content is not tagged');

  git(dir, 'fetch', '-q', 'origin');
  const r2 = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.deepStrictEqual([r2.out.changed, r2.out.pushed, r2.out.tagged], [false, false, null]);

  setVersion(dir, '1.1.0');
  git(dir, 'fetch', '-q', 'origin');
  const r3 = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.deepStrictEqual([r3.out.pushed, r3.out.tagged], [true, 'demo-v1.1.0']);
  assert.strictEqual(git(bare, 'rev-parse', 'demo-v1.1.0'), git(bare, 'rev-parse', 'demo'));
  assert.strictEqual(git(bare, 'rev-parse', 'demo^'), r1.out.commit, 'fast-forward on top of the first build');

  write(dir, 'README.md', 'new\n');
  commitAll(dir, 'readme');
  git(dir, 'fetch', '-q', 'origin');
  const r4 = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.deepStrictEqual([r4.out.pushed, r4.out.tagged], [true, null], 'same version: no second tag');
  assert.strictEqual(git(bare, 'rev-parse', 'demo-v1.1.0'), r3.out.commit, 'the tag stays on the release build');
});

test('a tag whose push was missed is made by the next build of the same version', () => {
  const dir = pluginRepo();
  const bare = bareRemote(dir);
  runCli(dir, ['--host', 'demo', '--push', 'origin']);
  setVersion(dir, '1.1.0');
  git(dir, 'fetch', '-q', 'origin');
  runCli(dir, ['--host', 'demo', '--push', 'origin']);
  git(bare, 'tag', '-d', 'demo-v1.1.0');            // the tag push "failed"
  write(dir, 'README.md', 'later\n');
  commitAll(dir, 'later');
  git(dir, 'fetch', '-q', 'origin');
  assert.strictEqual(runCli(dir, ['--host', 'demo', '--push', 'origin']).out.tagged, 'demo-v1.1.0');
});

function handEdit(bare) {
  const other = tmp('agentex-host-other-');
  git(other, 'clone', '-q', '-b', 'store', bare, '.');
  write(other, 'hand-edit.md');
  commitAll(other, 'hand edit');
  git(other, 'push', '-q');
}

test('a hand edit on the target is refused, not overwritten — with a current ref, as in CI', () => {
  const dir = pluginRepo();
  const bare = bareRemote(dir);
  assert.strictEqual(runCli(dir, ['--host', 'claude', '--push', 'origin']).code, 0);
  handEdit(bare);
  write(dir, 'README.md', 'new\n');
  commitAll(dir, 'readme');
  git(dir, 'fetch', '-q', 'origin');                 // CI's checkout refreshes origin/store
  const r = runCli(dir, ['--host', 'claude', '--push', 'origin']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out.reason, /was not made by the builder/);
  assert.ok(git(bare, 'ls-tree', '--name-only', 'store').includes('hand-edit.md'), 'hand edit survives');
});

test('a hand edit with a stale local ref still fails at the push', () => {
  const dir = pluginRepo();
  const bare = bareRemote(dir);
  runCli(dir, ['--host', 'claude', '--push', 'origin']);
  git(dir, 'fetch', '-q', 'origin');
  handEdit(bare);
  write(dir, 'README.md', 'new\n');
  commitAll(dir, 'readme');
  assert.strictEqual(runCli(dir, ['--host', 'claude', '--push', 'origin']).code, 2);
  assert.ok(git(bare, 'ls-tree', '--name-only', 'store').includes('hand-edit.md'));
});

test('an older source (a re-run, or another ref) is refused instead of rolling the branch back', () => {
  const dir = pluginRepo();
  const bare = bareRemote(dir);
  write(dir, 'README.md', 'v2\n');
  commitAll(dir, 'v2');
  runCli(dir, ['--host', 'claude', '--push', 'origin']);
  git(dir, 'fetch', '-q', 'origin');
  const r = runCli(dir, ['--host', 'claude', '--source', 'main~1', '--push', 'origin']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out.reason, /is not newer than/);
  assert.strictEqual(git(bare, 'show', 'store:README.md'), 'v2');
  git(dir, 'checkout', '-q', '-b', 'side', 'main~1');
  write(dir, 'side.md');
  commitAll(dir, 'side branch');
  assert.match(runCli(dir, ['--host', 'claude', '--push', 'origin']).out.reason, /is not newer than/, 'a diverged ref');
  assert.strictEqual(runCli(dir, ['--host', 'claude', '--source', 'main', '--push', 'origin']).code, 0, 'rebuilding the same source is fine');
});

test('the legacy store sync commit is accepted as a builder-made parent', () => {
  const dir = pluginRepo();
  const src = git(dir, 'rev-parse', 'main');
  const tree = git(dir, 'rev-parse', 'main^{tree}');
  const legacy = git(dir, 'commit-tree', tree, '-m', `store: sync from main ${src.slice(0, 7)}\n\nmain's tree minus development-only paths.\nSource: ${src}`);
  git(dir, 'branch', 'store', legacy);
  write(dir, 'README.md', 'new\n');
  commitAll(dir, 'readme');
  const res = buildHostCommit({ cwd: dir, source: 'main', host: 'claude', parent: 'store' });
  assert.strictEqual(res.changed, true);
  assert.strictEqual(git(dir, 'rev-parse', `${res.commit}^`), legacy);
});

test('publish:false builds and guards but never pushes', () => {
  const dir = pluginRepo();
  write(dir, 'hosts/demo/host.json', JSON.stringify({ ...DEMO_HOST, publish: false }));
  commitAll(dir, 'demo off');
  const bare = bareRemote(dir);
  const r = runCli(dir, ['--host', 'demo', '--push', 'origin']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual([r.out.ok, r.out.pushed, r.out.reason], [true, false, 'publish is off for this host']);
  assert.strictEqual(spawnSync('git', ['rev-parse', '-q', '--verify', 'demo'], { cwd: bare }).status, 1);
});

test('--list prints the built paths after the JSON line', () => {
  const dir = pluginRepo();
  const r = runCli(dir, ['--host', 'claude', '--list']);
  assert.deepStrictEqual(r.stdout.trim().split('\n').slice(1).sort(), CLAUDE_KEPT);
});

test('unknown host, unknown ref, bad arguments → exit 2 with a reason', () => {
  const dir = pluginRepo();
  assert.match(runCli(dir, ['--host', 'claude', '--push', '--list']).out.reason, /unexpected argument: --push --list/);
  assert.match(runCli(dir, ['--host', 'nope']).out.reason, /unknown host "nope"/);
  assert.strictEqual(runCli(dir, ['--host', 'claude', '--source', 'nope']).code, 2);
  assert.strictEqual(runCli(dir, ['--bogus', 'x']).code, 2);
  assert.match(runCli(dir, []).out.reason, /--host <name> is required/);
});

// Every real host config must build cleanly from this repo's HEAD — the same check CI
// runs before publishing, caught here first.
const REPO = git(__dirname, 'rev-parse', '--show-toplevel');
function repoBuild(host) {
  const res = buildTree({ cwd: REPO, source: 'HEAD', host });
  const paths = [...res.files.keys()];
  const read = (p) => require('./transforms.js').text(res.files.get(p));
  return { res, paths, read, has: (p) => res.files.has(p), under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)) };
}

test('this repo: every host in hosts/ builds from HEAD with no guard findings', () => {
  const hosts = git(REPO, 'ls-tree', '--name-only', 'HEAD:hosts').split('\n').filter(Boolean).map((p) => p.replace(/^hosts\//, ''));
  assert.ok(hosts.includes('claude'), 'the claude host exists');
  for (const host of hosts) {
    const res = buildTree({ cwd: REPO, source: 'HEAD', host });
    assert.deepStrictEqual(res.findings, [], `${host}: ${JSON.stringify(res.findings.slice(0, 5))}`);
  }
});

test('this repo, claude: the `store` branch content — unconverted, no dev-only paths', () => {
  const b = repoBuild('claude');
  assert.strictEqual(b.res.config.target.branch, 'store');
  assert.ok(b.has('.claude-plugin/plugin.json') && b.under('commands').length && b.under('agents').length);
  assert.ok(!b.paths.some((p) => /^(evals|hosts|\.github)\//.test(p) || p.endsWith('.test.js') || p === '.gitattributes'));
  assert.ok(!b.has('scripts/run-tests.js') && !b.has('scripts/release-gate/gate-plan.js'), 'maintainer runners never ship');
  assert.ok(b.read('skills/test-execution/SKILL.md').includes('${CLAUDE_PLUGIN_ROOT}'), 'Claude keeps its own variable');
});

test('COMMON_EXCLUDES drops changelog fragments and the maintainer tooling that reads them', () => {
  const drop = matcher(COMMON_EXCLUDES);
  assert.ok(drop('changelog.d/a.md') && drop('changelog.d/.gitkeep') && drop('scripts/dev/changelog.js'));
  assert.ok(!drop('CHANGELOG.md'), 'the changelog itself still ships');
});

test('this repo, copilot: Claude layout kept, root placeholder, explicit agents/commands in the manifest', () => {
  const b = repoBuild('copilot');
  const manifest = JSON.parse(b.read('.claude-plugin/plugin.json'));
  assert.deepStrictEqual([manifest.agents, manifest.commands], ['./agents', './commands']);
  assert.ok(b.under('commands').length >= 10 && b.under('agents').length >= 3);
  assert.match(b.read('skills/test-execution/SKILL.md'), /AgenTeX on GitHub Copilot[\s\S]*<agentex-root>/);
  assert.match(b.read('commands/execute-test.md'), /^---\ndescription:[\s\S]*?---\n\n> \*\*AgenTeX on GitHub Copilot\.\*\* .*`\.\.` from/);
  assert.ok(!b.has('skills/browser-testing/scripts/ci_gate.js'), 'the SKILL.md-less CI forwarder is dropped');
  const market = JSON.parse(b.read('.github/plugin/marketplace.json'));
  assert.deepStrictEqual([market.name, market.plugins[0].name, market.plugins[0].source], ['agentex-copilot', 'agentex', './'],
    'the branch is its own marketplace: copilot plugin marketplace add <repo>#copilot');
});

test('this repo, devin: commands became skills (clashes get -command), agents kept', () => {
  const b = repoBuild('devin');
  assert.deepStrictEqual(b.under('commands'), []);
  for (const s of ['execute-test', 'init-test', 'ask-kb', 'ask-kb-command', 'define-flow-command']) {
    assert.ok(b.has(`skills/${s}/SKILL.md`), s);
  }
  assert.ok(b.has('agents/qa-executor.md'));
  assert.match(b.read('skills/test-design/SKILL.md'), /`ask_user_question` call/);
  assert.match(b.read('skills/ask-kb-command/SKILL.md'), /\/agentex:ask-kb-command/);
  assert.ok(!/(^|\s)\/ask-kb\b/m.test(b.read('skills/ask-kb-command/SKILL.md')), 'no bare /ask-kb left');
});

test('this repo, codex: skills-only plugin, agents moved to references/agents, own manifest', () => {
  const b = repoBuild('codex');
  assert.deepStrictEqual([b.under('commands'), b.under('agents'), b.under('.claude-plugin')], [[], [], []]);
  assert.deepStrictEqual(b.under('references/agents').sort(),
    ['references/agents/api-executor.md', 'references/agents/mobile-qa-executor.md', 'references/agents/qa-executor.md']);
  const manifest = JSON.parse(b.read('.codex-plugin/plugin.json'));
  assert.strictEqual(manifest.version, JSON.parse(git(REPO, 'show', 'HEAD:.claude-plugin/plugin.json')).version);
  assert.ok(!('$schema' in manifest));
  assert.match(b.read('skills/execute-test/SKILL.md'), /^---\nname: execute-test\n[\s\S]*disable-model-invocation: true[\s\S]*references\/agents\/<name>\.md/);
  assert.strictEqual(manifest.skills, './skills/');
  for (const s of ['execute-test', 'init-test', 'update-agentex', 'ask-kb-command']) {
    assert.strictEqual(b.read(`skills/${s}/agents/openai.yaml`), 'policy:\n  allow_implicit_invocation: false\n', s);
  }
  assert.ok(!b.has('skills/ask-kb/agents/openai.yaml'), 'real skills stay implicitly invocable');
  assert.match(b.read('skills/ask-kb-command/SKILL.md'), /\$agentex:ask-kb-command/);
  assert.ok(!b.paths.some((p) => /\/golden\//.test(p)), 'golden fixtures never ship');
  const market = JSON.parse(b.read('.agents/plugins/marketplace.json'));
  assert.deepStrictEqual([market.name, market.plugins[0].source], ['agentex-codex', { source: 'local', path: './' }],
    'the branch is its own marketplace: codex plugin marketplace add <repo> --ref codex');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
