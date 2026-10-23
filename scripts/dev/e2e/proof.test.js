'use strict';
// Tests for proof.js (policy Q31): which release-gate lanes the local e2e tests prove.
// Each case builds a throwaway git repo (a base commit and a HEAD commit), stand-in e2e files that
// exit 0 / 1 / 77, and a covers.json, then runs proof.js on it. Run: node scripts/dev/e2e/proof.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const PROOF = path.join(__dirname, 'proof.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); }
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-e2e-proof-test-'));
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const E2E = { pass: 'process.exit(0);\n', fail: "console.error('boom'); process.exit(1);\n", skip: "console.log('SKIP: playwright not found'); process.exit(77);\n" };
const LOGIN = 'skills/browser-driver/scripts/login_state.js';
const LOGIN_E2E = 'skills/browser-driver/scripts/login_state.e2e.test.js';
const FNS = (body) => `'use strict';\nfunction renew() {\n  return 1; ${body}\n}\nfunction other() {\n  return 2;\n}\nconst tail = 3;\n`;

let n = 0;
// base/head: { rel: text }; covers: object; e2e: 'pass'|'fail'|'skip'; dirty: leave an untracked file.
function repo({ base = {}, head = {}, covers, e2e = 'pass', e2eFiles = [LOGIN_E2E], dirty = false }) {
  const root = path.join(scratch, `repo-${++n}`);
  fs.mkdirSync(root, { recursive: true });
  g(root, 'init', '-q'); g(root, 'config', 'user.email', 't@example.test'); g(root, 'config', 'user.name', 't');
  write(root, 'README.md', 'x\n');
  for (const [rel, text] of Object.entries(base)) write(root, rel, text);
  for (const f of e2eFiles) write(root, f, E2E[e2e]);
  g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'base');
  const baseSha = g(root, 'rev-parse', 'HEAD');
  for (const [rel, text] of Object.entries(head)) { if (text === null) fs.rmSync(path.join(root, rel)); else write(root, rel, text); }
  g(root, 'add', '-A'); g(root, 'commit', '-q', '--allow-empty', '-m', 'head');
  const coversFile = path.join(root, '..', `covers-${n}.json`);
  fs.writeFileSync(coversFile, JSON.stringify({ schemaVersion: 1, ...(covers || {}) }));
  if (dirty) write(root, 'untracked.txt', 'x\n');
  return { root, baseSha, coversFile };
}
function proof(r, extra = []) {
  const res = spawnSync(process.execPath, [PROOF, '--base', r.baseSha, '--root', r.root, '--covers', r.coversFile, ...extra], { encoding: 'utf8' });
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `one JSON line, got: ${res.stdout}${res.stderr}`);
  return { code: res.status, json: JSON.parse(lines[0]) };
}

test('a covered whole-file change whose e2e file passes (skipping forbidden) proves the lane, with the sha, the files and a reason', () => {
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
  const { code, json } = proof(r);
  assert.strictEqual(code, 0);
  assert.strictEqual(json.clean, true);
  assert.strictEqual(json.head, g(r.root, 'rev-parse', '--short', 'HEAD'));
  assert.deepStrictEqual(json.lanes.ui.proven, true);
  assert.deepStrictEqual(json.lanes.ui.by, [LOGIN_E2E]);
  assert.match(json.lanes.ui.why, /passed at .* skipping forbidden/);
  assert.strictEqual(json.lanes.setup.proven, false, 'setup always runs live');
  assert.match(json.lanes.setup.why, /always run live/);
  assert.strictEqual(json.lanes.wizard.proven, false);
});

test('a dirty tree exits 2, proves nothing and says so', () => {
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] }, dirty: true });
  const { code, json } = proof(r);
  assert.strictEqual(code, 2);
  assert.strictEqual(json.clean, false);
  assert.deepStrictEqual(json.lanes, {});
  assert.match(json.error, /not clean/);
});

test('an unknown base, a missing --base and a bad covers file exit 2 with an error line', () => {
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
  assert.strictEqual(proof({ ...r, baseSha: 'nosuchref' }).code, 2);
  const none = spawnSync(process.execPath, [PROOF, '--root', r.root], { encoding: 'utf8' });
  assert.strictEqual(none.status, 2);
  assert.match(JSON.parse(none.stdout.trim()).error, /--base is required/);
  assert.strictEqual(proof({ ...r, coversFile: path.join(r.root, 'nope.json') }).code, 2);
});

test('a failed e2e run makes the lane live, with the reason', () => {
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] }, e2e: 'fail' });
  const { json } = proof(r);
  assert.strictEqual(json.lanes.ui.proven, false);
  assert.match(json.lanes.ui.why, /failed \(exit 1\).*boom/);
});

test('a SKIPPED e2e run is never proof', () => {
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] }, e2e: 'skip' });
  const { json } = proof(r);
  assert.strictEqual(json.lanes.ui.proven, false);
  assert.match(json.lanes.ui.why, /skipped \(playwright not found\): a skip is never proof/);
});

test('a prompt or agent .md in the lane makes it live, even when the code beside it is covered', () => {
  for (const md of ['skills/browser-driver/SKILL.md', 'skills/browser-driver/references/x.md']) {
    const r = repo({ base: { [LOGIN]: 'a\n', [md]: 'p\n' }, head: { [LOGIN]: 'b\n', [md]: 'q\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
    const { json } = proof(r);
    assert.strictEqual(json.lanes.ui.proven, false, md);
    assert.match(json.lanes.ui.why, /prompt or agent file changed/);
  }
  const agent = repo({ base: { 'agents/qa-executor.md': 'p\n' }, head: { 'agents/qa-executor.md': 'q\n' }, covers: { [LOGIN_E2E]: ['agents/qa-executor.md'] } });
  assert.strictEqual(Object.values(proof(agent).json.lanes).filter((l) => l.proven).length, 0, 'a covers.json entry cannot turn a prompt into proof');
});

test('the tracker lane is never proven, and a third-party adapter file blocks every lane even if covers.json names it', () => {
  const tracker = 'skills/tracker-ops/scripts/x.js';
  const t = repo({ base: { [tracker]: 'a\n' }, head: { [tracker]: 'b\n' }, covers: { [LOGIN_E2E]: [tracker] } });
  const tj = proof(t).json;
  assert.strictEqual(tj.lanes.tracker.proven, false);
  assert.match(tj.lanes.tracker.why, /tracker lane is never proven/);
  const adapter = 'scripts/lib/tracker/ado.js'; // a FULL-gate file: every lane is selected
  const a = repo({ base: { [adapter]: 'a\n' }, head: { [adapter]: 'b\n' }, covers: { [LOGIN_E2E]: [adapter] } });
  const aj = proof(a).json;
  assert.ok(Object.keys(aj.lanes).length >= 5);
  assert.deepStrictEqual(Object.values(aj.lanes).filter((l) => l.proven), []);
  assert.match(aj.lanes.ui.why, /third-party adapter code changed/);
});

test('a file covers.json does not map makes the lane live', () => {
  const other = 'skills/ui-check/scripts/x.js';
  const r = repo({ base: { [LOGIN]: 'a\n', [other]: 'a\n' }, head: { [LOGIN]: 'b\n', [other]: 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
  const { json } = proof(r);
  assert.strictEqual(json.lanes.ui.proven, false);
  assert.match(json.lanes.ui.why, /skills\/ui-check\/scripts\/x\.js is not in covers\.json/);
});

test('function scope: a hunk inside the named function is proven; one in another function, or between functions, is not', () => {
  const FILE = 'skills/swagger-import/scripts/browser_bridge.js';
  const E2E_BRIDGE = 'skills/swagger-import/scripts/browser_bridge.e2e.test.js';
  const covers = { [E2E_BRIDGE]: [`${FILE}#renew`] };
  const mk = (head) => repo({ base: { [FILE]: FNS('') }, head: { [FILE]: head }, covers, e2eFiles: [E2E_BRIDGE] });
  const inRenew = proof(mk(FNS('/* edited */'))).json;
  assert.strictEqual(inRenew.lanes.api.proven, true, JSON.stringify(inRenew.lanes.api));
  const inOther = proof(mk(FNS('').replace('return 2;', 'return 22;'))).json;
  assert.strictEqual(inOther.lanes.api.proven, false);
  assert.match(inOther.lanes.api.why, /lie outside renew/);
  const between = proof(mk(FNS('').replace('function other()', '// new line between\nfunction other()'))).json;
  assert.strictEqual(between.lanes.api.proven, false, 'an insertion between two functions is outside both');
  const added = proof(mk(FNS('').replace('const tail = 3;', 'const tail = 3;\nconst more = 4;'))).json;
  assert.strictEqual(added.lanes.api.proven, false);
});

test('function scope in an .html: a const and the closing </script> are separate spans; a hunk in the markup is outside', () => {
  const FILE = 'skills/endpoint-testing/scripts/studio/studio.html';
  const E2E_STUDIO = 'skills/endpoint-testing/scripts/studio/studio.e2e.test.js';
  const html = (a, b, c) => `<html><body>${c}\n<script>\nconst t = (k) => ${a};\nfunction renderStep3() {\n  return ${b};\n}\nconst z = 1;\n</script>\n</body></html>\n`;
  const covers = { [E2E_STUDIO]: [`${FILE}#t,renderStep3`] };
  const mk = (head) => repo({ base: { [FILE]: html('k', 'x', 'm') }, head: { [FILE]: head }, covers, e2eFiles: [E2E_STUDIO] });
  assert.strictEqual(proof(mk(html('k + 1', 'x', 'm'))).json.lanes.api.proven, true, 'in const t');
  assert.strictEqual(proof(mk(html('k', 'x + 1', 'm'))).json.lanes.api.proven, true, 'in renderStep3');
  const z = proof(mk(html('k', 'x', 'm').replace('const z = 1;', 'const z = 2;'))).json;
  assert.strictEqual(z.lanes.api.proven, false, 'in const z');
  const markup = proof(mk(html('k', 'x', 'changed'))).json;
  assert.strictEqual(markup.lanes.api.proven, false, 'in the markup above the script');
});

test('a file added at HEAD is covered only by a whole-file entry', () => {
  const FILE = 'skills/swagger-import/scripts/browser_bridge.js';
  const E2E_BRIDGE = 'skills/swagger-import/scripts/browser_bridge.e2e.test.js';
  const scoped = repo({ head: { [FILE]: FNS('') }, covers: { [E2E_BRIDGE]: [`${FILE}#renew`] }, e2eFiles: [E2E_BRIDGE] });
  assert.strictEqual(proof(scoped).json.lanes.api.proven, false);
  const whole = repo({ head: { [FILE]: FNS('') }, covers: { [E2E_BRIDGE]: [FILE] }, e2eFiles: [E2E_BRIDGE] });
  assert.strictEqual(proof(whole).json.lanes.api.proven, true);
});

test('two covering e2e files must both pass: one failing keeps the lane live', () => {
  const A = 'skills/browser-driver/scripts/a.e2e.test.js'; const B = 'skills/browser-driver/scripts/b.e2e.test.js';
  const r = repo({ base: { [LOGIN]: 'a\n' }, head: { [LOGIN]: 'b\n' }, covers: { [A]: [LOGIN], [B]: [LOGIN] }, e2eFiles: [A] });
  // B does not exist at HEAD
  const { json } = proof(r);
  assert.strictEqual(json.lanes.ui.proven, false);
  assert.match(json.lanes.ui.why, /b\.e2e\.test\.js does not exist at HEAD/);
});

test('a docs-only change selects no lane: nothing to prove, exit 0', () => {
  const r = repo({ base: { 'docs/a.md': 'a\n' }, head: { 'docs/a.md': 'b\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
  const { code, json } = proof(r);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(json.lanes, {});
});

test('a change to the e2e files and scripts/dev/e2e alone selects no lane', () => {
  const r = repo({ base: { 'scripts/dev/e2e/x.js': 'a\n', [LOGIN_E2E]: 'process.exit(0);\n' }, head: { 'scripts/dev/e2e/x.js': 'b\n', [LOGIN_E2E]: 'process.exit(0); // edit\n' }, covers: { [LOGIN_E2E]: [LOGIN] } });
  assert.deepStrictEqual(proof(r).json.lanes, {});
});

test('the real covers.json: valid, every e2e file and every covered file exists, scopes name real top-level declarations', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const { parseCovers, spansOf } = require(PROOF);
  const covers = parseCovers(path.join(__dirname, 'covers.json'));
  assert.ok(covers.length >= 4);
  assert.deepStrictEqual([...new Set(covers.map((c) => c.e2e))].length, 4, 'one entry per e2e file');
  for (const c of covers) {
    assert.ok(fs.existsSync(path.join(root, c.e2e)), c.e2e);
    assert.ok(fs.existsSync(path.join(root, c.file)), c.file);
    if (c.fns) { const spans = spansOf(fs.readFileSync(path.join(root, c.file), 'utf8')); for (const f of c.fns) assert.ok(spans.has(f), `${c.file} has no top-level ${f}`); }
    const { NEVER } = require(PROOF);
    const { globToRegExp } = require('../../release-gate/gate-plan.js');
    assert.ok(!NEVER.some((g) => globToRegExp(g).test(c.file)), `${c.file} is a never-proven file`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
