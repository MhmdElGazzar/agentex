'use strict';
// Unit tests for the consumer secret-scan core (pure logic, no I/O).
// Run: node scripts/lib/secret_scan_core.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./secret_scan_core.js');
const { ENV_KEY_MAP } = require('./env_key_map.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const S = 'EVAL_SENTINEL_SCAN_core_1';
const SHORT = '482913';

// ── Needles ──────────────────────────────────────────────────────────────────
test('enumerateEnvKeys: per-line grammar, export/indent tolerant, BOM stripped, comments skipped', () => {
  const text = '﻿FIRST=1\n# COMMENTED=x\n  export SECOND = two\r\nnot a line\nTHIRD=\nFIRST=again\n';
  assert.deepStrictEqual(core.enumerateEnvKeys(text), ['FIRST', 'SECOND', 'THIRD']);
});

test('buildNeedles: an empty KEY= never takes the next line\'s value', () => {
  const n = core.buildNeedles({ envText: `A=\nB=${S}\n`, processEnv: {} });
  assert.deepStrictEqual(n.substring.map(x => x.key), ['B']);
  assert.ok(!n.all.some(x => x.key === 'A'));
});

test('buildNeedles: short values leave substring matching; 4..7 chars are label-checked, < 4 not at all', () => {
  const n = core.buildNeedles({
    envText: `LONG_SECRET=${S}\nDEFAULT_PASSWORD=${SHORT}\nPIN=abc\n`, processEnv: {},
  });
  assert.deepStrictEqual(n.substring.map(x => x.key), ['LONG_SECRET']);
  assert.deepStrictEqual(n.labeled.map(x => x.key), ['DEFAULT_PASSWORD']);
  assert.deepStrictEqual(n.valueCheck.keysChecked, ['LONG_SECRET']);
  assert.deepStrictEqual(n.valueCheck.labelChecked, ['DEFAULT_PASSWORD']);
  assert.deepStrictEqual(n.valueCheck.notChecked.shortValue, ['DEFAULT_PASSWORD', 'PIN']);
  assert.strictEqual(n.valueCheck.status, 'ran');
  // every value — the short ones too — stays available for the exact-equality overlap check
  assert.deepStrictEqual(n.all.map(x => x.key).sort(), ['DEFAULT_PASSWORD', 'LONG_SECRET', 'PIN']);
});

test('buildNeedles: tunable cut-offs (minValueLength, minLabeledValueLength)', () => {
  const n = core.buildNeedles({ envText: 'P=abc\n', processEnv: {}, minLabeledValueLength: 1 });
  assert.deepStrictEqual(n.labeled.map(x => x.key), ['P']);
  const m = core.buildNeedles({ envText: `P=${SHORT}\n`, processEnv: {}, minValueLength: 4 });
  assert.deepStrictEqual(m.substring.map(x => x.key), ['P']);
});

test('buildNeedles: non-secret config keys (ENV_KEY_MAP, ADO fallbacks, JIRA_EMAIL) are named, never needles', () => {
  const n = core.buildNeedles({
    envText: 'QA_URL=https://example.test/app\nAZURE_AREA_PATH=Team\\Area\\Long\nJIRA_EMAIL=qa@example.test\nAPI_TOKEN=' + S + '\n',
    processEnv: {},
  });
  assert.deepStrictEqual(n.substring.map(x => x.key), ['API_TOKEN']);
  assert.deepStrictEqual(n.valueCheck.notChecked.nonSecretKeys, ['AZURE_AREA_PATH', 'JIRA_EMAIL', 'QA_URL']);
});

test('buildNeedles: <NAME>_BASE_URL keys are not needles and are named under notChecked.baseUrlKeys', () => {
  const n = core.buildNeedles({
    envText: `PETSTORE_BASE_URL=https://petstore.example.test/v2\nORDERS_V2_BASE_URL=https://orders.example.test\nAPI_TOKEN=${S}\n`,
    processEnv: {},
  });
  assert.deepStrictEqual(n.substring.map(x => x.key), ['API_TOKEN'], 'the real secret beside them is still a needle');
  assert.ok(!n.all.some(x => /_BASE_URL$/.test(x.key)), 'never in the overlap set either');
  assert.deepStrictEqual(n.valueCheck.notChecked.baseUrlKeys, ['ORDERS_V2_BASE_URL', 'PETSTORE_BASE_URL']);
  assert.deepStrictEqual(n.valueCheck.notChecked.nonSecretKeys, []);
});

test('buildNeedles: KB_ASK_BASE_URL stays a non-secret config key (ENV_KEY_MAP wording), not a base-URL key', () => {
  const n = core.buildNeedles({ envText: 'KB_ASK_BASE_URL=https://kb.example.test\nX_BASE_URL=https://x.example.test\n', processEnv: {} });
  assert.deepStrictEqual(n.valueCheck.notChecked.nonSecretKeys, ['KB_ASK_BASE_URL']);
  assert.deepStrictEqual(n.valueCheck.notChecked.baseUrlKeys, ['X_BASE_URL']);
});

test('buildNeedles: only the exact _BASE_URL suffix on an upper-case name is excluded — no other suffix heuristics', () => {
  const env = ['petstore_base_url', 'PETSTORE_BASE_URL_TOKEN', 'PETSTORE_URL', 'BASE_URL', 'PETSTORE_BASEURL', 'PETSTORE_API_KEY']
    .map((k, i) => `${k}=${S}_${i}`).join('\n');
  const n = core.buildNeedles({ envText: env, processEnv: {} });
  assert.deepStrictEqual(n.valueCheck.notChecked.baseUrlKeys, []);
  assert.deepStrictEqual(n.substring.map(x => x.key).sort(),
    ['BASE_URL', 'PETSTORE_API_KEY', 'PETSTORE_BASEURL', 'PETSTORE_BASE_URL_TOKEN', 'PETSTORE_URL', 'petstore_base_url']);
});

test('scanFile: a base-URL value in a staged environment file is not a finding; a real secret beside it still leaks', () => {
  const n = needles(`PETSTORE_BASE_URL=https://petstore.example.test/v2\nAPI_TOKEN=${S}\n`);
  const env = `{\n  "api": { "baseUrl": "https://petstore.example.test/v2" }\n}\n`;
  assert.deepStrictEqual(core.scanFile({ file: 'environments/qc.json', text: env, needles: n, fieldKind: 'environment', fieldTable: core.secretFieldTable([]) }), []);
  const leak = core.scanFile({ file: 'r.md', text: `url https://petstore.example.test/v2\ntoken ${S}\n`, needles: n });
  assert.deepStrictEqual(leak, [{ severity: 'leak', kind: 'secret-value', file: 'r.md', line: 2, key: 'API_TOKEN' }]);
});

test('buildNeedles: envSecret names and process-environment values count (NU-7)', () => {
  const n = core.buildNeedles({
    envText: null, envSecretNames: ['MY_REF'], processEnv: { MY_REF: S, UNRELATED: 'EVAL_SENTINEL_SCAN_unrelated' },
  });
  assert.deepStrictEqual(n.substring.map(x => x.key), ['MY_REF']);
  assert.ok(!n.all.some(x => x.key === 'UNRELATED'), 'only project secret names are resolved');
  const both = core.buildNeedles({ envText: `K=${S}\n`, processEnv: { K: S + '_shell' } });
  assert.strictEqual(both.substring.length, 2, 'both values when the shell and .env differ');
});

test('buildNeedles: skipped reasons — no-env-file, no-values (keys-only .env), all-excluded', () => {
  assert.deepStrictEqual(core.buildNeedles({ envText: null, processEnv: {} }).valueCheck,
    { status: 'skipped', reason: 'no-env-file', keysChecked: [], labelChecked: [], notChecked: { shortValue: [], nonSecretKeys: [], baseUrlKeys: [] } });
  assert.strictEqual(core.buildNeedles({ envText: 'AZURE_PAT=\nAPI_TOKEN=\n', processEnv: {} }).valueCheck.reason, 'no-values');
  assert.strictEqual(core.buildNeedles({ envText: 'QA_URL=https://example.test\nPIN=1\n', processEnv: {} }).valueCheck.reason, 'all-excluded');
  assert.strictEqual(core.buildNeedles({ envText: 'PETSTORE_BASE_URL=https://petstore.example.test\n', processEnv: {} }).valueCheck.reason, 'all-excluded');
});

test('canonicalSecretNames: active keys of the plugin .env.example plus the PAT names', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const names = core.canonicalSecretNames(example);
  for (const k of ['AZURE_PAT', 'API_TOKEN', 'SQLCMDPASSWORD', 'FIGMA_TOKEN', 'AZURE_DEVOPS_EXT_PAT']) assert.ok(names.includes(k), k);
  assert.ok(!names.includes('AZURE_URL'), 'commented maintainer keys are not active keys');
});

test('NON_SECRET_ENV_KEYS drift pin: ENV_KEY_MAP keys + every AZURE_* fallback ado.js picks', () => {
  for (const k of Object.keys(ENV_KEY_MAP)) assert.ok(core.NON_SECRET_ENV_KEYS.includes(k), k);
  const ado = fs.readFileSync(path.join(__dirname, 'tracker', 'adapters', 'ado.js'), 'utf8');
  const picked = [...ado.matchAll(/pick\(cwd, az, '[^']+', '(AZURE_[A-Z_]+)'\)/g)].map(m => m[1]);
  assert.ok(picked.length >= 10, 'parsed the pick() calls');
  for (const k of picked) assert.ok(core.NON_SECRET_ENV_KEYS.includes(k), k);
  assert.ok(core.NON_SECRET_ENV_KEYS.includes('JIRA_EMAIL'));
  for (const k of ['AZURE_PAT', 'API_TOKEN', 'JIRA_API_TOKEN']) assert.ok(!core.NON_SECRET_ENV_KEYS.includes(k), k);
});

test('collectEnvSecretNames import resolves (from ci_preflight.js, no side effects)', () => {
  const names = core.collectEnvSecretNames({ a: { envSecret: 'X1' }, b: [{ c: { envSecret: 'X2' } }] });
  assert.deepStrictEqual([...names].sort(), ['X1', 'X2']);
});

// ── Label word rule (RD-7) ───────────────────────────────────────────────────
test('label word rule: table', () => {
  const yes = { password: 'password', DBPASSWORD: 'password', passwordConfirm: 'password', password_confirm: 'password',
    defaultPassword: 'password', userPass: 'pass', db_pwd: 'pwd', Passcode: 'passcode', PASS: 'pass', 'user-pass': 'pass',
    'db.pwd': 'pwd', DBPwd: 'pwd', 'Default Password': 'password' };
  for (const [id, label] of Object.entries(yes)) assert.strictEqual(core.labelOf(id), label, id);
  for (const id of ['passport', 'bypass', 'compass', 'pwdx', 'passing', 'username', 'otp', '']) {
    assert.strictEqual(core.labelOf(id), null, id);
  }
});

test('label word rule: Arabic phrases, with and without a qualifier, through RLM/NBSP/ZWNJ/tatweel', () => {
  assert.strictEqual(core.labelOf('كلمة المرور'), 'ar-password');
  assert.strictEqual(core.labelOf('كلمة السر'), 'ar-secret-word');
  assert.strictEqual(core.labelOf('كلمة المرور الافتراضية'), 'ar-password');
  assert.strictEqual(core.labelOf('كلمـة المـرور'), 'ar-password');
  assert.strictEqual(core.labelOf('‏كلمة‌المرور‏'), 'ar-password');
  assert.strictEqual(core.labelOf('كلمة'), null);
  assert.strictEqual(core.labelOf('اسم المستخدم'), null);
});

test('text label context: the left context must end in <label><filler>[:=]<filler>', () => {
  const cases = {
    'password: ': 'password', 'Password = "': 'password', '**Pwd:** `': 'pwd', 'PASS=': 'pass',
    "db_pwd: '": 'pwd', 'passcode:': 'passcode', 'DEFAULT_PASSWORD=': 'password',
    'login with password: ': 'password', '| password = ': 'password',
    'كلمة المرور: ': 'ar-password', 'كلمة السر = ': 'ar-secret-word',
    'كلمـة المرور الافتراضية: ‏': 'ar-password',
  };
  for (const [prefix, label] of Object.entries(cases)) assert.strictEqual(core.labelBeforeValue(prefix), label, JSON.stringify(prefix));
  for (const prefix of ['passport: ', 'bypass: ', 'password ', 'password: x', 'phone: ', 'password:1', '']) {
    assert.strictEqual(core.labelBeforeValue(prefix), null, JSON.stringify(prefix));
  }
});

test('right boundary: letters and digits (Arabic-Indic included) block, punctuation and line end do not', () => {
  assert.strictEqual(core.rightBoundaryOk('482913', 6), true);
  assert.strictEqual(core.rightBoundaryOk('482913.', 6), true);
  assert.strictEqual(core.rightBoundaryOk('482913‏', 6), true);
  assert.strictEqual(core.rightBoundaryOk('4829130', 6), false);
  assert.strictEqual(core.rightBoundaryOk('482913a', 6), false);
  assert.strictEqual(core.rightBoundaryOk('482913٣', 6), false);
  assert.strictEqual(core.rightBoundaryOk('482913ب', 6), false);
});

// ── JSON walker (S12/S17) ────────────────────────────────────────────────────
test('JSON walker: line attribution with repeated keys, number raw text, BOM', () => {
  const text = '﻿{\n  "a": { "password": "x" },\n  "b": {\n    "password": 482913\n  },\n  "arr": [ { "key": "pwd", "default": "y" } ]\n}\n';
  const root = core.parseJson(text);
  const seen = [];
  core.walkValues(root, (node, segs) => seen.push([core.formatPath(segs), node.type, node.line, node.raw]));
  assert.deepStrictEqual(seen.find(s => s[0] === 'a.password'), ['a.password', 'string', 2, '"x"']);
  assert.deepStrictEqual(seen.find(s => s[0] === 'b.password'), ['b.password', 'number', 4, '482913']);
  assert.deepStrictEqual(seen.find(s => s[0] === 'arr[0].default'), ['arr[0].default', 'string', 6, '"y"']);
});

test('JSON walker: objects expose key tokens with lines and sibling key/name/id values', () => {
  const root = core.parseJson('{\n "defaultsFields": [\n  { "key": "password",\n    "default": "z" }\n ]\n}');
  const objs = [];
  core.walkObjects(root, (obj, segs) => objs.push({ path: core.formatPath(segs), keys: obj.entries.map(e => [e.key, e.keyLine]) }));
  assert.deepStrictEqual(objs[1], { path: 'defaultsFields[0]', keys: [['key', 3], ['default', 4]] });
});

test('JSON walker: invalid JSON throws a fixed error that never quotes the input', () => {
  try { core.parseJson(`{"a": ${S}}`); assert.fail('should throw'); }
  catch (e) { assert.strictEqual(e.code, 'invalid-json'); assert.ok(!e.message.includes(S)); }
});

// ── Field table ──────────────────────────────────────────────────────────────
test('field table: db.password, api.token, defaults.password always (A-2), secret descriptors', () => {
  const t = core.secretFieldTable([{
    userFields: [{ key: 'phone' }, { key: 'pin', secret: true }],
    defaultsFields: [{ key: 'password' }, { key: 'otp' }, { key: 'apiKey', secret: true }],
  }]);
  const f = (segs) => core.environmentSecretField(t, segs);
  assert.deepStrictEqual(f(['db', 'password']), { field: 'db.password', suggest: { envSecret: 'SQLCMDPASSWORD' } });
  assert.deepStrictEqual(f(['api', 'token']), { field: 'api.token', suggest: { envSecret: 'API_TOKEN' } });
  assert.deepStrictEqual(f(['defaults', 'password']), { field: 'defaults.password', suggest: { envSecret: 'DEFAULT_PASSWORD' } });
  assert.deepStrictEqual(f(['defaults', 'apiKey']), { field: 'defaults.apiKey', suggest: { envSecret: 'DEFAULT_APIKEY' } });
  assert.deepStrictEqual(f(['users', 'valid_user', 'pin']), { field: 'users.valid_user.pin', suggest: { envSecret: 'VALID_USER_PIN' } });
  assert.strictEqual(f(['defaults', 'otp']), null);
  assert.strictEqual(f(['users', 'valid_user', 'phone']), null);
  assert.ok(core.secretFieldTable([]).defaultsKeys.has('password'), 'defaults.password with no schema at all');
});

// ── Remote URL credentials (NU-3 a) ──────────────────────────────────────────
test('remote credential: password part, or a username equal to a known value; never ssh/scp', () => {
  const known = new Set([S]);
  const c = (u) => core.remoteHasCredential(u, known);
  assert.strictEqual(c('https://user:tok%40en@example.test/r.git'), true);
  assert.strictEqual(c('HTTPS://user:x@example.test/r.git'), true);
  assert.strictEqual(c(`https://${S}@example.test/r.git`), true);
  assert.strictEqual(c(`https://${encodeURIComponent(S)}@example.test/r.git`), true);
  assert.strictEqual(c('https://orgname@example.test/r.git'), false, 'username-only is not flagged');
  assert.strictEqual(c('https://user:@example.test/r.git'), false, 'empty password');
  assert.strictEqual(c('https://example.test/path/a@b/r.git'), false, 'an @ in the path is not userinfo');
  assert.strictEqual(c('https://a@b:pw@example.test/r.git'), true, 'userinfo is everything before the last @');
  assert.strictEqual(c('git@example.test:team/r.git'), false);
  assert.strictEqual(c('ssh://user:pw@example.test/r.git'), false);
  assert.strictEqual(c('https://user:%ZZ@example.test/r.git'), true, 'bad percent-encoding still has a password part');
});

// ── Binary sniff ─────────────────────────────────────────────────────────────
test('binary: a NUL within the sniff window', () => {
  assert.strictEqual(core.isBinary(Buffer.from('plain text\n')), false);
  assert.strictEqual(core.isBinary(Buffer.from([65, 0, 66])), true);
  const late = Buffer.alloc(9000, 65); late[8500] = 0;
  assert.strictEqual(core.isBinary(late), false, 'NUL past the window');
  assert.strictEqual(core.isBinary(late, 9000), true, 'tunable window');
});

// ── scanFile: the matchers end to end (pure) ─────────────────────────────────
function needles(env) { return core.buildNeedles({ envText: env, processEnv: {} }); }

test('scanFile: secret-value with line numbers; short values never substring-matched', () => {
  const n = needles(`TOKEN=${S}\nDEFAULT_PASSWORD=${SHORT}\n`);
  const f = core.scanFile({ file: 'a.md', text: `one\ntwo ${S}\nphone 0555${SHORT}\n`, needles: n });
  assert.deepStrictEqual(f, [{ severity: 'leak', kind: 'secret-value', file: 'a.md', line: 2, key: 'TOKEN' }]);
});

test('scanFile: phone/IBAN/VAT/order-id shaped text never matches a short value', () => {
  const n = needles(`DEFAULT_PASSWORD=${SHORT}\n`);
  const text = [`phone: 0555${SHORT}`, `iban: XX0380000000608010${SHORT}`, `VAT 300${SHORT}000003`,
    `+00 5${SHORT} 01`, `ORD-${SHORT}5`, `password: 4829130`, 'password: 777111', `passport: ${SHORT}`, `bypass: ${SHORT}`].join('\n');
  assert.deepStrictEqual(core.scanFile({ file: 'n.md', text, needles: n }), []);
});

test('scanFile: rule (a) positives carry line, label and key — never the value', () => {
  const n = needles(`DEFAULT_PASSWORD=${SHORT}\n`);
  const lines = [`password: ${SHORT}`, `Password = "${SHORT}"`, `**Pwd:** \`${SHORT}\``, `PASS=${SHORT}`,
    `db_pwd: '${SHORT}'`, `passcode:${SHORT}.`, `DEFAULT_PASSWORD=${SHORT}`,
    `كلمة المرور: ${SHORT}`, `كلمة السر = ${SHORT}`, `كلمـة المرور الافتراضية: ‏${SHORT}‏`];
  const f = core.scanFile({ file: 's.md', text: lines.join('\n'), needles: n });
  assert.deepStrictEqual(f.map(x => [x.line, x.label]), [[1, 'password'], [2, 'password'], [3, 'pwd'], [4, 'pass'],
    [5, 'pwd'], [6, 'passcode'], [7, 'password'], [8, 'ar-password'], [9, 'ar-secret-word'], [10, 'ar-password']]);
  for (const x of f) {
    assert.deepStrictEqual(Object.keys(x).sort(), ['file', 'key', 'kind', 'label', 'line', 'severity']);
    assert.strictEqual(x.kind, 'short-value-labeled'); assert.strictEqual(x.key, 'DEFAULT_PASSWORD');
  }
});

test('scanFile: rule (b) JSON — sibling key/name/id with default/value, label in the key, number tokens', () => {
  const n = needles(`DEFAULT_PASSWORD=${SHORT}\n`);
  const cfg = `{\n  "defaultsFields": [\n    { "key": "password",\n      "default": "${SHORT}" }\n  ]\n}\n`;
  assert.deepStrictEqual(core.scanFile({ file: 'config/project.json', text: cfg, needles: n }), [{
    severity: 'leak', kind: 'short-value-labeled', file: 'config/project.json', line: 4,
    key: 'DEFAULT_PASSWORD', label: 'password', field: 'defaultsFields[0].default' }]);
  const num = `{\n  "defaults": {\n    "password":\n      ${SHORT}\n  }\n}\n`;
  const r = core.scanFile({ file: 'x/other.json', text: num, needles: n });
  assert.deepStrictEqual(r.map(x => [x.line, x.field, x.label]), [[4, 'defaults.password', 'password']]);
  const cat = `{"requests":[{"body":{"fields":[{"name":"pwd",\n"value":"${SHORT}"}]}}]}`;
  assert.deepStrictEqual(core.scanFile({ file: 'integration/a_api.json', text: cat, needles: n }).map(x => [x.line, x.field, x.label]),
    [[2, 'requests[0].body.fields[0].value', 'pwd']]);
});

test('scanFile: plain-secret-field warns with field + suggestion; overlap with a known value is a leak instead', () => {
  const n = needles(`OTHER=${S}\nDEFAULT_PASSWORD=${SHORT}\n`);
  const env = `{\n  "defaults": { "password": "Plain@Text1" },\n  "db": { "password": "${S}" },\n  "api": { "token": { "envSecret": "API_TOKEN" } }\n}\n`;
  const f = core.scanFile({ file: 'environments/uat.json', text: env, needles: n, fieldKind: 'environment', fieldTable: core.secretFieldTable([]) });
  assert.deepStrictEqual(f, [
    { severity: 'leak', kind: 'secret-value', file: 'environments/uat.json', line: 3, key: 'OTHER', field: 'db.password' },
    { severity: 'warn', kind: 'plain-secret-field', file: 'environments/uat.json', line: 2, field: 'defaults.password', suggest: { envSecret: 'DEFAULT_PASSWORD' } },
  ]);
});

test('scanFile: dedupe — a plain defaults.password equal to a short known value is exactly one secret-value finding', () => {
  const n = needles(`DEFAULT_PASSWORD=${SHORT}\n`);
  const env = `{\n  "defaults": { "password": "${SHORT}" }\n}\n`;
  const f = core.scanFile({ file: 'environments/qc.json', text: env, needles: n, fieldKind: 'environment', fieldTable: core.secretFieldTable([]) });
  assert.deepStrictEqual(f, [{ severity: 'leak', kind: 'secret-value', file: 'environments/qc.json', line: 2, key: 'DEFAULT_PASSWORD', field: 'defaults.password' }]);
});

test('scanFile: catalog *Env field holding a non-name warns (NU-4 a); a name is fine', () => {
  const n = needles(null);
  const cat = '{\n  "auth": { "type": "bearer", "tokenEnv": "abc def-123" },\n  "connection": { "userEnv": "DB_USER" }\n}\n';
  assert.deepStrictEqual(core.scanFile({ file: 'integration/x_api.json', text: cat, needles: n, fieldKind: 'catalog' }), [
    { severity: 'warn', kind: 'plain-secret-field', file: 'integration/x_api.json', line: 2, field: 'auth.tokenEnv', suggest: { tokenEnv: 'TOKEN' } },
  ]);
});

test('scanFile: an unparseable env file warns, is still value-scanned, and its parse error is never surfaced', () => {
  const n = needles(`T=${S}\n`);
  const f = core.scanFile({ file: 'environments/bad.json', text: `{ "x": ${S} `, needles: n, fieldKind: 'environment', fieldTable: core.secretFieldTable([]) });
  assert.deepStrictEqual(f.map(x => x.kind).sort(), ['secret-value', 'unparseable-config']);
  assert.ok(!JSON.stringify(f).includes(S));
});

test('buildResult: CLEAN/WARN/LEAK, exit codes, findings cap with exact counts', () => {
  const vc = { status: 'ran', keysChecked: [], labelChecked: [], notChecked: { shortValue: [], nonSecretKeys: [] } };
  const counts = { filesConsidered: 0, filesScanned: 0, skipped: { binary: 0, oversize: 0, symlink: 0, submodule: 0 } };
  assert.strictEqual(core.buildResult({ mode: 'staged', valueCheck: vc, counts, findings: [] }).result, 'CLEAN');
  const warn = core.buildResult({ mode: 'staged', valueCheck: vc, counts, findings: [{ severity: 'warn' }] });
  assert.deepStrictEqual([warn.result, warn.exit], ['WARN', 0]);
  const many = Array.from({ length: 5 }, () => ({ severity: 'leak' }));
  const leak = core.buildResult({ mode: 'tracked', valueCheck: vc, counts, findings: many, maxFindings: 2 });
  assert.deepStrictEqual([leak.result, leak.exit, leak.counts.leaks, leak.findings.length, leak.findingsTruncated], ['LEAK', 1, 5, 2, 3]);
  assert.deepStrictEqual(Object.keys(leak).slice(0, 5), ['tool', 'schemaVersion', 'mode', 'result', 'exit']);
});

// ── Credential shapes ────────────────────────────────────────────────────────
// Planted credentials are built at runtime from parts, so no real-looking token is
// ever committed to this repository. Each body is a fixed, obviously fake filler.
const FILL = 'EvalShapeSentinel0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const body = (n, chars = FILL) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
const PK = (kind) => ['-----BEG', 'IN ', kind, 'PRIV', 'ATE KEY-----'].join('');
// An armored PGP key reads "BEGIN PGP PRIVATE KEY BLOCK", not "BEGIN PGP PRIVATE KEY".
const PGP = ['-----BEG', 'IN PGP ', 'PRIV', 'ATE KEY BLOCK-----'].join('');
const PLANTED = {
  'private-key-block': [PK(''), PK('RSA '), PK('EC '), PK('OPENSSH '), PK('DSA '), PGP, PK('ENCRYPTED ')],
  'github-token': ['p', 'o', 'u', 's', 'r'].map(c => ['gh', c, '_', body(36)].join(''))
    .concat([['github', '_pat_', body(60, FILL + '_')].join(''), ['gh', 'p_', body(52)].join('')]),
  'aws-access-key-id': [['AK', 'IA', body(16, 'EVALSHAPE0123456789')].join(''), ['AS', 'IA', body(16, 'Z9Y8X7W6V5')].join('')],
  'atlassian-api-token': [['ATA', 'TT3', body(30, FILL + '_-=')].join(''), ['ATA', 'TT3', body(180)].join('')],
  'figma-token': [['fi', 'gd_', body(30, FILL + '-_')].join(''), ['fi', 'gd_', body(41)].join('')],
};
const ALL_PLANTED = Object.values(PLANTED).flat();

test('SHAPE_PATTERNS: exactly the five published-prefix labels of the first slice (invariant #7)', () => {
  assert.deepStrictEqual(core.SHAPE_PATTERNS.map(p => p.label),
    ['private-key-block', 'github-token', 'aws-access-key-id', 'atlassian-api-token', 'figma-token']);
  assert.ok(Object.isFrozen(core.SHAPE_PATTERNS));
});

test('scanShapes: every planted credential is found with its line and label, never its text', () => {
  for (const [label, list] of Object.entries(PLANTED)) {
    for (const tok of list) {
      const text = `# notes\n\nuse it: Bearer ${tok} here\n`;
      const got = core.scanShapes(text);
      assert.deepStrictEqual(got, [{ line: 3, pattern: label }], `${label} #${list.indexOf(tok)}`);
      assert.ok(!JSON.stringify(got).includes(tok));
    }
  }
});

test('scanShapes: tokens in quotes, JSON, URLs, after = and at the edges of the text are found', () => {
  const gh = PLANTED['github-token'][0];
  const aws = PLANTED['aws-access-key-id'][0];
  const fig = PLANTED['figma-token'][0];
  assert.deepStrictEqual(core.scanShapes(gh), [{ line: 1, pattern: 'github-token' }]);
  assert.deepStrictEqual(core.scanShapes(`{ "token": "${gh}" }`), [{ line: 1, pattern: 'github-token' }]);
  assert.deepStrictEqual(core.scanShapes(`x\nAWS_ACCESS_KEY_ID=${aws}`), [{ line: 2, pattern: 'aws-access-key-id' }]);
  assert.deepStrictEqual(core.scanShapes(`see https://example.test/?t=${fig}&a=1`), [{ line: 1, pattern: 'figma-token' }]);
  assert.deepStrictEqual(core.scanShapes(`\`${gh}\`\r\n`), [{ line: 1, pattern: 'github-token' }]);
});

test('scanShapes: one finding per line and label; two labels on a line are two findings, sorted by line then label', () => {
  const gh = PLANTED['github-token'][0];
  const aws = PLANTED['aws-access-key-id'][0];
  const text = `a ${gh} b ${gh}\n${aws} ${gh}\nclean\n${PK('')}\n`;
  assert.deepStrictEqual(core.scanShapes(text), [
    { line: 1, pattern: 'github-token' },
    { line: 2, pattern: 'aws-access-key-id' }, { line: 2, pattern: 'github-token' },
    { line: 4, pattern: 'private-key-block' },
  ]);
});

test('scanShapes negatives: near misses, word boundaries, other PEM blocks and prose about tokens', () => {
  const near = [
    ['gh', 'p_', body(35)].join(''),                       // one character short
    ['xgh', 'p_', body(36)].join(''),                      // no left word boundary
    ['gh', 'x_', body(36)].join(''),                       // not a published GitHub prefix
    ['github', '_pat_', body(59)].join(''),                // fine-grained, one short
    ['AK', 'IA', body(15, 'EVALSHAPE0123456789')].join(''),  // 15 after the prefix
    ['AK', 'IA', body(17, 'EVALSHAPE0123456789')].join(''),  // 17: no right boundary
    ['ak', 'ia', body(16, 'evalshape0123456789')].join(''),  // lower case
    ['AK', 'IA', body(16, 'evalshape0123456789')].join(''),  // lower-case body
    ['ATA', 'TT3', body(29)].join(''),
    ['fi', 'gd_', body(29)].join(''),
    ['zfi', 'gd_', body(30)].join(''),
    ['-----BEG', 'IN PUBLIC KEY-----'].join(''),
    ['-----BEG', 'IN CERTIFICATE-----'].join(''),
    ['-----BEG', 'IN OPENSSH PUBLIC KEY-----'].join(''),
    'Paste your GitHub token (it starts with gh' + 'p_) into .env as GITHUB_TOKEN.',
    'A Figma token starts with fi' + 'gd_ and an Atlassian API token with ATA' + 'TT3.',
  ];
  for (const s of near) assert.deepStrictEqual(core.scanShapes(`${s}\n`), [], s.slice(0, 12));
  // the pattern sources themselves (as they would sit in this plugin's code or docs)
  for (const p of core.SHAPE_PATTERNS) assert.deepStrictEqual(core.scanShapes(p.re.source), [], p.label);
});

test('scanShapes: stateless across calls (global regexes reset)', () => {
  const gh = PLANTED['github-token'][0];
  for (let k = 0; k < 3; k++) assert.deepStrictEqual(core.scanShapes(`${gh}\n`), [{ line: 1, pattern: 'github-token' }]);
  assert.deepStrictEqual(core.scanShapes(''), []);
});

test('scanFile: credential-shape warnings with file, line, pattern — with or without .env needles', () => {
  const gh = PLANTED['github-token'][0];
  const text = `# spec\nheader: Authorization: token ${gh}\n${PK('OPENSSH ')}\n`;
  for (const env of [null, `API_TOKEN=${S}\n`]) {
    const f = core.scanFile({ file: 'test/suite1/api.md', text, needles: needles(env) });
    assert.deepStrictEqual(f, [
      { severity: 'warn', kind: 'credential-shape', file: 'test/suite1/api.md', line: 2, pattern: 'github-token' },
      { severity: 'warn', kind: 'credential-shape', file: 'test/suite1/api.md', line: 3, pattern: 'private-key-block' },
    ]);
    assert.ok(!JSON.stringify(f).includes(gh));
  }
});

test('scanFile: a known .env value that also has a token shape → the leak stays, the shape warning is added', () => {
  const gh = PLANTED['github-token'][1];
  const f = core.scanFile({ file: 'n.md', text: `x\n${gh}\n`, needles: needles(`GITHUB_TOKEN=${gh}\n`) });
  assert.deepStrictEqual(f.map(x => [x.severity, x.kind, x.line]), [['leak', 'secret-value', 2], ['warn', 'credential-shape', 2]]);
});

test('remoteShapes: a token-shaped userinfo part → its labels; clean, ssh and scp URLs → none', () => {
  const gh = PLANTED['github-token'][0];
  const at = PLANTED['atlassian-api-token'][0];
  assert.deepStrictEqual(core.remoteShapes(`https://${gh}@git.example.test/r.git`), ['github-token']);
  assert.deepStrictEqual(core.remoteShapes(`https://x-access-token:${gh}@git.example.test/r.git`), ['github-token']);
  assert.deepStrictEqual(core.remoteShapes(`https://qa%40example.test:${encodeURIComponent(at)}@jira.example.test/x`), ['atlassian-api-token']);
  assert.deepStrictEqual(core.remoteShapes(`https://${gh}:${at}@h.example.test/`), ['atlassian-api-token', 'github-token']);
  assert.deepStrictEqual(core.remoteShapes('https://git.example.test/team/repo.git'), []);
  assert.deepStrictEqual(core.remoteShapes('https://myorg@git.example.test/team/repo.git'), []);
  assert.deepStrictEqual(core.remoteShapes(`https://git.example.test/${gh}/repo.git`), [], 'path, not userinfo');
  assert.deepStrictEqual(core.remoteShapes(`ssh://git@git.example.test/r.git`), []);
  assert.deepStrictEqual(core.remoteShapes('git@git.example.test:team/repo.git'), []);
  assert.deepStrictEqual(core.remoteShapes(undefined), []);
});

test('shape confirmation: asked only in hook mode, only when every problem is a warning and one is a shape', () => {
  const shape = { severity: 'warn', kind: 'credential-shape', file: 'a.md', line: 1, pattern: 'github-token' };
  const plain = { severity: 'warn', kind: 'plain-secret-field', file: 'e.json', line: 2, field: 'api.token', suggest: {} };
  const leak = { severity: 'leak', kind: 'secret-value', file: 'a.md', line: 3, key: 'K' };
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: true, findings: [shape] }), true);
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: true, findings: [plain, shape] }), true);
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: false, findings: [shape] }), false);
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: true, findings: [plain] }), false);
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: true, findings: [leak, shape] }), false, 'a leak refuses anyway');
  assert.strictEqual(core.shapeConfirmationNeeded({ hook: true, findings: [] }), false);
});

test('shape confirmation: only y / yes (any case, surrounding space) continues; everything else is the default No', () => {
  for (const a of ['y', 'Y', 'yes', 'YES', ' y \r\n', 'yes\nno\n']) assert.strictEqual(core.confirmAnswerIsYes(a), true, JSON.stringify(a));
  for (const a of ['', '\n', 'n', 'no', 'N', 'yep', 'ye s', 'sure', null, undefined]) assert.strictEqual(core.confirmAnswerIsYes(a), false, JSON.stringify(a));
});

test('declinedResult: the installed hook\'s refusal contract — exit 1, "result":"LEAK", reason declined, warnings kept', () => {
  const vc = { status: 'skipped', reason: 'no-env-file', keysChecked: [], labelChecked: [], notChecked: { shortValue: [], nonSecretKeys: [], baseUrlKeys: [] } };
  const counts = { filesConsidered: 1, filesScanned: 1, skipped: { binary: 0, oversize: 0, symlink: 0, submodule: 0 } };
  const shape = { severity: 'warn', kind: 'credential-shape', file: 'a.md', line: 1, pattern: 'github-token' };
  const warn = core.buildResult({ mode: 'staged', valueCheck: vc, counts, findings: [shape] });
  const d = core.declinedResult(warn);
  assert.deepStrictEqual([d.result, d.exit, d.reason], ['LEAK', 1, 'declined']);
  assert.deepStrictEqual(Object.keys(d).slice(0, 6), ['tool', 'schemaVersion', 'mode', 'result', 'exit', 'reason']);
  assert.deepStrictEqual(d.findings, [shape]);
  assert.deepStrictEqual(d.counts, warn.counts, 'counts stay true: zero leaks, the warnings');
  assert.ok(JSON.stringify(d).includes('"result":"LEAK"'), 'the marker the installed hook greps for');
  assert.strictEqual(warn.result, 'WARN', 'the input is not mutated');
});

test('sentinel: no planted credential appears in any core output', () => {
  const text = ALL_PLANTED.join('\n');
  const out = JSON.stringify([core.scanShapes(text), core.scanFile({ file: 'x.md', text, needles: needles(null) }),
    ALL_PLANTED.map(t => core.remoteShapes(`https://${encodeURIComponent(t)}@h.example.test/`))]);
  for (const t of ALL_PLANTED) assert.ok(!out.includes(t), t.slice(0, 6));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
