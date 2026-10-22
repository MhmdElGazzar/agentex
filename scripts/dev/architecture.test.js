'use strict';
// Tests for scripts/dev/architecture.js — the generated README architecture map, over a
// throwaway repo, plus the guard that keeps this repo's own README current.
// Run: node scripts/dev/architecture.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan, render, BEGIN, END } = require('./architecture.js');

const CLI = path.join(__dirname, 'architecture.js');
const REPO = path.resolve(__dirname, '..', '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A small plugin: two commands, three skills (+ one folder that is not a skill), one agent.
function repo({ markers = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-arch-'));
  made.push(dir);
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('commands/run.md', 'Use the **runner** skill. Dispatch `worker` per spec.\n');
  w('commands/setup.md', 'node scripts/init.js\n');
  w('skills/runner/SKILL.md', 'Steps: read skills/helper/SKILL.md. Hand each spec to `worker`.\n');
  w('skills/helper/SKILL.md', 'A helper.\n');
  w('skills/helper/references/deep/more.md', 'Also see skills/reporter/SKILL.md.\n');
  w('skills/reporter/SKILL.md', 'Writes reports.\n');
  w('skills/scripts-only/run.js', '// not a skill: no SKILL.md\n');
  w('agents/worker.md', 'A subagent.\n');
  w('README.md', markers ? `# X\n\nIntro.\n\n${BEGIN}\n${END}\n\nTail.\n` : '# X\n\nNo markers.\n');
  return dir;
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop();
  let json = null; try { json = JSON.parse(line); } catch { /* --print */ }
  return { code: r.status, json, stdout: r.stdout };
};

test('scan: a folder without SKILL.md is not a skill; links come from paths, bold mentions and backticked agents', () => {
  const m = scan(repo());
  assert.deepStrictEqual(m.commands, ['run', 'setup']);
  assert.deepStrictEqual(m.skills, ['helper', 'reporter', 'runner']);
  assert.deepStrictEqual(m.agents, ['worker']);
  assert.deepStrictEqual(m.cmdSkill, [['run', 'runner']]);
  assert.deepStrictEqual(m.cmdAgent, [['run', 'worker']]);
  assert.deepStrictEqual(m.skillAgent, [['runner', 'worker']]);
});

test('scan: a skill counts its nested references; a skill never links to itself', () => {
  const m = scan(repo());
  assert.deepStrictEqual(m.skillSkill, [['helper', 'reporter'], ['runner', 'helper']]);
});

test('render: skills no command reaches get their own group; a command link its skill already makes is not repeated', () => {
  const block = render(scan(repo()));
  assert.ok(block.startsWith(BEGIN) && block.endsWith(END));
  assert.match(block, /Skills a command runs"\]\n {4}s_runner\["runner"\]\n {2}end/);
  assert.match(block, /triggered by spec steps or other skills"\]\n {4}s_helper\["helper"\]\n {4}s_reporter\["reporter"\]/);
  assert.match(block, /s_runner -\.-> a_worker/);
  assert.doesNotMatch(block, /c_run -\.-> a_worker/);
  assert.match(block, /2 commands, 3 skills and 1 subagents/);
});

test('CLI: --check on an empty block is stale (exit 1, names the fix); --write fills it; then --check passes', () => {
  const dir = repo();
  let r = cli('--check', '--root', dir);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.json.stale, true);
  assert.match(r.json.fix, /architecture\.js --write/);
  r = cli('--write', '--root', dir);
  assert.deepStrictEqual([r.code, r.json.changed], [0, true]);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.startsWith('# X\n\nIntro.\n\n') && readme.endsWith('\n\nTail.\n'), 'text outside the markers is untouched');
  assert.strictEqual(cli('--check', '--root', dir).code, 0);
  assert.deepStrictEqual(cli('--write', '--root', dir).json.changed, false, 'a second write changes nothing');
});

test('CLI: a new skill makes the map stale until it is regenerated', () => {
  const dir = repo();
  cli('--write', '--root', dir);
  fs.mkdirSync(path.join(dir, 'skills', 'newcomer'));
  fs.writeFileSync(path.join(dir, 'skills', 'newcomer', 'SKILL.md'), 'New.\n');
  assert.strictEqual(cli('--check', '--root', dir).code, 1);
  cli('--write', '--root', dir);
  assert.strictEqual(cli('--check', '--root', dir).code, 0);
});

test('CLI: no markers → --check reports missing (exit 1), --write refuses (exit 2); bad usage exits 2', () => {
  const dir = repo({ markers: false });
  const r = cli('--check', '--root', dir);
  assert.deepStrictEqual([r.code, r.json.missing], [1, true]);
  assert.strictEqual(cli('--write', '--root', dir).code, 2);
  assert.strictEqual(cli('--root', dir).code, 2);
  assert.strictEqual(cli('--check', '--write').code, 2);
  assert.strictEqual(cli('--nope').code, 2);
});

test('CLI: --print writes nothing', () => {
  const dir = repo();
  const before = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const r = cli('--print', '--root', dir);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('flowchart LR'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before);
});

test("this repo's README map is current (after adding a command, skill or agent: node scripts/dev/architecture.js --write)", () => {
  const r = cli('--check', '--root', REPO);
  assert.strictEqual(r.code, 0, `README architecture map is stale — run: node scripts/dev/architecture.js --write (${JSON.stringify(r.json)})`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
