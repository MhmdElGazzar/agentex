'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveSpec, validateBody } = require('./save_spec.js');
const { resolveSpecs } = require('../../agentex-test/scripts/parallel.js');

const root = path.resolve(__dirname, '..', '..', '..');
const valid = `# Spec: Local button flow

Target: http://127.0.0.1:3000

## Acceptance criteria
- The button reveals a success message without console errors or failed requests.

## Scenarios (stateful — run in order, in one session)
1. Open the local fixture; expect the button to be visible.
2. Click the button; expect the success message to appear.

## Notes
- Keep both steps in one session.
`;

function fixture(body = valid) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-flow-'));
  fs.mkdirSync(path.join(cwd, 'test', 'suite1'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.playwright-cli'));
  fs.writeFileSync(path.join(cwd, '.playwright-cli', 'define-flow-draft.md'), body);
  return cwd;
}
function save(cwd, output = 'test/suite1/local-button.md') {
  return saveSpec({ cwd, draft: '.playwright-cli/define-flow-draft.md', output });
}

const cwd = fixture();
assert.equal(save(cwd), 'test/suite1/local-button.md');
assert.deepEqual(resolveSpecs(cwd, { specs: ['test/suite1/local-button.md'] }), ['test/suite1/local-button.md']);
assert.equal(fs.readFileSync(path.join(cwd, 'test', 'suite1', 'local-button.md'), 'utf8'), valid);

assert.throws(() => save(cwd), /EEXIST/);
assert.equal(fs.readFileSync(path.join(cwd, 'test', 'suite1', 'local-button.md'), 'utf8'), valid);
assert.throws(() => save(cwd, '../escaped.md'), /under test/);
assert.throws(() => save(cwd, 'test/suite1/../../escaped.md'), /under test/);
assert.throws(() => save(cwd, 'test/missing/flow.md'), /parent must exist/);

const arabic = valid.replace('Local button flow', 'تدفق الزر').replace('Click the button; expect the success message to appear.', 'اضغط الزر؛ تأكد من ظهور رسالة النجاح.');
const arabicCwd = fixture(arabic);
assert.equal(save(arabicCwd, 'test/suite1/arabic.md'), 'test/suite1/arabic.md');
assert.deepEqual(resolveSpecs(arabicCwd, { specs: ['test/suite1/arabic.md'] }), ['test/suite1/arabic.md']);

assert.ok(validateBody(valid.replace('expect the success message to appear', 'the success message appears')).some(x => x.includes('expected result')));
assert.ok(validateBody(valid.replace('## Acceptance criteria', '## Other')).some(x => x.includes('Acceptance criteria')));
assert.ok(validateBody(valid + '\npassword: supersecret123\n').some(x => x.includes('credential')));
assert.ok(validateBody(valid + '\nC:\\Users\\developer\\private.txt\n').some(x => x.includes('developer-local')));
assert.ok(validateBody(valid + '\nTarget: http://user:pass@localhost:3000\n').some(x => x.includes('credential')));

const adapter = fs.readFileSync(path.join(root, 'skills', 'agentex-define-flow', 'SKILL.md'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'skills', 'define-flow', 'SKILL.md'), 'utf8');
const command = fs.readFileSync(path.join(root, 'commands', 'define-flow.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
assert.equal(manifest.skills, './skills/');
assert.match(adapter, /skills\/define-flow\/SKILL\.md/);
assert.match(adapter, /save_spec\.js/);
assert.match(shared, /STEP LOOP/);
assert.match(shared, /save_spec\.js/);
assert.match(command, /define-flow/);
console.log('define-flow focused tests passed');
